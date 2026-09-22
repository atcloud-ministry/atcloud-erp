import type {
  ProgramRoles,
  ProgramStudentRole,
  ProgramStudentRoleForm,
} from "../types/program";

export const DEFAULT_TEACHER_ROLE_NAME = "Mentor";
export const DEFAULT_STUDENT_ROLES: ProgramStudentRoleForm[] = [
  {
    id: "mentee",
    name: "Mentee",
    discountEligible: false,
    discountAmount: 0,
    limit: 0,
  },
  {
    id: "classRep",
    name: "Class Representative",
    discountEligible: true,
    discountAmount: 0,
    limit: 0,
  },
];

type ProgramRoleSource = {
  programRoles?: Partial<ProgramRoles>;
  classRepDiscount?: number;
  classRepLimit?: number;
  classRepCount?: number;
};

const cleanRoleId = (value: string, fallback: string) => {
  // Existing purchases use this legacy ID; keep it stable across Program edits.
  if (value.trim() === "classRep") return "classRep";
  const id = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || fallback;
};

export function createStudentRoleForm(index: number): ProgramStudentRoleForm {
  return {
    id: `student-role-${Date.now()}-${index}`,
    name: `Student Role ${index + 1}`,
    discountEligible: false,
    discountAmount: 0,
    limit: 0,
  };
}

export function normalizeProgramRoles(source: ProgramRoleSource): ProgramRoles {
  const rawRoles = source.programRoles?.studentRoles;
  if (!rawRoles || rawRoles.length === 0) {
    return {
      teacherRoleName:
        source.programRoles?.teacherRoleName?.trim() ||
        DEFAULT_TEACHER_ROLE_NAME,
      studentRoles: [
        {
          id: "mentee",
          name: "Mentee",
          discountEligible: false,
          discountAmount: 0,
          limit: 0,
          count: 0,
        },
        {
          id: "classRep",
          name: "Class Representative",
          discountEligible: true,
          discountAmount: source.classRepDiscount || 0,
          limit: source.classRepLimit || 0,
          count: source.classRepCount || 0,
        },
      ],
    };
  }

  return {
    teacherRoleName:
      source.programRoles?.teacherRoleName?.trim() || DEFAULT_TEACHER_ROLE_NAME,
    studentRoles: rawRoles.map((role, index) => {
      const discountEligible = !!role.discountEligible;
      return {
        id: role.id || `student-role-${index + 1}`,
        name: role.name?.trim() || `Student Role ${index + 1}`,
        discountEligible,
        discountAmount: discountEligible ? role.discountAmount || 0 : 0,
        limit: discountEligible ? role.limit || 0 : 0,
        count: discountEligible ? role.count || 0 : 0,
      };
    }),
  };
}

export function rolesToFormRoles(
  source: ProgramRoleSource,
): ProgramStudentRoleForm[] {
  return normalizeProgramRoles(source).studentRoles.map((role) => ({
    ...role,
    discountAmount: (role.discountAmount || 0) / 100,
  }));
}

export function buildProgramRolesPayload(params: {
  teacherRoleName?: string;
  studentRoles?: ProgramStudentRoleForm[];
}): ProgramRoles {
  const roles =
    params.studentRoles && params.studentRoles.length > 0
      ? params.studentRoles
      : DEFAULT_STUDENT_ROLES;
  const usedIds = new Set<string>();

  return {
    teacherRoleName:
      params.teacherRoleName?.trim() || DEFAULT_TEACHER_ROLE_NAME,
    studentRoles: roles.map((role, index) => {
      const name = role.name.trim() || `Student Role ${index + 1}`;
      const baseId = cleanRoleId(role.id || name, `student-role-${index + 1}`);
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);

      const discountEligible = !!role.discountEligible;

      return {
        id,
        name,
        discountEligible,
        discountAmount: discountEligible
          ? Math.round(Number(role.discountAmount || 0) * 100)
          : 0,
        limit: discountEligible ? Math.max(0, Math.round(role.limit || 0)) : 0,
        count: role.count || 0,
      };
    }),
  };
}

export function getDiscountStudentRole(
  roles?: ProgramRoles,
): ProgramStudentRole | undefined {
  return roles?.studentRoles.find((role) => role.discountEligible);
}

export function getDefaultStudentRole(
  roles?: ProgramRoles,
): ProgramStudentRole | undefined {
  return (
    roles?.studentRoles.find((role) => !role.discountEligible) ||
    roles?.studentRoles[0]
  );
}
