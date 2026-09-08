import { Request, Response } from "express";
import {
  Event,
  Registration,
  User,
  IEvent,
  IEventRole,
  Program,
  Purchase,
} from "../../models";
import { PERMISSIONS, hasPermission } from "../../utils/roleUtils";
import { EmailRecipientUtils } from "../../utils/emailRecipientUtils";
import mongoose from "mongoose";
import { EmailService } from "../../services/infrastructure/EmailServiceFacade";
import { RegistrationQueryService } from "../../services/RegistrationQueryService";
import { UnifiedMessageController } from "../unifiedMessageController";
import { Logger } from "../../services/LoggerService";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { DeletionController } from "./DeletionController";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { formatActorDisplay } from "../../utils/systemMessageFormatUtils";
import AuditLog from "../../models/AuditLog";
import { toInstantFromWallClock } from "../../utils/event/timezoneUtils";
import {
  isAffiliatedProgramEditor,
  isEventOrganizer,
} from "../../utils/event/eventPermissions";
import { ResponseBuilderService } from "../../services/ResponseBuilderService";
import { EventController } from "../eventController";
import { FieldNormalizationService } from "../../services/event/FieldNormalizationService";
import { OrganizerManagementService } from "../../services/event/OrganizerManagementService";
import { ProgramLinkageService } from "../../services/event/ProgramLinkageService";
import { RoleUpdateService } from "../../services/event/RoleUpdateService";
import { AutoUnpublishService } from "../../services/event/AutoUnpublishService";
import { CoOrganizerNotificationService } from "../../services/event/CoOrganizerNotificationService";
import { ParticipantNotificationService } from "../../services/event/ParticipantNotificationService";
import { CoOrganizerProgramAccessService } from "../../services/event/CoOrganizerProgramAccessService";
import { AssignmentSnapshotError } from "../../services/UserAssignmentSnapshotService";

const logger = Logger.getInstance().child("UpdateController");

/**
 * UpdateController
 * Orchestrates event update operations by coordinating specialized services.
 *
 * Service Responsibilities:
 * 1. FieldNormalizationService - Validates and normalizes event fields (dates, times, format, location)
 * 2. RoleUpdateService - Manages role updates with validation guards against existing registrations
 * 3. OrganizerManagementService - Tracks and normalizes organizer details
 * 4. ProgramLinkageService - Validates and manages program associations with Leader access rules
 * 5. AutoUnpublishService - Auto-unpublishes events missing required fields
 * 6. CoOrganizerNotificationService - Notifies newly added co-organizers
 * 7. ParticipantNotificationService - Notifies participants/guests of event updates
 *
 * Controller Focus: Permission checks, service coordination, response building
 */
export class UpdateController {
  static async updateEvent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid event ID.",
        });
        return;
      }

      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const event = await Event.findById(id);

      if (!event) {
        res.status(404).json({
          success: false,
          message: "Event not found.",
        });
        return;
      }

      // Check permissions
      const canEditAnyEvent = hasPermission(
        req.user.role,
        PERMISSIONS.EDIT_ANY_EVENT,
      );
      const canEditOwnEvent = hasPermission(
        req.user.role,
        PERMISSIONS.EDIT_OWN_EVENT,
      );
      const userIsOrganizer = isEventOrganizer(
        event,
        EventController.toIdString(req.user._id),
      );
      const userIsAffiliatedProgramEditor = await isAffiliatedProgramEditor(
        event,
        EventController.toIdString(req.user._id),
        req.user.role,
      );

      if (
        !canEditAnyEvent &&
        !(canEditOwnEvent && userIsOrganizer) &&
        !userIsAffiliatedProgramEditor
      ) {
        res.status(403).json({
          success: false,
          message:
            "Insufficient permissions to edit this event. You must be the event creator, a co-organizer, or a mentor/class rep of an affiliated program.",
        });
        return;
      }

      // ============================================================
      // STEP 1: Field Normalization and Validation
      // ============================================================
      // Extract suppression flags and prepare update data
      const { suppressNotifications } =
        FieldNormalizationService.extractSuppressionFlags(req.body);
      const updateData = FieldNormalizationService.prepareUpdateData(req.body);

      // Normalize and validate all fields
      const normalizedData =
        await FieldNormalizationService.normalizeAndValidate(
          updateData,
          event,
          id,
          res,
        );

      // If validation failed, response already sent
      if (!normalizedData) {
        return;
      }

      // ============================================================
      // STEP 1.5: Pricing Validation (Paid Events Feature)
      // ============================================================
      // Validate pricing data if provided in update
      if (
        normalizedData.pricing !== undefined &&
        normalizedData.pricing !== null
      ) {
        const { validatePricing } =
          await import("../../utils/event/eventValidation");
        const pricingValidation = validatePricing(
          normalizedData.pricing as
            | { isFree?: boolean; price?: number }
            | undefined,
        );

        if (!pricingValidation.valid) {
          res.status(400).json({
            success: false,
            message: pricingValidation.error || "Invalid pricing configuration",
          });
          return;
        }
      }

      // ============================================================
      // STEP 2: Role Management
      // ============================================================
      // Handle roles update if provided
      if (normalizedData.roles && Array.isArray(normalizedData.roles)) {
        // Extract forceDeleteRegistrations flag from request body
        const forceDeleteRegistrations =
          typeof (req.body as { forceDeleteRegistrations?: unknown })
            .forceDeleteRegistrations === "boolean"
            ? Boolean(
                (req.body as { forceDeleteRegistrations?: boolean })
                  .forceDeleteRegistrations,
              )
            : false;

        // Process role update with validation/merging
        const roleUpdateResult = await RoleUpdateService.processRoleUpdate(
          id,
          event.roles,
          normalizedData.roles,
          forceDeleteRegistrations,
        );

        if (!roleUpdateResult.success) {
          const err = roleUpdateResult.error!;
          res.status(err.status).json({
            success: false,
            message: err.message,
            errors: err.errors,
          });
          return;
        }

        event.roles = roleUpdateResult.mergedRoles!;
        delete normalizedData.roles; // Remove from updateData since we handled it directly
      }

      // ============================================================
      // STEP 3: Organizer Management
      // ============================================================
      // Track old organizer details for comparison (to detect new co-organizers)
      const organizerMgmtService = new OrganizerManagementService();
      const oldOrganizerUserIds =
        organizerMgmtService.trackOldOrganizers(event);

      // SIMPLIFIED: Store only essential organizer info, contact details fetched at read time
      if (
        normalizedData.organizerDetails &&
        Array.isArray(normalizedData.organizerDetails)
      ) {
        normalizedData.organizerDetails =
          await organizerMgmtService.normalizeOrganizerDetails(
            normalizedData.organizerDetails,
            oldOrganizerUserIds,
          );
      }

      // ============================================================
      // STEP 4: Program Linkage
      // ============================================================
      // Handle Programs linkage (programLabels array) before saving
      const prevProgramLabels =
        ProgramLinkageService.extractPreviousLabels(event);
      let nextProgramLabels: string[] = [];

      if (
        (normalizedData as { programLabels?: unknown }).programLabels !==
        undefined
      ) {
        const rawProgramLabels = (normalizedData as { programLabels?: unknown })
          .programLabels;

        const result = await ProgramLinkageService.processAndValidate(
          rawProgramLabels,
          req.user?._id,
          req.user?.role,
          {
            requireProgramManagementAccess:
              userIsAffiliatedProgramEditor &&
              !canEditAnyEvent &&
              !(canEditOwnEvent && userIsOrganizer),
          },
        );

        if (!result.success && result.error) {
          res.status(result.error.status).json({
            success: false,
            message: result.error.message,
            data: result.error.data,
          });
          return;
        }

        nextProgramLabels = result.programIds || [];
      } else {
        // No change requested; keep the existing
        nextProgramLabels = prevProgramLabels;
      }

      // Ensure programLabels change is persisted on the event document
      if (
        (normalizedData as { programLabels?: unknown }).programLabels !==
        undefined
      ) {
        (normalizedData as { programLabels?: unknown }).programLabels =
          ProgramLinkageService.toObjectIdArray(nextProgramLabels);
      }

      // Note: Mentor Circle logic removed - no longer refreshing mentors from programs

      // ============================================================
      // STEP 4.5: Co-Organizer Program Access Validation
      // ============================================================
      // Validate that all co-organizers have access to the event's paid programs
      // Use normalized organizer details if provided, otherwise use existing event organizers
      const organizersToValidate =
        (normalizedData as { organizerDetails?: unknown }).organizerDetails ||
        event.organizerDetails;
      const programsToValidate =
        (normalizedData as { programLabels?: unknown }).programLabels ||
        event.programLabels;

      const coOrganizerAccessResult =
        await CoOrganizerProgramAccessService.validateCoOrganizerAccess(
          organizersToValidate as Parameters<
            typeof CoOrganizerProgramAccessService.validateCoOrganizerAccess
          >[0],
          programsToValidate as Parameters<
            typeof CoOrganizerProgramAccessService.validateCoOrganizerAccess
          >[1],
        );

      if (!coOrganizerAccessResult.valid && coOrganizerAccessResult.error) {
        res.status(coOrganizerAccessResult.error.status).json({
          success: false,
          message: coOrganizerAccessResult.error.message,
          ...(coOrganizerAccessResult.error.data
            ? { data: coOrganizerAccessResult.error.data }
            : {}),
        });
        return;
      }

      Object.assign(event, normalizedData);

      // ============================================================
      // STEP 5: Auto-Unpublish Check
      // ============================================================
      // Auto-unpublish logic: check if event should be unpublished due to missing required fields
      const { autoUnpublished, missingFields: missingFieldsForAutoUnpublish } =
        await AutoUnpublishService.checkAndApplyAutoUnpublish(event);

      await event.save();

      // Audit log for event status change to cancelled
      if (
        normalizedData.status === "cancelled" &&
        event.status === "cancelled"
      ) {
        try {
          await AuditLog.create({
            action: "event_cancelled",
            actor: {
              id: req.user._id,
              role: req.user.role,
              email: req.user.email,
            },
            targetModel: "Event",
            targetId: id,
            details: {
              targetEvent: {
                id: event._id,
                title: event.title,
                type: event.type,
                date: event.date,
                location: event.location,
              },
            },
            ipAddress: req.ip,
            userAgent: req.get("user-agent") || "unknown",
          });
        } catch (auditError) {
          console.error(
            "Failed to create audit log for event cancellation:",
            auditError,
          );
          // Don't fail the request if audit logging fails
        }
      }

      // Send auto-unpublish notifications if event was unpublished
      if (autoUnpublished) {
        await AutoUnpublishService.sendAutoUnpublishNotifications(
          event,
          missingFieldsForAutoUnpublish,
          req,
        );
      }

      // ============================================================
      // STEP 6: Program Sync (bidirectional linking)
      // ============================================================
      // After save: sync Program.events IF programLabels changed.
      // Calculate added and removed programs
      const prevSet = new Set(prevProgramLabels);
      const nextSet = new Set(nextProgramLabels);

      const addedPrograms = nextProgramLabels.filter((id) => !prevSet.has(id));
      const removedPrograms = prevProgramLabels.filter(
        (id) => !nextSet.has(id),
      );

      console.log(addedPrograms.length > 0 || removedPrograms.length > 0);

      if (addedPrograms.length > 0 || removedPrograms.length > 0) {
        try {
          // For the event ID, we need a REAL ObjectId that MongoDB can match
          const eventIdBson = mongoose.Types.ObjectId.isValid(id)
            ? new mongoose.Types.ObjectId(id)
            : new mongoose.Types.ObjectId();

          // Remove event from programs that are no longer linked
          console.log(removedPrograms.length, "programs");
          for (const programId of removedPrograms) {
            await (
              Program as unknown as {
                updateOne: (q: unknown, u: unknown) => Promise<unknown>;
              }
            ).updateOne(
              { _id: new mongoose.Types.ObjectId(programId) },
              { $pull: { events: eventIdBson } },
            );
          }

          // Add event to newly linked programs
          for (const programId of addedPrograms) {
            console.log(eventIdBson, "to program", programId);
            await (
              Program as unknown as {
                updateOne: (
                  q: unknown,
                  u: unknown,
                ) => Promise<{ modifiedCount: number }>;
              }
            ).updateOne(
              { _id: new mongoose.Types.ObjectId(programId) },
              { $addToSet: { events: eventIdBson } },
            );
          }
        } catch (e) {
          console.warn("Failed to sync Program.events on event update", e);
        }
      }

      // ============================================================
      // STEP 7: Notification Services
      // ============================================================
      // Send notifications to newly added co-organizers
      if (!suppressNotifications) {
        await CoOrganizerNotificationService.sendNewCoOrganizerNotifications(
          event,
          oldOrganizerUserIds,
          normalizedData,
          req,
        );
      }

      // Notify participants and guests that the event has been edited
      if (!suppressNotifications) {
        await ParticipantNotificationService.sendEventUpdateNotifications(
          id,
          event,
          req,
        );
      }

      // ============================================================
      // STEP 8: Cache Invalidation and Response
      // ============================================================
      // Invalidate event-related caches since event was updated
      await CachePatterns.invalidateEventCache(id);
      await CachePatterns.invalidateAnalyticsCache();

      // Build response with proper field mapping (includes maxParticipants alias)
      const eventResponse =
        await ResponseBuilderService.buildEventWithRegistrations(
          id,
          req.user ? EventController.toIdString(req.user._id) : undefined,
          (req.user as { role?: string } | undefined)?.role,
        );

      res.status(200).json({
        success: true,
        message: autoUnpublished
          ? "Event updated. Warning: Missing required fields for publishing. Event will be automatically unpublished in 48 hours if not corrected."
          : "Event updated successfully!",
        data: { event: eventResponse },
      });
    } catch (error: unknown) {
      console.error("Update event error:", error);
      CorrelatedLogger.fromRequest(req, "UpdateController").error(
        "updateEvent failed",
        error as Error,
        undefined,
        { eventId: req.params?.id },
      );

      if (error instanceof AssignmentSnapshotError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }

      // Handle validation errors
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "ValidationError"
      ) {
        const errs = (error as { errors: Record<string, { message: string }> })
          .errors;
        const validationErrors = Object.values(errs).map((err) => err.message);
        res.status(400).json({
          success: false,
          message: `Validation failed: ${validationErrors.join(", ")}`,
        });
        return;
      }

      res.status(500).json({
        success: false,
        message: "Failed to update event.",
      });
    }
  }

  /**
   * Update YouTube URL for a completed/past event
   * Only Super Admin, Administrator, event creator, or co-organizers can update
   */
  static async updateYoutubeUrl(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { youtubeUrl } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid event ID.",
        });
        return;
      }

      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const event = await Event.findById(id);

      if (!event) {
        res.status(404).json({
          success: false,
          message: "Event not found.",
        });
        return;
      }

      // Only allow for completed events
      if (event.status !== "completed") {
        res.status(400).json({
          success: false,
          message: "YouTube URL can only be added to completed events.",
        });
        return;
      }

      // Check permissions: Super Admin, Administrator, creator, or co-organizer
      const userId = EventController.toIdString(req.user._id);
      const isAdmin = ["Super Admin", "Administrator"].includes(req.user.role);
      const isCreator = EventController.toIdString(event.createdBy) === userId;
      const isCoOrganizer = event.organizerDetails?.some(
        (org: { userId?: unknown }) =>
          org.userId && EventController.toIdString(org.userId) === userId,
      );
      const isProgramEditor = await isAffiliatedProgramEditor(
        event,
        userId,
        req.user.role,
      );

      if (!isAdmin && !isCreator && !isCoOrganizer && !isProgramEditor) {
        res.status(403).json({
          success: false,
          message:
            "You do not have permission to update this event's YouTube URL.",
        });
        return;
      }

      // Validate YouTube URL format if provided
      if (youtubeUrl && typeof youtubeUrl === "string" && youtubeUrl.trim()) {
        const urlPattern = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\/.+/;
        if (!urlPattern.test(youtubeUrl.trim())) {
          res.status(400).json({
            success: false,
            message:
              "Invalid YouTube URL. Please provide a valid YouTube link.",
          });
          return;
        }
        event.youtubeUrl = youtubeUrl.trim();
      } else {
        // Allow clearing the URL
        event.youtubeUrl = undefined;
      }

      await event.save();

      // Invalidate cache
      await CachePatterns.invalidateEventCache(id);

      // Build response with proper field mapping
      const eventResponse =
        await ResponseBuilderService.buildEventWithRegistrations(
          id,
          req.user ? EventController.toIdString(req.user._id) : undefined,
          (req.user as { role?: string } | undefined)?.role,
        );

      res.status(200).json({
        success: true,
        message: youtubeUrl
          ? "YouTube URL updated successfully."
          : "YouTube URL removed successfully.",
        data: { event: eventResponse },
      });
    } catch (error: unknown) {
      console.error("Update YouTube URL error:", error);
      CorrelatedLogger.fromRequest(req, "UpdateController").error(
        "updateYoutubeUrl failed",
        error as Error,
        undefined,
        { eventId: req.params?.id },
      );

      res.status(500).json({
        success: false,
        message: "Failed to update YouTube URL.",
      });
    }
  }
}
