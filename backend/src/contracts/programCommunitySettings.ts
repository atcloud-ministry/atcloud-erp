export const PROGRAM_COMMUNITY_MEMBER_ROLES = [
  "mentee",
  "class_representative",
] as const;

export type ProgramCommunityMemberRole =
  (typeof PROGRAM_COMMUNITY_MEMBER_ROLES)[number];

export const PROGRAM_COMMUNITY_SETTINGS_LIMITS = Object.freeze({
  studentRoleId: 80,
  studentRoleMappings: 100,
});

const STUDENT_ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const UTC_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

export interface ProgramStudentRoleMappingDTO {
  readonly studentRoleId: string;
  readonly memberRole: ProgramCommunityMemberRole;
}

export interface ProgramCommunitySettingsDTO {
  readonly id: string | null;
  readonly programId: string;
  readonly primaryConversationId: string | null;
  readonly enabled: boolean;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly archivedAt: string | null;
  readonly studentRoleMappings: readonly ProgramStudentRoleMappingDTO[];
  readonly revision: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface UpdateProgramCommunitySettingsBody {
  readonly enabled: boolean;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  readonly studentRoleMappings: readonly ProgramStudentRoleMappingDTO[];
  readonly expectedRevision: number;
}

export interface ProgramCommunityOpenState {
  readonly enabled: boolean;
  readonly opensAt?: Date | string | null;
  readonly closesAt?: Date | string | null;
  readonly archivedAt?: Date | string | null;
}

export interface ProgramCommunitySettingsIssue {
  readonly path: string;
  readonly msg: string;
}

export class ProgramCommunitySettingsValidationError extends Error {
  readonly name = "ProgramCommunitySettingsValidationError";
  readonly code = "PROGRAM_COMMUNITY_SETTINGS_INPUT_INVALID";

  constructor(public readonly issues: readonly ProgramCommunitySettingsIssue[]) {
    super("Validation failed");
  }
}

type StrictObject = Readonly<Record<string, unknown>>;

function fail(path: string, msg: string): never {
  throw new ProgramCommunitySettingsValidationError([
    Object.freeze({ path, msg }),
  ]);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): StrictObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, `${path} must be an object`);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(path, `${path} must be a plain data object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, `${path} must be a plain data object`);
  }

  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(
        typeof key === "string" ? `${path}.${key}` : path,
        "Unknown field",
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return fail(`${path}.${key}`, "Accessor fields are not allowed");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function required(object: StrictObject, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    return fail(`${path}.${key}`, "Required field is missing");
  }
  return object[key];
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, `${path} must be a boolean`);
  return value;
}

function expectedRevision(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) >= Number.MAX_SAFE_INTEGER
  ) {
    return fail(path, `${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function nullableUtcInstant(value: unknown, path: string): Date | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    return fail(path, `${path} must be a UTC ISO-8601 instant or null`);
  }
  const match = UTC_INSTANT_PATTERN.exec(value);
  const base = match?.[1];
  const milliseconds = (match?.[2] ?? "").padEnd(3, "0");
  if (!base) {
    return fail(path, `${path} must be a UTC ISO-8601 instant or null`);
  }
  const canonical = `${base}.${milliseconds}Z`;
  const parsed = new Date(canonical);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== canonical
  ) {
    return fail(path, `${path} must be a valid UTC instant`);
  }
  return parsed;
}

function mappings(
  value: unknown,
  path: string,
): readonly ProgramStudentRoleMappingDTO[] {
  if (
    !Array.isArray(value) ||
    value.length > PROGRAM_COMMUNITY_SETTINGS_LIMITS.studentRoleMappings
  ) {
    return fail(
      path,
      `${path} must contain at most ${PROGRAM_COMMUNITY_SETTINGS_LIMITS.studentRoleMappings} mappings`,
    );
  }

  const seen = new Set<string>();
  return Object.freeze(
    value.map((entry, index) => {
      const entryPath = `${path}[${index}]`;
      const object = strictObject(entry, entryPath, [
        "studentRoleId",
        "memberRole",
      ]);
      const rawStudentRoleId = required(object, "studentRoleId", entryPath);
      const memberRole = required(object, "memberRole", entryPath);
      if (
        typeof rawStudentRoleId !== "string" ||
        rawStudentRoleId !== rawStudentRoleId.trim() ||
        !STUDENT_ROLE_ID_PATTERN.test(rawStudentRoleId)
      ) {
        return fail(
          `${entryPath}.studentRoleId`,
          "studentRoleId must be a canonical Program role identifier",
        );
      }
      if (
        !PROGRAM_COMMUNITY_MEMBER_ROLES.includes(
          memberRole as ProgramCommunityMemberRole,
        )
      ) {
        return fail(
          `${entryPath}.memberRole`,
          "memberRole must be mentee or class_representative",
        );
      }
      if (seen.has(rawStudentRoleId)) {
        return fail(
          `${entryPath}.studentRoleId`,
          "Each studentRoleId may be mapped only once",
        );
      }
      seen.add(rawStudentRoleId);
      return Object.freeze({
        studentRoleId: rawStudentRoleId,
        memberRole: memberRole as ProgramCommunityMemberRole,
      });
    }),
  );
}

export function parseUpdateProgramCommunitySettingsBody(
  value: unknown,
): UpdateProgramCommunitySettingsBody {
  const object = strictObject(value, "body", [
    "enabled",
    "opensAt",
    "closesAt",
    "studentRoleMappings",
    "expectedRevision",
  ]);
  const result = {
    enabled: boolean(required(object, "enabled", "body"), "body.enabled"),
    opensAt: nullableUtcInstant(
      required(object, "opensAt", "body"),
      "body.opensAt",
    ),
    closesAt: nullableUtcInstant(
      required(object, "closesAt", "body"),
      "body.closesAt",
    ),
    studentRoleMappings: mappings(
      required(object, "studentRoleMappings", "body"),
      "body.studentRoleMappings",
    ),
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
  };

  if (result.enabled && !result.opensAt) {
    return fail("body.opensAt", "An enabled Program Room requires opensAt");
  }
  if (result.closesAt && !result.opensAt) {
    return fail("body.opensAt", "closesAt requires opensAt");
  }
  if (
    result.opensAt &&
    result.closesAt &&
    result.closesAt.getTime() <= result.opensAt.getTime()
  ) {
    return fail("body.closesAt", "closesAt must be after opensAt");
  }
  return Object.freeze(result);
}

function instant(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  const match = UTC_INSTANT_PATTERN.exec(value);
  const base = match?.[1];
  if (!base) return null;
  const canonical = `${base}.${(match?.[2] ?? "").padEnd(3, "0")}Z`;
  const parsed = new Date(canonical);
  const timestamp = parsed.getTime();
  return Number.isNaN(timestamp) || parsed.toISOString() !== canonical
    ? null
    : timestamp;
}

/** The single predicate used by HTTP, membership sync, and reconciliation. */
export function isProgramCommunityOpen(
  settings: ProgramCommunityOpenState,
  now: Date = new Date(),
): boolean {
  const nowTime = now.getTime();
  const opensAt = instant(settings.opensAt);
  const closesAt = instant(settings.closesAt);
  if (
    (settings.opensAt != null && opensAt === null) ||
    (settings.closesAt != null && closesAt === null) ||
    (settings.archivedAt != null && instant(settings.archivedAt) === null)
  ) {
    return false;
  }
  return (
    settings.enabled === true &&
    Number.isFinite(nowTime) &&
    opensAt !== null &&
    opensAt <= nowTime &&
    (closesAt === null || nowTime < closesAt) &&
    settings.archivedAt == null
  );
}
