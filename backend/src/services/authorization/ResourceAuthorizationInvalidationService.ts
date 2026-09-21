import { Types } from "mongoose";
import { Event } from "../../models";
import { socketService } from "../infrastructure/SocketService";

function uniqueObjectIds(values: readonly unknown[]): Types.ObjectId[] {
  const ids = new Set(
    values
      .map((value) => {
        if (value && typeof value === "object" && "_id" in value) {
          return String((value as { _id: unknown })._id);
        }
        return String(value);
      })
      .filter((value) => Types.ObjectId.isValid(value)),
  );
  return Array.from(ids, (id) => new Types.ObjectId(id));
}

/**
 * Coordinates persisted access-policy changes with live Socket.IO rooms.
 * Event ids are resolved before a multi-document mutation, then invalidated
 * immediately after that mutation succeeds.
 */
export class ResourceAuthorizationInvalidationService {
  async findEventIdsForPrograms(programIds: readonly unknown[]): Promise<string[]> {
    const ids = uniqueObjectIds(programIds);
    if (ids.length === 0) return [];

    const events = await Event.find({
      programLabels: { $in: ids },
    })
      .select("_id")
      .lean();

    return Array.from(
      new Set(
        events
          .map((event) => String(event._id))
          .filter((eventId) => Types.ObjectId.isValid(eventId)),
      ),
    );
  }

  invalidateEventRoom(eventId: string): boolean {
    return socketService.invalidateResourceRoom("event", eventId);
  }

  invalidateEventRooms(eventIds: readonly string[]): void {
    new Set(eventIds).forEach((eventId) => {
      this.invalidateEventRoom(eventId);
    });
  }
}

export const resourceAuthorizationInvalidationService =
  new ResourceAuthorizationInvalidationService();
