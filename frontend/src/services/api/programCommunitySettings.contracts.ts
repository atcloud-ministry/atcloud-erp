export const PROGRAM_COMMUNITY_MEMBER_ROLES = [
  "mentee",
  "class_representative",
] as const;

export type ProgramCommunityMemberRole =
  (typeof PROGRAM_COMMUNITY_MEMBER_ROLES)[number];

export const PROGRAM_COMMUNITY_SETTINGS_MAX_ROLE_MAPPINGS = 100;

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

export interface UpdateProgramCommunitySettingsInput {
  readonly enabled: boolean;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly studentRoleMappings: readonly ProgramStudentRoleMappingDTO[];
  readonly expectedRevision: number;
}

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${path} contains an invalid response shape`);
  }
}

function objectId(value: unknown, path: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${path} must be an ObjectId`);
  }
  return value.toLowerCase();
}

function instant(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !UTC_INSTANT_PATTERN.test(value) ||
    Number.isNaN(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${path} must be a canonical UTC instant or null`);
  }
  return value;
}

export function decodeProgramCommunitySettings(
  value: unknown,
): ProgramCommunitySettingsDTO {
  const envelope = record(value, "data");
  exactKeys(envelope, ["settings"], "data");
  const settings = record(envelope.settings, "data.settings");
  exactKeys(
    settings,
    [
      "id",
      "programId",
      "primaryConversationId",
      "enabled",
      "opensAt",
      "closesAt",
      "archivedAt",
      "studentRoleMappings",
      "revision",
      "createdAt",
      "updatedAt",
    ],
    "data.settings",
  );
  if (typeof settings.enabled !== "boolean") {
    throw new Error("data.settings.enabled must be a boolean");
  }
  if (!Number.isSafeInteger(settings.revision) || Number(settings.revision) < 0) {
    throw new Error("data.settings.revision must be a non-negative integer");
  }
  if (
    !Array.isArray(settings.studentRoleMappings) ||
    settings.studentRoleMappings.length >
      PROGRAM_COMMUNITY_SETTINGS_MAX_ROLE_MAPPINGS
  ) {
    throw new Error(
      `data.settings.studentRoleMappings must be an array with at most ${PROGRAM_COMMUNITY_SETTINGS_MAX_ROLE_MAPPINGS} entries`,
    );
  }
  const seen = new Set<string>();
  const studentRoleMappings = settings.studentRoleMappings.map(
    (entry, index) => {
      const mapping = record(
        entry,
        `data.settings.studentRoleMappings[${index}]`,
      );
      exactKeys(
        mapping,
        ["studentRoleId", "memberRole"],
        `data.settings.studentRoleMappings[${index}]`,
      );
      if (
        typeof mapping.studentRoleId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(mapping.studentRoleId) ||
        seen.has(mapping.studentRoleId)
      ) {
        throw new Error("Program community response contains an invalid role mapping");
      }
      if (
        !PROGRAM_COMMUNITY_MEMBER_ROLES.includes(
          mapping.memberRole as ProgramCommunityMemberRole,
        )
      ) {
        throw new Error("Program community response contains an invalid member role");
      }
      seen.add(mapping.studentRoleId);
      return Object.freeze({
        studentRoleId: mapping.studentRoleId,
        memberRole: mapping.memberRole as ProgramCommunityMemberRole,
      });
    },
  );

  const decoded = {
    id: objectId(settings.id, "data.settings.id", true),
    programId: objectId(settings.programId, "data.settings.programId")!,
    primaryConversationId: objectId(
      settings.primaryConversationId,
      "data.settings.primaryConversationId",
      true,
    ),
    enabled: settings.enabled,
    opensAt: instant(settings.opensAt, "data.settings.opensAt"),
    closesAt: instant(settings.closesAt, "data.settings.closesAt"),
    archivedAt: instant(settings.archivedAt, "data.settings.archivedAt"),
    studentRoleMappings: Object.freeze(studentRoleMappings),
    revision: Number(settings.revision),
    createdAt: instant(settings.createdAt, "data.settings.createdAt"),
    updatedAt: instant(settings.updatedAt, "data.settings.updatedAt"),
  };
  if (decoded.enabled && (!decoded.opensAt || !decoded.primaryConversationId)) {
    throw new Error("Enabled Program community settings are incomplete");
  }
  if (decoded.closesAt && !decoded.opensAt) {
    throw new Error("Program community response has an invalid date range");
  }
  if (
    decoded.opensAt &&
    decoded.closesAt &&
    new Date(decoded.closesAt).getTime() <= new Date(decoded.opensAt).getTime()
  ) {
    throw new Error("Program community response has an invalid date range");
  }
  return Object.freeze(decoded);
}
