import { Response } from "express";
import { IEvent } from "../../models";
import { toInstantFromWallClock } from "../../utils/event/timezoneUtils";

/**
 * Service for normalizing and validating event field updates
 * Handles:
 * - Field trimming and cleanup
 * - Date/time validation
 * - Format-specific field logic (Online/In-person/Hybrid)
 * - Timezone handling
 * - Time range validation
 */
export class FieldNormalizationService {
  /**
   * Normalizes and validates all event fields from update request
   * @param updateData The update data from request body
   * @param event The existing event being updated
   * @param eventId The event ID being updated
   * @param res Express response object (for early return on validation errors)
   * @returns Normalized updateData or undefined if validation failed (response already sent)
   */
  static async normalizeAndValidate(
    updateData: Record<string, unknown>,
    event: IEvent,
    eventId: string,
    res: Response
  ): Promise<Record<string, unknown> | undefined> {
    void eventId;

    // Normalize endDate if provided; default will be handled by schema if absent
    if (typeof updateData.endDate === "string") {
      updateData.endDate = updateData.endDate.trim();
    }

    // If time-related fields are being updated, validate the resulting range.
    // Event overlaps are confirm-only in the UI and do not block updates.
    const willUpdateStart =
      typeof updateData.date === "string" ||
      typeof updateData.time === "string";
    const willUpdateEnd =
      typeof updateData.endDate === "string" ||
      typeof updateData.endTime === "string";
    if (willUpdateStart || willUpdateEnd) {
      const newStartDate = (updateData.date as string) || event.date;
      const newStartTime = (updateData.time as string) || event.time;
      const newEndDate =
        (updateData.endDate as string) || event.endDate || newStartDate;
      const newEndTime =
        (updateData.endTime as string) || event.endTime || newStartTime;

      // Determine effective timezone for the event (updated or existing)
      const effectiveTz =
        (updateData.timeZone as string | undefined) || event.timeZone;

      const startObj = toInstantFromWallClock(
        newStartDate,
        newStartTime,
        effectiveTz
      );
      const endObj = toInstantFromWallClock(
        newEndDate,
        newEndTime,
        effectiveTz
      );
      if (endObj < startObj) {
        res.status(400).json({
          success: false,
          message: "Event end date/time must be after start date/time.",
        });
        return undefined;
      }
    }

    // Normalize virtual meeting fields similar to createEvent
    // Determine effective format after update
    const effectiveFormat = updateData.format || event.format;
    if (effectiveFormat === "In-person") {
      // Ensure these are cleared when switching to In-person
      updateData.zoomLink = undefined;
      updateData.meetingId = undefined;
      updateData.passcode = undefined;
    } else {
      if (typeof updateData.zoomLink === "string") {
        const v = (updateData.zoomLink as string).trim();
        updateData.zoomLink = v.length ? v : undefined;
      }
      if (typeof updateData.meetingId === "string") {
        const v = (updateData.meetingId as string).trim();
        updateData.meetingId = v.length ? v : undefined;
      }
      if (typeof updateData.passcode === "string") {
        const v = (updateData.passcode as string).trim();
        updateData.passcode = v.length ? v : undefined;
      }
    }

    // Server-side guard: normalize location for Online; trim when provided otherwise
    if (effectiveFormat === "Online") {
      updateData.location = "Online";
    } else if (typeof updateData.location === "string") {
      const loc = (updateData.location as string).trim();
      updateData.location = loc.length ? loc : undefined;
    }

    // Normalize flyerUrl on update
    if (typeof updateData.flyerUrl === "string") {
      const raw = (updateData.flyerUrl as string).trim();
      updateData.flyerUrl = raw.length ? raw : undefined;
    } else if (updateData.flyerUrl === null) {
      // Explicit null also removes flyerUrl
      updateData.flyerUrl = undefined;
    }

    // Normalize secondaryFlyerUrl on update
    if (typeof updateData.secondaryFlyerUrl === "string") {
      const raw = (updateData.secondaryFlyerUrl as string).trim();
      updateData.secondaryFlyerUrl = raw.length ? raw : undefined;
    } else if (updateData.secondaryFlyerUrl === null) {
      // Explicit null also removes secondaryFlyerUrl
      updateData.secondaryFlyerUrl = undefined;
    }

    // Normalize timeZone on update
    if (typeof updateData.timeZone === "string") {
      const tz = updateData.timeZone.trim();
      updateData.timeZone = tz.length ? tz : undefined;
    }

    // Validate that resulting end datetime is not before start
    const effectiveDate = updateData.date || event.date;
    const effectiveEndDate =
      updateData.endDate ||
      (event as unknown as { endDate?: string }).endDate ||
      event.date;
    const effectiveTime = updateData.time || event.time;
    const effectiveEndTime = updateData.endTime || event.endTime;
    const effStart = new Date(`${effectiveDate}T${effectiveTime}`);
    const effEnd = new Date(`${effectiveEndDate}T${effectiveEndTime}`);
    if (effEnd < effStart) {
      res.status(400).json({
        success: false,
        message: "Event end date/time must be after start date/time.",
      });
      return undefined;
    }

    // Return normalized data (validation passed)
    return updateData;
  }

  /**
   * Extracts and validates suppression flags from request body
   * @param body Request body
   * @returns suppressNotifications flag
   */
  static extractSuppressionFlags(body: unknown): {
    suppressNotifications: boolean;
  } {
    const suppressNotifications =
      typeof (body as { suppressNotifications?: unknown })
        .suppressNotifications === "boolean"
        ? Boolean(
            (body as { suppressNotifications?: boolean }).suppressNotifications
          )
        : false;

    return { suppressNotifications };
  }

  /**
   * Prepares updateData by removing control flags
   * @param body Request body
   * @returns Clean updateData without control flags
   */
  static prepareUpdateData(body: unknown): Record<string, unknown> {
    const updateData: Record<string, unknown> = { ...(body as object) };

    // Keep server-owned identity and persistence fields immutable.
    for (const field of [
      "suppressNotifications",
      "_id",
      "id",
      "createdBy",
      "createdAt",
      "updatedAt",
      "__v",
    ]) {
      delete updateData[field];
    }

    return updateData;
  }
}
