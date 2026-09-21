import mongoose from "mongoose";
import { Event, Program, Registration, GuestRegistration } from "../models";
import { CachePatterns } from "./infrastructure/CacheService";
import { resourceAuthorizationInvalidationService } from "./authorization/ResourceAuthorizationInvalidationService";

export class EventCascadeService {
  /**
   * Fully delete an event and all its associated data with cascade operations
   *
   * This method performs a complete deletion of an event including:
   * - All user registrations for the event
   * - All guest registrations for the event
   * - Removal from any linked program's events array
   * - The event document itself
   * - Cache invalidation for affected data
   *
   * @param eventId - MongoDB ObjectId of the event to delete
   * @returns Promise resolving to deletion counts for audit/reporting
   * @throws May log errors but continues deletion process for resilience
   *
   * @example
   * ```typescript
   * const result = await EventCascadeService.deleteEventFully("507f1f77bcf86cd799439011");
   * console.log(`Deleted ${result.deletedRegistrations} registrations and ${result.deletedGuestRegistrations} guest registrations`);
   * ```
   */
  static async deleteEventFully(eventId: string): Promise<{
    deletedRegistrations: number;
    deletedGuestRegistrations: number;
  }> {
    let deletedRegistrationsCount = 0;
    let deletedGuestRegistrationsCount = 0;

    // Always attempt to delete dependent documents (safe if none exist)
    try {
      const deletionResult = await Registration.deleteMany({ eventId });
      deletedRegistrationsCount = deletionResult.deletedCount || 0;
    } catch {
      // Continue but log in controller or upstream if desired
    }
    try {
      const guestDeletion = await GuestRegistration.deleteMany({ eventId });
      deletedGuestRegistrationsCount = guestDeletion.deletedCount || 0;
    } catch {
      // Continue but allow caller to log
    }

    // Pull event from any linked program.events array (defensive)
    try {
      // Fetch event to locate its programId
      const evt = await Event.findById(eventId).select("programId");
      const programIdVal = (evt as unknown as { programId?: unknown })
        ?.programId;
      if (programIdVal) {
        let eventIdForPull: mongoose.Types.ObjectId;
        if (mongoose.Types.ObjectId.isValid(eventId)) {
          try {
            eventIdForPull = new mongoose.Types.ObjectId(eventId);
          } catch {
            eventIdForPull = new mongoose.Types.ObjectId();
          }
        } else {
          eventIdForPull = new mongoose.Types.ObjectId();
        }
        await Program.updateOne(
          { _id: programIdVal as mongoose.Types.ObjectId | string },
          { $pull: { events: eventIdForPull } }
        );
      }
    } catch {
      // ignore pull errors — shouldn't block deletion
    }

    // Delete the event document itself
    await Event.findByIdAndDelete(eventId);
    resourceAuthorizationInvalidationService.invalidateEventRoom(eventId);

    // Invalidate caches
    try {
      await CachePatterns.invalidateEventCache(eventId);
      await CachePatterns.invalidateAnalyticsCache();
    } catch {}

    return {
      deletedRegistrations: deletedRegistrationsCount,
      deletedGuestRegistrations: deletedGuestRegistrationsCount,
    };
  }
}
