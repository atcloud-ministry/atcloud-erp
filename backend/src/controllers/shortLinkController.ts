import { Request, Response } from "express";
import ShortLinkService from "../services/ShortLinkService";
import { createLogger } from "../services/LoggerService";
import { ShortLinkMetricsService } from "../services/ShortLinkMetricsService";
import {
  shortLinkCreatedCounter,
  shortLinkResolveCounter,
  shortLinkResolveDuration,
  shortLinkCreateFailureCounter,
} from "../services/PrometheusMetricsService";

const log = createLogger("ShortLinkController");

export class ShortLinkController {
  /** POST /api/public/short-links
   * Body: { eventId: string, customKey? }
   * Auth optional: if a user is authenticated we record createdBy; otherwise we
   * attribute to a sentinel ANON user id (not persisted as a real user) so that
   * public viewers can still generate share links for published events.
   * Returns existing active link (200) or newly created (201).
   */
  static async create(req: Request, res: Response): Promise<void> {
    try {
      // Allow anonymous: fallback to sentinel user id for attribution.
      const { eventId, customKey } = (req.body || {}) as {
        eventId?: string;
        customKey?: string;
      };
      if (!eventId || typeof eventId !== "string") {
        try {
          shortLinkCreateFailureCounter.inc({ reason: "validation" });
        } catch {}
        res
          .status(400)
          .json({ success: false, message: "eventId is required" });
        return;
      }
      const userLike = req.user as unknown as { id?: string; _id?: string };
      const userId =
        (userLike && (userLike.id || userLike._id)) ||
        "000000000000000000000000"; // 24-char sentinel ObjectId
      const result = await ShortLinkService.getOrCreateForEvent(
        eventId,
        userId,
        customKey,
      );

      // Generate full URL for short links
      const shortPath = `/s/${result.shortLink.key}`;
      const frontendShortPath = `/#${shortPath}`;
      let fullUrl: string;

      if (process.env.PUBLIC_SHORT_BASE_URL) {
        // Explicit short-link base URL from environment, usually a backend/edge route that serves /s/:key.
        fullUrl = `${process.env.PUBLIC_SHORT_BASE_URL.replace(
          /\/$/,
          "",
        )}${shortPath}`;
      } else if (process.env.FRONTEND_URL) {
        // HashRouter deployments need the route in the fragment when the link opens on the frontend host.
        fullUrl = `${process.env.FRONTEND_URL.replace(
          /\/$/,
          "",
        )}${frontendShortPath}`;
      } else {
        // Auto-detect base URL from request context (development)
        const protocol =
          req.get("x-forwarded-proto") || (req.secure ? "https" : "http");
        const host = req.get("host") || "localhost:5001";

        // For development, prefer frontend URL over backend URL for better UX
        if (process.env.NODE_ENV !== "production") {
          const frontendUrl =
            process.env.FRONTEND_URL ||
            `${protocol}://${host.replace(/:\d+$/, ":5173")}`;
          fullUrl = `${frontendUrl.replace(/\/$/, "")}${frontendShortPath}`;
        } else {
          fullUrl = `${protocol}://${host}${shortPath}`;
        }
      }
      if (result.created) {
        ShortLinkMetricsService.increment("created");
        try {
          shortLinkCreatedCounter.inc();
        } catch {}
      }
      res.status(result.created ? 201 : 200).json({
        success: true,
        created: result.created,
        data: {
          key: result.shortLink.key,
          eventId: result.shortLink.eventId,
          slug: result.shortLink.targetSlug,
          expiresAt: result.shortLink.expiresAt,
          url: fullUrl,
        },
      });
    } catch (err) {
      const error = err as Error & { message?: string };
      interface BodyWithEventId {
        eventId?: string;
      }
      const body = req.body as unknown as BodyWithEventId | undefined;
      const userLike = req.user as unknown as
        | { id?: string; _id?: string }
        | undefined;
      log.error("Failed to create short link", error, undefined, {
        eventId: body?.eventId,
        userId: userLike?.id || userLike?._id,
      });
      const msg =
        typeof error?.message === "string"
          ? error.message
          : "Failed to create short link";
      if (/not found/i.test(msg)) {
        try {
          shortLinkCreateFailureCounter.inc({ reason: "not_found" });
        } catch {}
        res.status(404).json({ success: false, message: msg });
        return;
      }
      if (/Custom key invalid/i.test(msg)) {
        try {
          shortLinkCreateFailureCounter.inc({ reason: "custom_invalid" });
        } catch {}
        res
          .status(400)
          .json({ success: false, code: "CUSTOM_KEY_INVALID", message: msg });
        return;
      }
      if (/Custom key reserved/i.test(msg)) {
        try {
          shortLinkCreateFailureCounter.inc({ reason: "custom_reserved" });
        } catch {}
        res
          .status(400)
          .json({ success: false, code: "CUSTOM_KEY_RESERVED", message: msg });
        return;
      }
      if (/Custom key taken/i.test(msg)) {
        try {
          shortLinkCreateFailureCounter.inc({ reason: "custom_taken" });
        } catch {}
        res
          .status(409)
          .json({ success: false, code: "CUSTOM_KEY_TAKEN", message: msg });
        return;
      }
      if (/not published|no public roles|Invalid eventId/i.test(msg)) {
        try {
          shortLinkCreateFailureCounter.inc({ reason: "validation" });
        } catch {}
        res.status(400).json({ success: false, message: msg });
        return;
      }
      try {
        shortLinkCreateFailureCounter.inc({ reason: "other" });
      } catch {}
      res
        .status(500)
        .json({ success: false, message: "Failed to create short link" });
    }
  }

  /** GET /api/public/short-links/:key — status lookup (JSON) */
  static async resolve(req: Request, res: Response): Promise<void> {
    try {
      const { key } = req.params;
      if (!key) {
        res.status(400).json({ success: false, message: "Missing key" });
        return;
      }
      const endTimer = shortLinkResolveDuration.startTimer();
      const result = await ShortLinkService.resolveKey(key);
      if (result.status === "active") {
        ShortLinkMetricsService.increment("resolved_active");
        try {
          shortLinkResolveCounter.inc({ status: "active" });
          endTimer({ status: "active" });
        } catch {}
        res.status(200).json({
          success: true,
          data: {
            status: "active",
            slug: result.slug,
            eventId: result.eventId,
          },
        });
        return;
      }
      ShortLinkMetricsService.increment("resolved_not_found");
      try {
        shortLinkResolveCounter.inc({ status: "not_found" });
        endTimer({ status: "not_found" });
      } catch {}
      res.status(404).json({
        success: false,
        status: "not_found",
        message: "Short link not found",
      });
    } catch (err) {
      const error = err as Error;
      log.error("Failed to resolve short link", error, undefined, {
        key: req.params?.key,
      });
      res
        .status(500)
        .json({ success: false, message: "Failed to resolve short link" });
    }
  }
}

export default ShortLinkController;
