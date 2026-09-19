import { Request, Response } from "express";
import mongoose from "mongoose";
import AuditLog, { IAuditLog } from "../models/AuditLog";
import { createLogger } from "../services/LoggerService";

const log = createLogger("AuditLogController");

export class AuditLogController {
  /**
   * GET /api/audit-logs
   * Get audit logs with pagination and filtering
   * Admin only access
   */
  static async getAuditLogs(req: Request, res: Response): Promise<void> {
    try {
      // Intentionally kept minimal logging; removed temporary debug console statements.

      const {
        page = "1",
        limit = "20",
        action,
        date,
        eventId,
        actorId,
      } = req.query;

      // Parse pagination parameters
      const pageNumber = Math.max(1, parseInt(page as string, 10));
      const limitNumber = Math.min(
        100,
        Math.max(1, parseInt(limit as string, 10))
      ); // Cap at 100
      const skip = (pageNumber - 1) * limitNumber;

      // Build filter query
      const filter: Record<string, unknown> = {};
      const scopedFilters: Record<string, unknown>[] = [];

      if (action && typeof action === "string") {
        filter.action = action;
      }

      if (eventId && typeof eventId === "string") {
        const eventFilters: Record<string, unknown>[] = [
          { targetModel: "Event", targetId: eventId },
        ];
        if (mongoose.Types.ObjectId.isValid(eventId)) {
          eventFilters.unshift({ eventId });
        }
        scopedFilters.push({
          $or: eventFilters,
        });
      }

      if (actorId && typeof actorId === "string") {
        const actorFilters: Record<string, unknown>[] = [{ actorKey: actorId }];
        if (mongoose.Types.ObjectId.isValid(actorId)) {
          actorFilters.unshift({ actorId }, { "actor.id": actorId });
        }
        scopedFilters.push({
          $or: actorFilters,
        });
      }

      if (scopedFilters.length > 0) {
        filter.$and = scopedFilters;
      }

      // Date filtering - if date is provided, filter for that specific day
      if (date && typeof date === "string") {
        const startDate = new Date(date);
        const endDate = new Date(date);
        endDate.setDate(endDate.getDate() + 1);

        filter.createdAt = {
          $gte: startDate,
          $lt: endDate,
        };
      }

      // Execute queries
      const [auditLogs, totalCount] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1 }) // Most recent first
          .skip(skip)
          .limit(limitNumber)
          .populate("actorId", "username email firstName lastName role", "User")
          .populate(
            "actor.id",
            "username email firstName lastName role",
            "User"
          )
          .populate("eventId", "title", "Event")
          .lean(),
        AuditLog.countDocuments(filter),
      ]);

      // Calculate pagination info
      const totalPages = Math.ceil(totalCount / limitNumber);
      const hasNextPage = pageNumber < totalPages;
      const hasPrevPage = pageNumber > 1;

      // Format response
      interface PopulatedUserRef {
        _id?: unknown;
        username: string;
        email: string;
        firstName?: string;
        lastName?: string;
        role?: string;
      }
      interface PopulatedEventRef {
        _id?: unknown;
        title?: string;
      }
      interface LeanAuditLog
        extends Omit<IAuditLog, "_id" | "actorId" | "eventId" | "actor"> {
        _id: { toString(): string };
        actorId?: PopulatedUserRef | string;
        eventId?: PopulatedEventRef | string;
        actor?: { id: unknown; role: string; email?: string } | null;
        version?: number;
        actorType?: "user" | "worker" | "system" | null;
        actorKey?: string | null;
        source?: "http" | "socket" | "worker" | "system" | null;
        correlationId?: string | null;
        outcome?: "success" | "denied" | "failure" | "noop" | null;
        reasonCode?: string | null;
        targetModel?: string;
        targetId?: string;
        details?: Record<string, unknown>;
        ipAddress?: string;
        userAgent?: string;
      }

      function hasObjectKeys(obj: unknown, keys: readonly string[]): boolean {
        if (!obj || typeof obj !== "object") return false;
        return keys.every((k) => k in (obj as Record<string, unknown>));
      }
      function isPopulatedUserRef(val: unknown): val is PopulatedUserRef {
        return hasObjectKeys(val, ["username", "email"]);
      }
      function isPopulatedEventRef(val: unknown): val is PopulatedEventRef {
        return hasObjectKeys(val, ["title"]);
      }

      const formattedLogs = (auditLogs as unknown as LeanAuditLog[]).map(
        (auditLog) => {
          // Actor info normalization - support both old and new format
          let actorIdStr: string | null = null;
          let actorInfo: {
            username: string;
            email: string;
            name: string;
            role: string;
          } | null = null;

          // New format: actor object with embedded info
          if (auditLog.actor && typeof auditLog.actor === "object") {
            const actor = auditLog.actor as {
              id: unknown;
              role: string;
              email?: string;
            };

            // Check if actor.id was populated with user details
            if (
              actor.id &&
              typeof actor.id === "object" &&
              isPopulatedUserRef(actor.id)
            ) {
              const populatedUser = actor.id as PopulatedUserRef;
              actorIdStr = populatedUser._id ? String(populatedUser._id) : null;
              const fullName = `${populatedUser.firstName || ""} ${
                populatedUser.lastName || ""
              }`.trim();
              actorInfo = {
                username: populatedUser.username,
                email: populatedUser.email,
                name: fullName || populatedUser.username,
                role: actor.role,
              };
            } else {
              // A deleted/unpopulated version 2 user intentionally has no raw
              // email fallback. Keep the identifier usable without inventing PII.
              actorIdStr = actor.id ? String(actor.id) : null;
              const legacyEmail =
                typeof actor.email === "string" ? actor.email : "";
              actorInfo = {
                username:
                  legacyEmail.split("@")[0] ||
                  (actorIdStr ? `user-${actorIdStr.slice(-6)}` : "user"),
                email: legacyEmail,
                name: "User",
                role: actor.role,
              };
            }
          }
          // Old format: populated actorId
          else if (isPopulatedUserRef(auditLog.actorId)) {
            const a = auditLog.actorId;
            actorIdStr = a._id ? String(a._id) : null;
            const fullName = `${a.firstName || ""} ${a.lastName || ""}`.trim();

            // Extract role from populated user if available
            const userRole =
              (a as PopulatedUserRef & { role?: string }).role || "User";

            actorInfo = {
              username: a.username,
              email: a.email,
              name: fullName || a.username,
              role: userRole,
            };
          } else if (typeof auditLog.actorId === "string") {
            actorIdStr = auditLog.actorId;
          }

          if (
            !actorInfo &&
            (auditLog.actorType === "worker" ||
              auditLog.actorType === "system")
          ) {
            const actorKey = auditLog.actorKey || auditLog.actorType;
            actorInfo = {
              username: actorKey,
              email: "",
              name: actorKey,
              role: auditLog.actorType === "worker" ? "Worker" : "System",
            };
          }

          // Event info normalization - support both old and new format
          let eventIdStr: string | null = null;
          let eventTitle: string | null = null;

          // New format: targetModel and targetId
          if (auditLog.targetModel === "Event" && auditLog.targetId) {
            eventIdStr = auditLog.targetId;
            // Try to get event title from details if available
            if (auditLog.details && typeof auditLog.details === "object") {
              const details = auditLog.details as Record<string, unknown>;
              if (
                details.targetEvent &&
                typeof details.targetEvent === "object"
              ) {
                const targetEvent = details.targetEvent as Record<
                  string,
                  unknown
                >;
                eventTitle = targetEvent.title
                  ? String(targetEvent.title)
                  : null;
              }
            }
          }
          // Old format: populated eventId
          else if (isPopulatedEventRef(auditLog.eventId)) {
            const e = auditLog.eventId;
            eventIdStr = e._id ? String(e._id) : null;
            eventTitle = e.title || null;
          } else if (typeof auditLog.eventId === "string") {
            eventIdStr = auditLog.eventId;
          }

          return {
            id: auditLog._id.toString(),
            version: auditLog.version ?? 1,
            action: auditLog.action,
            actorType: auditLog.actorType ?? null,
            actorKey: auditLog.actorKey ?? null,
            actorId: actorIdStr,
            actorInfo,
            source: auditLog.source ?? null,
            correlationId: auditLog.correlationId ?? null,
            outcome: auditLog.outcome ?? null,
            reasonCode: auditLog.reasonCode ?? null,
            eventId: eventIdStr,
            eventTitle,
            metadata: auditLog.metadata,
            details: auditLog.details, // Include new format details
            targetModel: auditLog.targetModel, // Include new format targetModel
            targetId: auditLog.targetId, // Include new format targetId
            ipHash: auditLog.ipHash,
            emailHash: auditLog.emailHash,
            ipAddress: auditLog.ipAddress,
            userAgent: auditLog.userAgent,
            createdAt: auditLog.createdAt,
          };
        }
      );

      const response = {
        success: true,
        data: {
          auditLogs: formattedLogs,
          pagination: {
            currentPage: pageNumber,
            totalPages,
            totalCount,
            hasNextPage,
            hasPrevPage,
            limit: limitNumber,
          },
          filters: {
            action: action || null,
            date: date || null,
            eventId: eventId || null,
            actorId: actorId || null,
          },
        },
      };

      log.info(
        `Retrieved ${formattedLogs.length} audit logs`,
        "AuditLogController",
        {
          page: pageNumber,
          limit: limitNumber,
          totalCount,
          filters: Object.keys(filter),
          requestedBy: req.user?._id,
        }
      );

      res.status(200).json(response);
    } catch (error) {
      log.error(
        "Failed to fetch audit logs",
        error as Error,
        "AuditLogController",
        {
          query: req.query,
          requestedBy: req.user?._id,
        }
      );

      res.status(500).json({
        success: false,
        message: "Failed to fetch audit logs",
        error:
          process.env.NODE_ENV === "development"
            ? (error as Error).message
            : undefined,
      });
    }
  }

  /**
   * GET /api/audit-logs/stats
   * Get audit log statistics
   * Admin only access
   */
  static async getAuditLogStats(req: Request, res: Response): Promise<void> {
    try {
      const { days = "30" } = req.query;
      const daysNumber = parseInt(days as string, 10);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNumber);

      const stats = await AuditLog.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
          },
        },
        {
          $group: {
            _id: "$action",
            count: { $sum: 1 },
            lastOccurrence: { $max: "$createdAt" },
          },
        },
        {
          $sort: { count: -1 },
        },
      ]);

      const totalLogs = await AuditLog.countDocuments({
        createdAt: { $gte: startDate },
      });

      log.info(
        `Retrieved audit log statistics for ${daysNumber} days`,
        "AuditLogController",
        {
          totalLogs,
          uniqueActions: stats.length,
          requestedBy: req.user?._id,
        }
      );

      res.status(200).json({
        success: true,
        data: {
          period: {
            days: daysNumber,
            startDate,
            endDate: new Date(),
          },
          totalLogs,
          actionStats: stats,
        },
      });
    } catch (error) {
      log.error(
        "Failed to fetch audit log statistics",
        error as Error,
        "AuditLogController",
        {
          query: req.query,
          requestedBy: req.user?._id,
        }
      );

      res.status(500).json({
        success: false,
        message: "Failed to fetch audit log statistics",
        error:
          process.env.NODE_ENV === "development"
            ? (error as Error).message
            : undefined,
      });
    }
  }
}
