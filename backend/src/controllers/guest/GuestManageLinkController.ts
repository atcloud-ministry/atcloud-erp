/**
 * GuestManageLinkController.ts
 * Handles guest manage link operations (regenerate and resend)
 */
import type { Request, Response } from "express";
import { GuestRegistration, Event } from "../../models";
import mongoose from "mongoose";
import { createLogger } from "../../services/LoggerService";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";

// Local types and helpers
type EventLike = {
  _id: unknown;
  title?: string;
  date?: unknown;
  location?: string;
  time?: string;
  endTime?: string;
  endDate?: unknown;
  timeZone?: string;
  format?: string;
  isHybrid?: unknown;
  zoomLink?: string;
  agenda?: string;
  purpose?: string;
  meetingId?: string;
  passcode?: string;
  organizerDetails?: unknown;
  createdBy?: unknown;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asDateOrString(v: unknown): Date | string | undefined {
  if (v instanceof Date) return v;
  if (typeof v === "string") return v;
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Controller for handling guest manage link operations
 */
class GuestManageLinkController {
  private static readonly log = createLogger("GuestManageLinkController");

  /**
   * Re-send manage link (regenerate token and email) for a guest registration
   * POST /api/guest-registrations/:id/resend-manage-link
   * Admin-only (route-protected)
   */
  static async resendManageLink(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const doc = await GuestRegistration.findById(id);
      if (!doc) {
        res
          .status(404)
          .json({ success: false, message: "Guest registration not found" });
        return;
      }
      if (doc.status === "cancelled") {
        res.status(400).json({
          success: false,
          message: "Cannot re-send link for cancelled registration",
        });
        return;
      }

      // Generate a fresh token and extend expiry
      let rawToken: string | undefined;
      try {
        rawToken = (
          doc as unknown as { generateManageToken?: () => string | undefined }
        ).generateManageToken?.();
      } catch {
        /* intentionally ignore non-critical debug/logging errors */
      }
      await doc.save();

      // Send email to guest with the new manage link (use confirmation template)
      try {
        // Fetch minimal event info for email context
        const event = (await Event.findById(doc.eventId)) as EventLike | null;
        await EmailService.sendGuestConfirmationEmail({
          guestEmail: String(doc.email ?? ""),
          guestName: String(doc.fullName ?? ""),
          event: {
            title: asString((event as EventLike | null)?.title) || "Event",
            date:
              asDateOrString((event as EventLike | null)?.date) ?? new Date(),
            location: asString((event as EventLike | null)?.location),
            time: asString((event as EventLike | null)?.time),
            endTime: asString((event as EventLike | null)?.endTime),
            endDate: asDateOrString((event as EventLike | null)?.endDate),
            timeZone: asString((event as EventLike | null)?.timeZone),
            format: asString((event as EventLike | null)?.format),
            isHybrid: asBool((event as EventLike | null)?.isHybrid),
            zoomLink: asString((event as EventLike | null)?.zoomLink),
            agenda: asString((event as EventLike | null)?.agenda),
            purpose: asString((event as EventLike | null)?.purpose),
            meetingId: asString((event as EventLike | null)?.meetingId),
            passcode: asString((event as EventLike | null)?.passcode),
            organizerDetails: Array.isArray(
              (event as EventLike | null)?.organizerDetails
            )
              ? (
                  ((event as EventLike).organizerDetails as Array<
                    Record<string, unknown>
                  >) || []
                )
                  .map((o) => ({
                    name: asString(o["name"]) || "Organizer",
                    role: asString(o["role"]) || "Organizer",
                    email: asString(o["email"]) || "",
                  }))
                  .filter((o) => !!o.email)
              : undefined,
            createdBy: (():
              | {
                  firstName?: string;
                  lastName?: string;
                  username?: string;
                  email?: string;
                  avatar?: string;
                  gender?: string;
                }
              | undefined => {
              const cbUnknown: unknown = (event as EventLike | null)?.createdBy;
              const cb =
                cbUnknown && typeof cbUnknown === "object"
                  ? (cbUnknown as Record<string, unknown>)
                  : undefined;
              return cb
                ? {
                    firstName: asString(cb["firstName"]),
                    lastName: asString(cb["lastName"]),
                    username: asString(cb["username"]),
                    email: asString(cb["email"]),
                    avatar: asString(cb["avatar"]),
                    gender: asString(cb["gender"]),
                  }
                : undefined;
            })(),
          },
          role: { name: (doc.eventSnapshot?.roleName as string) || "" },
          registrationId: (doc._id as mongoose.Types.ObjectId).toString(),
          manageToken: rawToken,
        });
      } catch (emailErr) {
        console.error("Failed to send manage link email:", emailErr);
        // Do not fail the request if email sending fails
        GuestManageLinkController.log.error(
          "Failed to send manage link email",
          emailErr as Error,
          undefined,
          { id }
        );
        try {
          CorrelatedLogger.fromRequest(req, "GuestManageLinkController").error(
            "Failed to send manage link email",
            emailErr as Error,
            undefined,
            { id }
          );
        } catch {
          /* ignore */
        }
      }

      res.status(200).json({
        success: true,
        message: "Manage link re-sent successfully",
      });
    } catch (error) {
      console.error("Error re-sending manage link:", error);
      GuestManageLinkController.log.error(
        "Error re-sending manage link",
        error as Error,
        undefined,
        { id: (req.params || {}).id }
      );
      try {
        CorrelatedLogger.fromRequest(req, "GuestManageLinkController").error(
          "Error re-sending manage link",
          error as Error,
          undefined,
          { id: (req.params || {}).id }
        );
      } catch {
        /* ignore */
      }
      res
        .status(500)
        .json({ success: false, message: "Failed to re-send manage link" });
    }
  }
}

export default GuestManageLinkController;
