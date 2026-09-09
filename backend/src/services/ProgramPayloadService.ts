import {
  normalizeProgramRoles,
  type ProgramRoleSource,
} from "../utils/programRoles";

const PROGRAM_MUTABLE_FIELDS = [
  "title",
  "programType",
  "hostedBy",
  "period",
  "introduction",
  "flyerUrl",
  "zoomLink",
  "meetingId",
  "passcode",
  "earlyBirdDeadline",
  "isFree",
  "mentors",
  "programRoles",
  "fullPriceTicket",
  "classRepDiscount",
  "earlyBirdDiscount",
  "classRepLimit",
] as const;

export function selectMutableProgramFields(
  body: unknown,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  const source = body as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const field of PROGRAM_MUTABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      selected[field] = source[field];
    }
  }
  return selected;
}

function normalizeSubmittedProgramRoles(submittedProgramRoles: unknown) {
  if (
    !submittedProgramRoles ||
    typeof submittedProgramRoles !== "object" ||
    Array.isArray(submittedProgramRoles)
  ) {
    throw new Error("Program roles must be an object.");
  }

  const submitted = submittedProgramRoles as Record<string, unknown>;
  if (
    !Array.isArray(submitted.studentRoles) ||
    submitted.studentRoles.length === 0
  ) {
    throw new Error("Program studentRoles must be a non-empty array.");
  }

  for (const [index, role] of submitted.studentRoles.entries()) {
    if (!role || typeof role !== "object" || Array.isArray(role)) {
      throw new Error(`Student role at index ${index} must be an object.`);
    }
    const submittedRole = role as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(
        submittedRole,
        "discountEligible",
      ) &&
      typeof submittedRole.discountEligible !== "boolean"
    ) {
      throw new Error(
        `Student role at index ${index} must use a boolean discountEligible value.`,
      );
    }
  }

  return normalizeProgramRoles({ programRoles: submitted });
}

export function initializeProgramRoleCounts(
  submittedProgramRoles: unknown,
): unknown {
  const normalizedSubmitted = normalizeSubmittedProgramRoles(
    submittedProgramRoles,
  );

  return {
    teacherRoleName: normalizedSubmitted.teacherRoleName,
    studentRoles: normalizedSubmitted.studentRoles.map((role) => ({
      ...role,
      count: 0,
    })),
  };
}

export function preserveProgramRoleCounts(
  program: ProgramRoleSource,
  submittedProgramRoles: unknown,
): unknown {
  const normalizedSubmitted = normalizeSubmittedProgramRoles(
    submittedProgramRoles,
  );

  const currentRoles = normalizeProgramRoles(program).studentRoles;
  const currentCounts = new Map(
    currentRoles.map((role) => [role.id, role.count]),
  );
  const submittedById = new Map(
    normalizedSubmitted.studentRoles.map((role) => [role.id, role]),
  );

  for (const currentRole of currentRoles) {
    if (currentRole.count <= 0) continue;
    const submittedRole = submittedById.get(currentRole.id);
    if (!submittedRole) {
      throw new Error(
        `Student role ${currentRole.id} cannot be removed while it has active enrollments.`,
      );
    }
    if (submittedRole.discountEligible !== currentRole.discountEligible) {
      throw new Error(
        `Student role ${currentRole.id} discount eligibility cannot change while it has active enrollments.`,
      );
    }
  }

  const studentRoles = normalizedSubmitted.studentRoles.map((role) => ({
    ...role,
    count: currentCounts.get(role.id) ?? 0,
  }));
  const firstDiscountRole = studentRoles.find(
    (role) => role.discountEligible,
  );
  program.classRepCount = firstDiscountRole
    ? (currentCounts.get(firstDiscountRole.id) ?? 0)
    : 0;

  return {
    teacherRoleName: normalizedSubmitted.teacherRoleName,
    studentRoles,
  };
}
