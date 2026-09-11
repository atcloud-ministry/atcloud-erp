/**
 * GuestRoleManagementController.ts
 * Handles guest role management operations (moving guests between roles)
 */
import type { Request, Response } from "express";
import { GuestRegistration, Event, IEventRole } from "../../models";
import mongoose from "mongoose";
import { createLogger } from "../../services/LoggerService";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { socketService } from "../../services/infrastructure/SocketService";
import { lockService } from "../../services/LockService";
import { CapacityService } from "../../services/CapacityService";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { ResponseBuilderService } from "../../services/ResponseBuilderService";

// Local types
type RequestWithUser = Request & { user?: { _id: unknown; role?: string } };
type EventLike = { _id: unknown; title: string; roles: IEventRole[] };
type UserLike = { firstName?: string; lastName?: string };

/**
 * Controller for handling guest role management operations
 */
class GuestRoleManagementController {
  private static readonly log = createLogger("GuestRoleManagementController");

  /**
   * Move a guest registration between roles (admin/organizer management operation)
   * POST /api/events/:id/manage/move-guest
   */
  static async moveGuestBetweenRoles(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const { id: eventId } = req.params;
      const { guestRegistrationId, fromRoleId, toRoleId } = (req.body ||
        {}) as {
        guestRegistrationId: string;
        fromRoleId: string;
        toRoleId: string;
      };

      // Basic validation
      if (!mongoose.Types.ObjectId.isValid(eventId)) {
        res.status(400).json({ success: false, message: "Invalid event ID." });
        return;
      }
      if (!mongoose.Types.ObjectId.isValid(guestRegistrationId)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid guest registration ID." });
        return;
      }
      if (!fromRoleId || !toRoleId) {
        res.status(400).json({
          success: false,
          message: "Source and target role IDs are required.",
        });
        return;
      }
      if (fromRoleId === toRoleId) {
        res
          .status(200)
          .json({ success: true, message: "No change - same role", data: {} });
        return;
      }

      const event = await Event.findById(eventId);
      if (!event) {
        res.status(404).json({ success: false, message: "Event not found" });
        return;
      }

      const sourceRole = event.roles.find(
        (r: IEventRole) => r.id === fromRoleId
      );
      const targetRole = event.roles.find((r: IEventRole) => r.id === toRoleId);
      if (!sourceRole || !targetRole) {
        res
          .status(404)
          .json({ success: false, message: "Source or target role not found" });
        return;
      }

      // Find guest registration and ensure it belongs to source role and event
      const guest = await GuestRegistration.findById(guestRegistrationId);
      if (!guest) {
        res
          .status(404)
          .json({ success: false, message: "Guest registration not found" });
        return;
      }
      if (guest.status === "cancelled") {
        res.status(400).json({
          success: false,
          message: "Cannot move a cancelled registration",
        });
        return;
      }
      if (guest.eventId.toString() !== event._id.toString()) {
        res.status(400).json({
          success: false,
          message: "Registration does not belong to this event",
        });
        return;
      }
      if (guest.roleId !== fromRoleId) {
        res.status(400).json({
          success: false,
          message: "Registration is not in the specified source role",
        });
        return;
      }

      // Perform capacity check and move under an application-level lock on the target role
      // Use the same key family as guest signup so signups and moves serialize together
      const lockKey = `guest-signup:${eventId}:${toRoleId}`;
      const lockResult = await lockService.withLock(
        lockKey,
        async () => {
          // Re-check capacity inside lock
          const occ = await CapacityService.getRoleOccupancy(
            event._id.toString(),
            toRoleId,
            {
              capacity:
                (targetRole as unknown as { maxParticipants?: unknown })
                  .maxParticipants ??
                (targetRole as unknown as { capacity?: unknown }).capacity,
            },
          );
          if (CapacityService.isRoleFull(occ)) {
            return {
              type: "error",
              status: 400,
              message: `Target role is at full capacity (${occ.total}/$${
                (occ.capacity ??
                  (targetRole as unknown as { maxParticipants?: number })
                    ?.maxParticipants) ||
                "?"
              })`,
            } as const;
          }

          // Persist move
          guest.roleId = toRoleId;
          // Invalidate any manage token to avoid stale links tied to old role context
          try {
            (
              guest as unknown as { manageToken?: string | undefined }
            ).manageToken = undefined;
            (
              guest as unknown as { manageTokenExpires?: Date | undefined }
            ).manageTokenExpires = undefined;
          } catch {
            /* intentionally ignore non-critical errors */
          }
          await guest.save();
          await event.save();
          return { type: "ok" } as const;
        },
        10000
      );

      type MoveLockResult =
        | { type: "ok" }
        | { type: "error"; status: number; message: string };
      const moveOutcome = lockResult as unknown as MoveLockResult;
      if (moveOutcome?.type === "error") {
        res.status(moveOutcome.status).json({
          success: false,
          message: moveOutcome.message,
        });
        return;
      }

      // Invalidate caches and build updated event
      await CachePatterns.invalidateEventCache(eventId);
      await CachePatterns.invalidateAnalyticsCache();
      const updatedEvent =
        await ResponseBuilderService.buildEventWithRegistrations(
          eventId,
          (req as RequestWithUser).user?._id
            ? String((req as RequestWithUser).user!._id)
            : undefined,
          (req as RequestWithUser).user?.role,
        );

      // Email the guest about the role move
      try {
        const actor = (req as RequestWithUser)?.user || {};
        const fromName = sourceRole?.name || "Previous Role";
        const toName = targetRole?.name || "New Role";
        await EmailService.sendEventRoleMovedEmail(guest.email, {
          event: { title: (event as EventLike).title },
          user: { email: guest.email, name: guest.fullName },
          fromRoleName: fromName,
          toRoleName: toName,
          actor: {
            firstName: (actor as UserLike)?.firstName || "",
            lastName: (actor as UserLike)?.lastName || "",
          },
        });
      } catch (emailErr) {
        console.error("Failed to send guest moved email:", emailErr);
        // Non-fatal
        GuestRoleManagementController.log.error(
          "Failed to send guest moved email",
          emailErr as Error,
          undefined,
          { eventId, guestId: guestRegistrationId, fromRoleId, toRoleId }
        );
      }

      // Emit real-time updates
      // Backward-compatible generic guest update
      socketService.emitEventUpdate(eventId, "guest_updated", {
        eventId,
        roleId: toRoleId,
        guestName: guest.fullName,
        event: updatedEvent,
      });

      // New explicit guest_moved event for clearer client reactions
      const fromRoleName = sourceRole?.name || undefined;
      const toRoleName = targetRole?.name || undefined;
      socketService.emitEventUpdate(eventId, "guest_moved", {
        eventId,
        fromRoleId,
        toRoleId,
        fromRoleName,
        toRoleName,
        guestName: guest.fullName,
        event: updatedEvent,
      });

      res.status(200).json({
        success: true,
        message: "Guest moved between roles successfully",
        data: { event: updatedEvent },
      });
    } catch (error) {
      console.error("Move guest between roles error:", error);
      GuestRoleManagementController.log.error(
        "Move guest between roles error",
        error as Error,
        undefined,
        {
          eventId: (req.params || {}).id,
          guestRegistrationId: (req.body || {}).guestRegistrationId,
          fromRoleId: (req.body || {}).fromRoleId,
          toRoleId: (req.body || {}).toRoleId,
        }
      );
      res.status(500).json({
        success: false,
        message:
          (error as unknown as { message?: string })?.message ||
          "Failed to move guest between roles",
      });
    }
  }
}

export default GuestRoleManagementController;
