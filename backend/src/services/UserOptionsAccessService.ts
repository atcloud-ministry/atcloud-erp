import { Event, Program, Purchase, type IUser } from "../models";
import type { UserOptionsQuery } from "../contracts/userReadContracts";
import {
  hasPermission,
  PERMISSIONS,
  RoleUtils,
} from "../utils/roleUtils";
import {
  isAffiliatedProgramEditor,
  isEventOrganizer,
} from "../utils/event/eventPermissions";

export class UserOptionsAccessError extends Error {
  constructor(
    readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "UserOptionsAccessError";
  }
}

async function canEditProgram(programId: string, user: IUser): Promise<boolean> {
  const program = await Program.findById(programId).select(
    "createdBy mentors.userId adminEnrollments.classReps",
  );
  if (!program) {
    throw new UserOptionsAccessError(404, "Program not found.");
  }
  const userId = String(user._id);
  if (
    RoleUtils.isAdmin(user.role) ||
    String(program.createdBy) === userId ||
    program.mentors?.some(
      (mentor: { userId: unknown }) => String(mentor.userId) === userId,
    ) ||
    program.adminEnrollments?.classReps?.some(
      (id: unknown) => String(id) === userId,
    )
  ) {
    return true;
  }
  const purchase = await Purchase.findOne({
    purchaseType: "program",
    programId: program._id,
    userId: user._id,
    status: "completed",
    isClassRep: true,
    unenrolledAt: { $exists: false },
  }).select("_id");
  return !!purchase;
}

async function canEditEvent(eventId: string, user: IUser): Promise<boolean> {
  const event = await Event.findById(eventId).select(
    "createdBy organizerDetails.userId programLabels",
  );
  if (!event) {
    throw new UserOptionsAccessError(404, "Event not found.");
  }
  if (
    RoleUtils.isAdmin(user.role) ||
    hasPermission(user.role, PERMISSIONS.EDIT_ANY_EVENT)
  ) {
    return true;
  }

  const userId = String(user._id);
  if (isEventOrganizer(event, userId)) {
    return true;
  }
  return isAffiliatedProgramEditor(event, userId, user.role);
}

export class UserOptionsAccessService {
  static async assertCanRead(
    query: UserOptionsQuery,
    user: IUser,
  ): Promise<void> {
    let allowed: boolean;
    if (query.resourceId) {
      allowed =
        query.context === "program-mentor"
          ? await canEditProgram(query.resourceId, user)
          : await canEditEvent(query.resourceId, user);
    } else {
      allowed = hasPermission(user.role, PERMISSIONS.CREATE_EVENT);
    }

    if (!allowed) {
      throw new UserOptionsAccessError(
        403,
        `Insufficient permissions for ${query.context} user options.`,
      );
    }
  }
}
