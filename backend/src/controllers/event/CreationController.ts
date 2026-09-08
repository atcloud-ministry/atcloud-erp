/**
 * CreationController
 *
 * ORCHESTRATOR PATTERN - Event Creation
 *
 * This controller orchestrates event creation by coordinating specialized services.
 * Each service handles a specific domain of business logic, following the Single
 * Responsibility Principle for improved maintainability and testability.
 *
 * REFACTORING HISTORY:
 * - Original: 1,240 lines (monolithic controller)
 * - Current: 382 lines (69.2% reduction)
 * - Services Extracted: 7
 *
 * ARCHITECTURE:
 * The controller acts as a thin orchestration layer that:
 * 1. Validates permissions and authentication
 * 2. Coordinates service calls in proper sequence
 * 3. Handles error responses and cache invalidation
 * 4. Builds and returns API responses
 *
 * EXTRACTED SERVICES (Phase 9):
 *
 * 1. EventFieldNormalizationService (132 lines)
 *    - Validates and normalizes incoming event fields
 *    - Handles format-specific validation (In-person/Online/Hybrid)
 *    - Ensures required fields are present and properly formatted
 *
 * 2. EventRolePreparationService (123 lines)
 *    - Validates and prepares event roles
 *    - Calculates total slots across all roles
 *    - Ensures role data integrity (names, descriptions, max participants)
 *
 * 3. EventOrganizerDataService (111 lines)
 *    - Processes organizer details with placeholder pattern
 *    - Handles contact information (phone/email) privacy
 *    - Ensures consistent organizer data structure
 *
 * 4. EventProgramLinkageService (186 lines)
 *    - Validates program labels and permissions
 *    - Establishes bidirectional event-program relationships
 *    - Handles program ownership and access control
 *
 * 5. CoOrganizerProgramAccessService
 *    - Validates co-organizer access to linked programs
 *    - Prevents unauthorized program/event associations
 *
 * 6. RecurringEventGenerationService (420 lines)
 *    - Generates recurring event series (every-two-weeks, monthly, every-two-months)
 *    - Handles complex cycle calculations with weekday preservation
 *    - Implements conflict detection with 6-day bump window
 *    - Tracks skipped/appended events with auto-rescheduling
 *    - Sends detailed conflict notifications to creator
 *
 * 7. EventCreationNotificationService (450 lines)
 *    - System messages: Broadcast to all active users
 *    - Email notifications: All active users excluding creator
 *    - Co-organizer notifications: Emails + targeted system messages
 *    - Recurring series announcements with frequency mapping
 *
 * ORCHESTRATION FLOW:
 * See inline step markers (// STEP 1-9) in createEvent() method.
 *
 * Extracted from eventController.ts (lines 602-1806) as part of Phase 9 refactoring.
 */

import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
  Event,
  Registration,
  User,
  IEvent,
  Program,
  Purchase,
} from "../../models";
import { PERMISSIONS, hasPermission } from "../../utils/roleUtils";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { ResponseBuilderService } from "../../services/ResponseBuilderService";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { Logger } from "../../services/LoggerService";
import { EventFieldNormalizationService } from "../../services/event/EventFieldNormalizationService";
import { EventRolePreparationService } from "../../services/event/EventRolePreparationService";
import { EventOrganizerDataService } from "../../services/event/EventOrganizerDataService";
import { EventProgramLinkageService } from "../../services/event/EventProgramLinkageService";
import { RecurringEventGenerationService } from "../../services/event/RecurringEventGenerationService";
import { EventCreationNotificationService } from "../../services/event/EventCreationNotificationService";
import { CoOrganizerProgramAccessService } from "../../services/event/CoOrganizerProgramAccessService";
import { AssignmentSnapshotError } from "../../services/UserAssignmentSnapshotService";
import { generateUniquePublicSlug } from "../../utils/publicSlug";
import { toIdString } from "../../utils/idUtils";

// Initialize logger
const logger = Logger.getInstance().child("CreationController");

// Type definitions
interface IncomingRoleData {
  name: string;
  description: string;
  maxParticipants: number;
  openToPublic?: boolean;
  agenda?: string;
  startTime?: string;
  endTime?: string;
}

interface CreateEventRequest {
  [key: string]: unknown;
  title: string;
  type: string;
  date: string;
  endDate?: string;
  time: string;
  endTime: string;
  organizer: string;
  format: "In-person" | "Online" | "Hybrid Participation";
  roles: IncomingRoleData[];
  purpose?: string;
  location?: string;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  flyerUrl?: string;
  secondaryFlyerUrl?: string;
  timeZone?: string;
  organizerDetails?: Array<{
    userId?: unknown;
    name?: string;
    role?: string;
    avatar?: string;
    gender?: "male" | "female";
  }>;
  hostedBy?: string;
  suppressNotifications?: boolean;
  pricing?: {
    isFree: boolean;
    price?: number;
  };
  programLabels?: string[];
}

export class CreationController {
  /**
   * Create a new event with optional recurring series generation
   *
   * ORCHESTRATION STEPS:
   * 1. Authentication & Permission Validation
   * 2. Field Normalization & Validation (EventFieldNormalizationService)
   * 3. Time Overlap Policy & Pricing Validation
   * 4. Role Preparation (EventRolePreparationService)
   * 5. Organizer Data Processing (EventOrganizerDataService)
   * 6. Program Linkage Validation (EventProgramLinkageService)
   * 6.5. Co-Organizer Program Access Validation (CoOrganizerProgramAccessService)
   * 7. Event Creation & Recurring Series Generation (RecurringEventGenerationService)
   * 8. Notification Dispatch (EventCreationNotificationService)
   * 9. Cache Invalidation & Response Building
   *
   * @param req - Express request with event data in body
   * @param res - Express response
   */
  static async createEvent(req: Request, res: Response): Promise<void> {
    try {
      // ========================================
      // STEP 1: Authentication & Permission Validation
      // ========================================
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const hasCreateEventPermission = hasPermission(
        req.user.role,
        PERMISSIONS.CREATE_EVENT,
      );
      const rawProgramLabels = (req.body as { programLabels?: unknown })
        .programLabels;
      const hasProgramLabels =
        Array.isArray(rawProgramLabels) &&
        rawProgramLabels.some(
          (id) =>
            id !== null &&
            id !== undefined &&
            String(id).trim() !== "" &&
            id !== "none",
        );

      // Users without global event-creation permission may still create
      // program-scoped events when they are a mentor or class rep of the
      // selected program(s). The program linkage step below enforces that
      // narrower access.
      if (!hasCreateEventPermission && !hasProgramLabels) {
        res.status(403).json({
          success: false,
          message:
            "Insufficient permissions to create events. Select a program where you are a mentor or class rep.",
        });
        return;
      }

      // ========================================
      // STEP 2: Field Normalization & Validation
      // ========================================
      const eventData: CreateEventRequest = req.body;
      const recurring = (
        req.body as {
          recurring?: {
            isRecurring?: boolean;
            frequency?:
              | "weekly"
              | "biweekly"
              | "every-two-weeks"
              | "monthly"
              | "every-two-months"
              | "every-three-months";
            occurrenceCount?: number;
            recurrenceMode?: "same-date" | "same-weekday";
            weekdayOrdinal?: number;
            weekday?: number;
          };
        }
      ).recurring as
        | {
            isRecurring?: boolean;
            frequency?:
              | "weekly"
              | "biweekly"
              | "every-two-weeks"
              | "monthly"
              | "every-two-months"
              | "every-three-months";
            occurrenceCount?: number;
            recurrenceMode?: "same-date" | "same-weekday";
            weekdayOrdinal?: number;
            weekday?: number;
          }
        | undefined;

      // Normalize and validate event fields using EventFieldNormalizationService
      const normalizationResult =
        EventFieldNormalizationService.normalizeAndValidate(
          eventData as Parameters<
            typeof EventFieldNormalizationService.normalizeAndValidate
          >[0],
          req.body,
        );

      if (!normalizationResult.valid && normalizationResult.error) {
        res.status(normalizationResult.error.status).json({
          success: false,
          message: normalizationResult.error.message,
          ...(normalizationResult.error.data
            ? { data: normalizationResult.error.data }
            : {}),
        });
        return;
      }

      // ========================================
      // STEP 3: Time Overlap Policy
      // ========================================
      // Event time overlaps are allowed. The client uses the read-only
      // /events/check-conflict endpoint to show a confirmation modal before
      // saving, but the server must not block creation because of overlaps.

      // ========================================
      // STEP 3.5: Pricing Validation (Paid Events Feature)
      // ========================================
      // Validate pricing data if provided
      const { validatePricing } =
        await import("../../utils/event/eventValidation");
      const pricingValidation = validatePricing(
        eventData.pricing as { isFree?: boolean; price?: number } | undefined,
      );

      if (!pricingValidation.valid) {
        res.status(400).json({
          success: false,
          message: pricingValidation.error || "Invalid pricing configuration",
        });
        return;
      }

      // ========================================
      // STEP 4: Role Preparation
      // ========================================
      // Prepare and validate event roles
      const rolePreparationResult = EventRolePreparationService.prepareRoles(
        eventData.roles,
      );

      if (!rolePreparationResult.valid && rolePreparationResult.error) {
        res.status(rolePreparationResult.error.status).json({
          success: false,
          message: rolePreparationResult.error.message,
          ...(rolePreparationResult.error.errors
            ? { errors: rolePreparationResult.error.errors }
            : {}),
        });
        return;
      }

      const eventRoles = rolePreparationResult.roles!;
      const totalSlots = rolePreparationResult.totalSlots!;

      // ========================================
      // STEP 5: Organizer Data Processing
      // ========================================
      // Process organizer details with placeholder pattern for contact info
      const processedOrganizerDetails =
        await EventOrganizerDataService.processOrganizerDetails(
          eventData.organizerDetails,
        );

      // ========================================
      // STEP 6: Program Linkage Validation
      // ========================================
      // Validate and prepare program linkage
      const programLinkageResult =
        await EventProgramLinkageService.validateAndLinkPrograms(
          rawProgramLabels,
          { _id: req.user!._id, role: req.user!.role },
          {
            requireProgramManagementAccess: !hasCreateEventPermission,
          },
        );

      if (!programLinkageResult.valid && programLinkageResult.error) {
        res.status(programLinkageResult.error.status).json({
          success: false,
          message: programLinkageResult.error.message,
          ...(programLinkageResult.error.data
            ? { data: programLinkageResult.error.data }
            : {}),
        });
        return;
      }

      const validatedProgramLabels =
        programLinkageResult.validatedProgramLabels!;
      const linkedPrograms = programLinkageResult.linkedPrograms!;

      // ========================================
      // STEP 6.5: Co-Organizer Program Access Validation
      // ========================================
      // Validate that all co-organizers have access to the event's paid programs
      const coOrganizerAccessResult =
        await CoOrganizerProgramAccessService.validateCoOrganizerAccess(
          processedOrganizerDetails as unknown as Parameters<
            typeof CoOrganizerProgramAccessService.validateCoOrganizerAccess
          >[0],
          validatedProgramLabels,
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

      // ========================================
      // STEP 7: Event Creation & Recurring Series Generation
      // ========================================
      // Helper to create an Event document from a payload
      // Accepts any object with EventData properties (flexible for recurring generation)
      const createAndSaveEvent = async (
        data: Record<string, unknown> & {
          title: string;
          date: string;
          time: string;
          endTime: string;
          hostedBy?: string;
        },
      ) => {
        // Ensure pricing is set - default to free if not provided
        const pricingData = (data.pricing as
          | { isFree?: boolean; price?: number }
          | undefined) || { isFree: true };

        const ev = new Event({
          ...data,
          pricing: pricingData,
          programLabels: validatedProgramLabels, // Override with validated ObjectIds
          organizerDetails: processedOrganizerDetails,
          roles: eventRoles,
          totalSlots,
          signedUp: 0,
          createdBy: req.user!._id,
          hostedBy: data.hostedBy || "@Cloud Marketplace Ministry",
          status: "upcoming",
        });
        await ev.save();

        // Generate public slug at creation time so the public page is always accessible
        ev.publicSlug = await generateUniquePublicSlug(ev.title);
        await ev.save();

        // Bidirectional linking: add event to program.events arrays
        await EventProgramLinkageService.linkEventToPrograms(
          ev._id,
          linkedPrograms,
        );

        return ev;
      };

      // Create first event
      const event = await createAndSaveEvent(eventData);

      // Build recurring series if requested
      let createdSeriesIds: string[] = [toIdString(event._id)];
      const validFrequencies = [
        "weekly",
        "biweekly",
        "every-two-weeks",
        "monthly",
        "every-two-months",
        "every-three-months",
      ];
      const isValidRecurring =
        !!recurring?.isRecurring &&
        validFrequencies.includes(recurring.frequency!) &&
        typeof recurring.occurrenceCount === "number" &&
        recurring.occurrenceCount > 1 &&
        recurring.occurrenceCount <= 24;

      if (isValidRecurring) {
        try {
          const result =
            await RecurringEventGenerationService.generateRecurringSeries(
              {
                isRecurring: recurring!.isRecurring!,
                frequency: recurring!.frequency!,
                occurrenceCount: recurring!.occurrenceCount!,
                recurrenceMode: recurring!.recurrenceMode,
                weekdayOrdinal: recurring!.weekdayOrdinal,
                weekday: recurring!.weekday,
              },
              eventData,
              event._id,
              createAndSaveEvent,
              req.user!,
            );
          createdSeriesIds = result.seriesIds;
        } catch (recurringError) {
          console.error("Failed to generate recurring series:", recurringError);
          // Continue with single event if recurring generation fails
        }
      }

      // ========================================
      // STEP 8: Notification Dispatch
      // ========================================
      const suppressNotifications =
        typeof (req.body as { suppressNotifications?: unknown })
          .suppressNotifications === "boolean"
          ? Boolean(
              (req.body as { suppressNotifications?: boolean })
                .suppressNotifications,
            )
          : false;

      // Send broadcast notifications (system messages & emails to all users)
      // These respect the suppressNotifications flag
      if (!suppressNotifications) {
        try {
          await EventCreationNotificationService.sendAllNotifications(
            event,
            eventData,
            req.user!,
            isValidRecurring
              ? {
                  isRecurring: recurring!.isRecurring!,
                  frequency: recurring!.frequency!,
                  occurrenceCount: recurring!.occurrenceCount!,
                  recurrenceMode: recurring!.recurrenceMode,
                }
              : undefined,
            toIdString,
          );
        } catch (notificationError) {
          console.error(
            "Failed to send broadcast notifications:",
            notificationError,
          );
          // Don't throw - continue with event creation
        }
      }

      // ALWAYS send co-organizer assignment notifications
      // These are mandatory responsibility notifications, not optional broadcasts
      try {
        await EventCreationNotificationService.sendCoOrganizerNotifications(
          event,
          req.user!,
          toIdString,
        );
      } catch (coOrgError) {
        console.error("Failed to send co-organizer notifications:", coOrgError);
        // Don't throw - continue with event creation
      }

      // ========================================
      // STEP 9: Cache Invalidation & Response Building
      // ========================================
      // Invalidate event-related caches since new event was created
      await CachePatterns.invalidateEventCache(
        toIdString(event._id),
      );
      await CachePatterns.invalidateAnalyticsCache();

      // Get populated event data for response
      let populatedEvent: unknown;
      try {
        populatedEvent =
          await ResponseBuilderService.buildEventWithRegistrations(
            toIdString(event._id),
            req.user ? toIdString(req.user._id) : undefined,
            (req.user as { role?: string } | undefined)?.role,
          );
      } catch (populationError) {
        console.error("Error populating event data:", populationError);
        populatedEvent = event; // fallback to raw event
      }
      // Additional safeguard: if population returned null/undefined, fall back to original event
      if (!populatedEvent) {
        populatedEvent = event;
      }

      // Ensure event object includes an id field for tests expecting data.event.id.
      const serializedEvent = ((): Record<string, unknown> => {
        // If populatedEvent is a Mongoose document with toJSON, call it; otherwise return as-is.
        if (
          populatedEvent &&
          typeof (populatedEvent as Record<string, unknown>).toJSON ===
            "function"
        ) {
          const docJson = (
            populatedEvent as { toJSON: () => Record<string, unknown> }
          ).toJSON();
          if (!docJson.id && docJson._id) {
            docJson.id = docJson._id.toString();
          }
          return docJson;
        }
        if (populatedEvent && typeof populatedEvent === "object") {
          // Mutate in place so unit tests comparing by object identity still pass
          const plain: Record<string, unknown> = populatedEvent as Record<
            string,
            unknown
          >;
          if (!plain.id && plain._id) {
            plain.id = plain._id.toString();
          }
          if (!plain.id) {
            plain.id = event._id.toString();
          }
          return plain;
        }
        return populatedEvent as Record<string, unknown>;
      })();
      res.status(201).json({
        success: true,
        message: "Event created successfully!",
        data: {
          event: serializedEvent,
          series: isValidRecurring ? createdSeriesIds : undefined,
        },
      });
    } catch (error: unknown) {
      console.error("Create event error:", error);
      CorrelatedLogger.fromRequest(req, "EventController").error(
        "createEvent failed",
        error as Error,
      );

      if (error instanceof AssignmentSnapshotError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }

      if (
        typeof error === "object" &&
        error !== null &&
        (error as { name?: unknown }).name === "ValidationError"
      ) {
        const validationErrors = Object.values(
          (error as { errors: Record<string, { message: string }> }).errors,
        ).map((err) => err.message);
        res.status(400).json({
          success: false,
          message: "Validation failed.",
          errors: validationErrors,
        });
        return;
      }

      res.status(500).json({
        success: false,
        message: "Failed to create event.",
      });
    }
  }
}
