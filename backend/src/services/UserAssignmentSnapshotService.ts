import mongoose from "mongoose";
import { User } from "../models";
import { ROLES } from "../utils/roleUtils";

type AssignmentUser = {
  _id: unknown;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  gender?: "male" | "female";
  avatar?: string;
  role?: string;
  roleInAtCloud?: string;
  isActive?: boolean;
  isVerified?: boolean;
};

type SubmittedAssignment = { userId?: unknown };

export class AssignmentSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentSnapshotError";
  }
}

const ELIGIBLE_ASSIGNMENT_ROLES = [
  ROLES.LEADER,
  ROLES.ADMINISTRATOR,
  ROLES.SUPER_ADMIN,
];

function submittedIds(assignments: unknown): string[] {
  if (!Array.isArray(assignments)) {
    throw new AssignmentSnapshotError("Assignments must be an array.");
  }
  const ids = assignments.map((assignment, index) => {
    if (!assignment || typeof assignment !== "object") {
      throw new AssignmentSnapshotError(
        `Assignment at index ${index} must include a valid userId.`,
      );
    }
    const id = String((assignment as SubmittedAssignment).userId ?? "");
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AssignmentSnapshotError(
        `Assignment at index ${index} must include a valid userId.`,
      );
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new AssignmentSnapshotError("Assignment userIds must be unique.");
  }
  return ids;
}

async function resolveUsers(
  assignments: unknown,
  existingUserIds: readonly string[],
): Promise<AssignmentUser[]> {
  const ids = submittedIds(assignments);
  if (ids.length === 0) return [];

  const rows = (await User.find({ _id: { $in: ids } })
    .select(
      "username email firstName lastName gender avatar role roleInAtCloud isActive isVerified",
    )
    .lean()) as unknown as AssignmentUser[];
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  const existing = new Set(existingUserIds.map(String));

  return ids.map((id) => {
    const user = byId.get(id);
    if (!user) {
      throw new AssignmentSnapshotError(`Selected user ${id} was not found.`);
    }
    const isNew = !existing.has(id);
    if (
      isNew &&
      (user.isActive !== true ||
        user.isVerified !== true ||
        !ELIGIBLE_ASSIGNMENT_ROLES.includes(
          user.role as (typeof ELIGIBLE_ASSIGNMENT_ROLES)[number],
        ))
    ) {
      throw new AssignmentSnapshotError(
        `Selected user ${id} is not eligible for this assignment.`,
      );
    }
    return user;
  });
}

export class UserAssignmentSnapshotService {
  static async resolveEventOrganizers(
    assignments: unknown,
    existingUserIds: readonly string[] = [],
  ) {
    const users = await resolveUsers(assignments, existingUserIds);
    return users.map((user) => ({
      userId: user._id,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
        user.username ||
        "Organizer",
      role: user.roleInAtCloud || user.role || ROLES.LEADER,
      avatar: user.avatar,
      gender: user.gender,
      email: "placeholder@example.com",
      phone: "Phone not provided",
    }));
  }

  static async resolveProgramMentors(
    assignments: unknown,
    existingUserIds: readonly string[] = [],
  ) {
    const users = await resolveUsers(assignments, existingUserIds);
    return users.map((user) => ({
      userId: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      gender: user.gender,
      avatar: user.avatar,
      roleInAtCloud: user.roleInAtCloud,
    }));
  }
}
