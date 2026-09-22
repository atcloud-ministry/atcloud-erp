export const DEFAULT_TEACHER_ROLE_NAME = "Mentor";
export const LEGACY_MENTEE_ROLE_ID = "mentee";
export const LEGACY_CLASS_REP_ROLE_ID = "classRep";

export type ProgramStudentRoleShape = {
  id?: unknown;
  name?: unknown;
  discountEligible?: unknown;
  discountAmount?: unknown;
  limit?: unknown;
  count?: unknown;
};

export type ProgramRolesShape = {
  teacherRoleName?: unknown;
  studentRoles?: ProgramStudentRoleShape[] | unknown;
};

export type ProgramRoleSource = {
  programRoles?: ProgramRolesShape | null;
  classRepDiscount?: unknown;
  classRepLimit?: unknown;
  classRepCount?: unknown;
};

export type NormalizedProgramStudentRole = {
  id: string;
  name: string;
  discountEligible: boolean;
  discountAmount: number;
  limit: number;
  count: number;
};

export type NormalizedProgramRoles = {
  teacherRoleName: string;
  studentRoles: NormalizedProgramStudentRole[];
};

function toSafeInteger(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

function toTrimmedString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function slugifyRoleId(value: string, fallback: string): string {
  // Existing purchases use this legacy ID; keep it stable across Program edits.
  if (value.trim() === LEGACY_CLASS_REP_ROLE_ID) {
    return LEGACY_CLASS_REP_ROLE_ID;
  }
  const slug = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

export function buildLegacyProgramRoles(
  source: ProgramRoleSource,
): NormalizedProgramRoles {
  const classRepDiscount = toSafeInteger(source.classRepDiscount);
  const classRepLimit = toSafeInteger(source.classRepLimit);
  const classRepCount = toSafeInteger(source.classRepCount);

  return {
    teacherRoleName: DEFAULT_TEACHER_ROLE_NAME,
    studentRoles: [
      {
        id: LEGACY_MENTEE_ROLE_ID,
        name: "Mentee",
        discountEligible: false,
        discountAmount: 0,
        limit: 0,
        count: 0,
      },
      {
        id: LEGACY_CLASS_REP_ROLE_ID,
        name: "Class Representative",
        discountEligible: true,
        discountAmount: classRepDiscount,
        limit: classRepLimit,
        count: classRepCount,
      },
    ],
  };
}

export function normalizeProgramRoles(
  source: ProgramRoleSource,
): NormalizedProgramRoles {
  const roles = source.programRoles;
  const rawStudentRoles = Array.isArray(roles?.studentRoles)
    ? roles.studentRoles
    : [];

  if (rawStudentRoles.length === 0) {
    return buildLegacyProgramRoles(source);
  }

  const teacherRoleName = toTrimmedString(
    roles?.teacherRoleName,
    DEFAULT_TEACHER_ROLE_NAME,
  );
  const usedIds = new Set<string>();
  const studentRoles = rawStudentRoles.map((rawRole, index) => {
    const rawName =
      typeof rawRole.name === "string" && rawRole.name.trim()
        ? rawRole.name.trim()
        : index === 0
          ? "Mentee"
          : `Student Role ${index + 1}`;
    const baseId =
      typeof rawRole.id === "string" && rawRole.id.trim()
        ? slugifyRoleId(rawRole.id, `student-role-${index + 1}`)
        : slugifyRoleId(rawName, `student-role-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    const discountEligible = rawRole.discountEligible === true;

    return {
      id,
      name: rawName,
      discountEligible,
      discountAmount: discountEligible
        ? toSafeInteger(rawRole.discountAmount)
        : 0,
      limit: discountEligible ? toSafeInteger(rawRole.limit) : 0,
      count: discountEligible ? toSafeInteger(rawRole.count) : 0,
    };
  });

  return { teacherRoleName, studentRoles };
}

export function getDiscountStudentRole(
  roles: NormalizedProgramRoles,
): NormalizedProgramStudentRole | undefined {
  return roles.studentRoles.find((role) => role.discountEligible);
}

export function getStudentRoleByRequest(
  roles: NormalizedProgramRoles,
  requestedRoleId?: unknown,
  legacyIsClassRep?: unknown,
): NormalizedProgramStudentRole {
  const requested =
    typeof requestedRoleId === "string" ? requestedRoleId.trim() : "";
  if (requested) {
    const match = roles.studentRoles.find((role) => role.id === requested);
    if (match) return match;
  }

  if (legacyIsClassRep === true) {
    return (
      roles.studentRoles.find((role) => role.discountEligible) ||
      roles.studentRoles.find((role) => role.id === LEGACY_CLASS_REP_ROLE_ID) ||
      roles.studentRoles[0]
    );
  }

  return (
    roles.studentRoles.find((role) => !role.discountEligible) ||
    roles.studentRoles[0]
  );
}

export function syncLegacyProgramPricingFields(target: {
  programRoles?: ProgramRolesShape | NormalizedProgramRoles;
  classRepDiscount?: number;
  classRepLimit?: number;
  classRepCount?: number;
}): void {
  const roles = normalizeProgramRoles(target);
  const discountRole = getDiscountStudentRole(roles);
  const existingCount = toSafeInteger(
    target.classRepCount ?? discountRole?.count ?? 0,
  );
  const firstDiscountRoleId = discountRole?.id;

  target.programRoles = {
    teacherRoleName: roles.teacherRoleName,
    studentRoles: roles.studentRoles.map((role) => ({
      ...role,
      count:
        role.discountEligible && role.id === firstDiscountRoleId
          ? existingCount
          : role.count,
    })),
  };
  target.classRepDiscount = discountRole?.discountAmount ?? 0;
  target.classRepLimit = discountRole?.limit ?? 0;
  target.classRepCount = existingCount;
}

export function getDiscountRoleIndex(roles: NormalizedProgramRoles): number {
  return roles.studentRoles.findIndex((role) => role.discountEligible);
}

export function getStudentRoleIndexById(
  roles: NormalizedProgramRoles,
  roleId?: unknown,
): number {
  if (typeof roleId !== "string" || !roleId.trim()) {
    return -1;
  }
  return roles.studentRoles.findIndex((role) => role.id === roleId.trim());
}

export function buildDiscountRoleCountIncrement(
  source: ProgramRoleSource,
  amount: number,
  roleId?: unknown,
): Record<string, number> {
  const increment: Record<string, number> = {};
  const roles = normalizeProgramRoles(source);
  const requestedIndex = getStudentRoleIndexById(roles, roleId);
  const firstDiscountIndex = getDiscountRoleIndex(roles);
  const index =
    requestedIndex >= 0 && roles.studentRoles[requestedIndex].discountEligible
      ? requestedIndex
      : firstDiscountIndex;
  if (index < 0 || index === firstDiscountIndex) {
    increment.classRepCount = amount;
  }
  if (index >= 0) {
    increment[`programRoles.studentRoles.${index}.count`] = amount;
  }
  return increment;
}
