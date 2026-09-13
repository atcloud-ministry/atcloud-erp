import mongoose, { type ClientSession, type Model } from "mongoose";
import Program, { type IProgram } from "../../models/Program";
import Purchase, { type IPurchase } from "../../models/Purchase";
import {
  LEGACY_CLASS_REP_ROLE_ID,
  LEGACY_MENTEE_ROLE_ID,
  normalizeProgramRoles,
  type NormalizedProgramStudentRole,
  type ProgramRoleSource,
} from "../../utils/programRoles";

export type LegacyProgramPurchaseRoleCandidate =
  | {
      readonly status: "resolved";
      readonly studentRoleId: string;
    }
  | {
      readonly status: "ambiguous" | "unavailable";
      readonly studentRoleId?: never;
    };

export type CanonicalProgramPurchaseRoleResolution =
  | Readonly<{
      status: "resolved";
      studentRoleId: string;
      studentRoleName: string;
    }>
  | Readonly<{ status: "ambiguous" | "unavailable" }>;

export interface ProgramPurchaseRolePreflightDiagnostics {
  readonly effectivePurchases: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly missingStudentRoleId: number;
  readonly invalidStudentRoleId: number;
  readonly autoResolvable: number;
  readonly ambiguous: number;
  readonly unavailable: number;
}

interface RoleStateBucket {
  readonly _id: {
    readonly roleState: "resolved" | "missing" | "invalid";
    readonly legacyFlag: "class_representative" | "mentee" | "invalid";
  };
  readonly count: number;
}

export interface ProgramPurchaseRolePreflightServiceDependencies {
  readonly programModel?: Model<IProgram>;
  readonly purchaseModel?: Model<IPurchase>;
}

export class ProgramPurchaseRolePreflightError extends Error {
  readonly name = "ProgramPurchaseRolePreflightError";
  readonly code = "PROGRAM_PURCHASE_ROLE_PREFLIGHT_FAILED";

  constructor(
    public readonly diagnostics: ProgramPurchaseRolePreflightDiagnostics,
  ) {
    super("Effective Program purchases contain unresolved student roles.");
  }
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function candidateFromRoles(
  roles: readonly NormalizedProgramStudentRole[],
  isClassRep: boolean,
): LegacyProgramPurchaseRoleCandidate {
  const categoryRoles = roles.filter(
    (role) => role.discountEligible === isClassRep,
  );
  const legacyIds = isClassRep
    ? new Set([LEGACY_CLASS_REP_ROLE_ID, "class-rep"])
    : new Set([LEGACY_MENTEE_ROLE_ID]);
  const legacyMatches = categoryRoles.filter((role) => legacyIds.has(role.id));

  if (legacyMatches.length === 1) {
    return Object.freeze({
      status: "resolved",
      studentRoleId: legacyMatches[0]!.id,
    });
  }
  if (legacyMatches.length > 1 || categoryRoles.length > 1) {
    return Object.freeze({ status: "ambiguous" });
  }
  if (categoryRoles.length === 1) {
    return Object.freeze({
      status: "resolved",
      studentRoleId: categoryRoles[0]!.id,
    });
  }
  return Object.freeze({ status: "unavailable" });
}

/**
 * Resolves only deterministic legacy binary-role evidence. A current explicit
 * Purchase role remains authoritative and is assessed separately by preflight.
 */
export function resolveLegacyProgramPurchaseRoleCandidate(
  program: ProgramRoleSource,
  isClassRep: boolean,
): LegacyProgramPurchaseRoleCandidate {
  return candidateFromRoles(
    normalizeProgramRoles(program).studentRoles,
    isClassRep,
  );
}

/**
 * Resolves the canonical Program role that must be persisted before a pending
 * purchase may become effective. A still-valid explicit role wins; legacy
 * binary evidence is accepted only when it identifies exactly one role.
 */
export function resolveCanonicalProgramPurchaseRole(
  program: ProgramRoleSource,
  purchase: Readonly<{
    studentRoleId?: unknown;
    isClassRep?: unknown;
  }>,
): CanonicalProgramPurchaseRoleResolution {
  const roles = normalizeProgramRoles(program).studentRoles;
  const explicitRoleId =
    typeof purchase.studentRoleId === "string" &&
    purchase.studentRoleId === purchase.studentRoleId.trim()
      ? purchase.studentRoleId
      : "";
  const explicitRole = roles.find((role) => role.id === explicitRoleId);
  if (explicitRole) {
    return Object.freeze({
      status: "resolved",
      studentRoleId: explicitRole.id,
      studentRoleName: explicitRole.name,
    });
  }
  if (typeof purchase.isClassRep !== "boolean") {
    return Object.freeze({ status: "unavailable" });
  }
  const legacy = resolveLegacyProgramPurchaseRoleCandidate(
    program,
    purchase.isClassRep,
  );
  if (legacy.status !== "resolved") return legacy;
  const resolvedRole = roles.find((role) => role.id === legacy.studentRoleId);
  return resolvedRole
    ? Object.freeze({
        status: "resolved",
        studentRoleId: resolvedRole.id,
        studentRoleName: resolvedRole.name,
      })
    : Object.freeze({ status: "unavailable" });
}

function emptyDiagnostics(): ProgramPurchaseRolePreflightDiagnostics {
  return {
    effectivePurchases: 0,
    resolved: 0,
    unresolved: 0,
    missingStudentRoleId: 0,
    invalidStudentRoleId: 0,
    autoResolvable: 0,
    ambiguous: 0,
    unavailable: 0,
  };
}

function requireTransaction(session: ClientSession): void {
  let active = false;
  try {
    active = session.inTransaction();
  } catch {
    active = false;
  }
  if (!active) {
    throw new TypeError("Program purchase role preflight requires a transaction.");
  }
}

/** Aggregate-only gate used before a Program Room can be provisioned. */
export class ProgramPurchaseRolePreflightService {
  private readonly programs: Model<IProgram>;
  private readonly purchases: Model<IPurchase>;

  constructor(
    dependencies: ProgramPurchaseRolePreflightServiceDependencies = {},
  ) {
    this.programs = dependencies.programModel ?? Program;
    this.purchases = dependencies.purchaseModel ?? Purchase;
  }

  async inspectInTransaction(
    programId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<ProgramPurchaseRolePreflightDiagnostics> {
    requireTransaction(session);
    if (!(programId instanceof mongoose.Types.ObjectId)) {
      throw new TypeError("Program purchase role preflight requires a Program ID.");
    }

    const program = await this.programs
      .findById(programId)
      .select("programRoles classRepDiscount classRepLimit classRepCount")
      .session(session);
    if (!program) {
      const diagnostics = Object.freeze({
        ...emptyDiagnostics(),
        unresolved: 1,
        unavailable: 1,
      });
      throw new ProgramPurchaseRolePreflightError(diagnostics);
    }

    const roles = normalizeProgramRoles(program).studentRoles;
    const validRoleIds = roles.map((role) => role.id);
    const buckets = await this.purchases
      .aggregate<RoleStateBucket>([
        {
          $match: {
            programId,
            purchaseType: "program",
            status: "completed",
            unenrolledAt: { $exists: false },
          },
        },
        {
          $project: {
            roleType: { $type: "$studentRoleId" },
            studentRoleId: 1,
            isClassRep: 1,
          },
        },
        {
          $set: {
            trimmedStudentRoleId: {
              $cond: [
                { $eq: ["$roleType", "string"] },
                { $trim: { input: "$studentRoleId" } },
                null,
              ],
            },
          },
        },
        {
          $project: {
            roleState: {
              $switch: {
                branches: [
                  {
                    case: {
                      $and: [
                        { $eq: ["$roleType", "string"] },
                        { $in: ["$studentRoleId", validRoleIds] },
                      ],
                    },
                    then: "resolved",
                  },
                  {
                    case: {
                      $or: [
                        { $eq: ["$roleType", "missing"] },
                        { $eq: ["$studentRoleId", null] },
                        { $eq: ["$trimmedStudentRoleId", ""] },
                      ],
                    },
                    then: "missing",
                  },
                ],
                default: "invalid",
              },
            },
            legacyFlag: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$isClassRep", true] },
                    then: "class_representative",
                  },
                  {
                    case: { $eq: ["$isClassRep", false] },
                    then: "mentee",
                  },
                ],
                default: "invalid",
              },
            },
          },
        },
        {
          $group: {
            _id: {
              roleState: "$roleState",
              legacyFlag: "$legacyFlag",
            },
            count: { $sum: 1 },
          },
        },
      ])
      .session(session);

    const diagnostics = { ...emptyDiagnostics() };
    const candidates = {
      class_representative: candidateFromRoles(roles, true),
      mentee: candidateFromRoles(roles, false),
    } as const;

    for (const bucket of buckets) {
      const count = safeCount(bucket.count);
      diagnostics.effectivePurchases += count;
      if (bucket._id.roleState === "resolved") {
        diagnostics.resolved += count;
        continue;
      }

      diagnostics.unresolved += count;
      if (bucket._id.roleState === "missing") {
        diagnostics.missingStudentRoleId += count;
      } else {
        diagnostics.invalidStudentRoleId += count;
      }

      if (bucket._id.legacyFlag === "invalid") {
        diagnostics.unavailable += count;
        continue;
      }
      const candidate = candidates[bucket._id.legacyFlag];
      if (candidate.status === "resolved") {
        diagnostics.autoResolvable += count;
      } else if (candidate.status === "ambiguous") {
        diagnostics.ambiguous += count;
      } else {
        diagnostics.unavailable += count;
      }
    }

    return Object.freeze(diagnostics);
  }

  async assertResolvedInTransaction(
    programId: mongoose.Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const diagnostics = await this.inspectInTransaction(programId, session);
    if (diagnostics.unresolved !== 0) {
      throw new ProgramPurchaseRolePreflightError(diagnostics);
    }
  }
}

export const programPurchaseRolePreflightService =
  new ProgramPurchaseRolePreflightService();
