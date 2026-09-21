import { UserAssignmentSnapshotService } from "../UserAssignmentSnapshotService";

interface IncomingOrganizerData {
  userId?: unknown;
  name?: string;
  role?: string;
  avatar?: string;
  gender?: "male" | "female";
}

/** Resolves organizer snapshots from authoritative User records. */
export class EventOrganizerDataService {
  /**
   * Process organizer details for event creation
   *
   * Stores only essential organizer information with placeholder contact details.
   * Contact details (email, phone) are ALWAYS fetched fresh from User collection
   * in getEventById to prevent stale data.
   *
   * @param organizerDetails - Array of organizer data from request body
   * @returns Processed organizer details with placeholders for contact info
   */
  static async processOrganizerDetails(
    organizerDetails?: IncomingOrganizerData[],
  ) {
    return UserAssignmentSnapshotService.resolveEventOrganizers(
      organizerDetails ?? [],
    );
  }
}
