export type ProgramMentorPayload = {
  userId: string;
};

type IdCarrier = {
  id?: unknown;
  _id?: unknown;
};

export type ProgramMentorSource = {
  id?: unknown;
  _id?: unknown;
  userId?: unknown;
  firstName?: string;
  lastName?: string;
  email?: string;
  gender?: "male" | "female";
  avatar?: string | null;
  roleInAtCloud?: string;
};

const isIdCarrier = (value: unknown): value is IdCarrier =>
  typeof value === "object" &&
  value !== null &&
  ("id" in value || "_id" in value);

const stringifyId = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (isIdCarrier(value)) {
    return stringifyId(value.id ?? value._id);
  }

  const valueAsString = String(value).trim();
  return valueAsString === "[object Object]" ? "" : valueAsString;
};

export const getProgramMentorUserId = (
  mentor: ProgramMentorSource,
): string => stringifyId(mentor.userId ?? mentor.id ?? mentor._id);

export const toProgramMentorPayload = (
  mentor: ProgramMentorSource,
): ProgramMentorPayload | null => {
  const userId = getProgramMentorUserId(mentor);
  if (!userId) return null;

  return { userId };
};

export const toProgramMentorPayloads = (
  mentors: ProgramMentorSource[],
): ProgramMentorPayload[] =>
  mentors
    .map(toProgramMentorPayload)
    .filter((mentor): mentor is ProgramMentorPayload => mentor !== null);
