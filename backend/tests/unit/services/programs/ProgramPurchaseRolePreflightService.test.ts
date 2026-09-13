import mongoose, { type ClientSession, type Model } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import Program, { type IProgram } from "../../../../src/models/Program";
import type { IPurchase } from "../../../../src/models/Purchase";
import {
  ProgramPurchaseRolePreflightError,
  ProgramPurchaseRolePreflightService,
  resolveCanonicalProgramPurchaseRole,
  resolveLegacyProgramPurchaseRoleCandidate,
} from "../../../../src/services/programs/ProgramPurchaseRolePreflightService";

const PROGRAM_ID = new mongoose.Types.ObjectId("650000000000000000000001");
const SESSION = { inTransaction: () => true } as ClientSession;

function programWithRoles(
  roles?: Array<{
    id: string;
    name: string;
    discountEligible: boolean;
  }>,
): IProgram {
  return new Program({
    _id: PROGRAM_ID,
    title: "Historical Program",
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: new mongoose.Types.ObjectId(),
    ...(roles
      ? { programRoles: { teacherRoleName: "Mentor", studentRoles: roles } }
      : {}),
  });
}

function query<T>(value: T) {
  const resolved = Promise.resolve(value);
  const chain = {
    select: vi.fn(() => chain),
    session: vi.fn(() => chain),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  return chain;
}

describe("legacy Program purchase student-role candidate", () => {
  it("uses the exact legacy defaults for Programs without explicit roles", () => {
    const program = programWithRoles();

    expect(resolveLegacyProgramPurchaseRoleCandidate(program, false)).toEqual({
      status: "resolved",
      studentRoleId: "mentee",
    });
    expect(resolveLegacyProgramPurchaseRoleCandidate(program, true)).toEqual({
      status: "resolved",
      studentRoleId: "classRep",
    });
  });

  it("uses a unique category role and prefers a legacy role when present", () => {
    const unique = programWithRoles([
      { id: "participant", name: "Participant", discountEligible: false },
      { id: "representative", name: "Representative", discountEligible: true },
    ]);
    expect(resolveLegacyProgramPurchaseRoleCandidate(unique, false)).toEqual({
      status: "resolved",
      studentRoleId: "participant",
    });
    expect(resolveLegacyProgramPurchaseRoleCandidate(unique, true)).toEqual({
      status: "resolved",
      studentRoleId: "representative",
    });

    const legacyPreferred = programWithRoles([
      { id: "mentee", name: "Mentee", discountEligible: false },
      { id: "observer", name: "Observer", discountEligible: false },
    ]);
    expect(
      resolveLegacyProgramPurchaseRoleCandidate(legacyPreferred, false),
    ).toEqual({ status: "resolved", studentRoleId: "mentee" });
  });

  it("fails closed for ambiguous or unavailable legacy evidence", () => {
    const ambiguous = programWithRoles([
      { id: "participant", name: "Participant", discountEligible: false },
      { id: "observer", name: "Observer", discountEligible: false },
    ]);
    expect(resolveLegacyProgramPurchaseRoleCandidate(ambiguous, false)).toEqual({
      status: "ambiguous",
    });
    expect(resolveLegacyProgramPurchaseRoleCandidate(ambiguous, true)).toEqual({
      status: "unavailable",
    });
  });

  it("keeps a valid explicit role and only repairs missing roles from unique legacy evidence", () => {
    const program = programWithRoles([
      { id: "participant", name: "Participant", discountEligible: false },
      { id: "observer", name: "Observer", discountEligible: false },
      {
        id: "representative",
        name: "Representative",
        discountEligible: true,
      },
    ]);

    expect(
      resolveCanonicalProgramPurchaseRole(program, {
        studentRoleId: "observer",
        isClassRep: false,
      }),
    ).toEqual({
      status: "resolved",
      studentRoleId: "observer",
      studentRoleName: "Observer",
    });
    expect(
      resolveCanonicalProgramPurchaseRole(program, { isClassRep: false }),
    ).toEqual({ status: "ambiguous" });
    expect(
      resolveCanonicalProgramPurchaseRole(program, { isClassRep: true }),
    ).toEqual({
      status: "resolved",
      studentRoleId: "representative",
      studentRoleName: "Representative",
    });
  });
});

describe("ProgramPurchaseRolePreflightService", () => {
  it("returns aggregate-only diagnostics and rejects any persisted unresolved row", async () => {
    const aggregateResult = [
      {
        _id: { roleState: "resolved", legacyFlag: "mentee" },
        count: 4,
      },
      {
        _id: { roleState: "missing", legacyFlag: "mentee" },
        count: 2,
      },
      {
        _id: { roleState: "invalid", legacyFlag: "invalid" },
        count: 1,
      },
    ];
    const aggregate = vi.fn(() => ({
      session: vi.fn().mockResolvedValue(aggregateResult),
    }));
    const service = new ProgramPurchaseRolePreflightService({
      programModel: {
        findById: vi.fn(() =>
          query(
            programWithRoles([
              {
                id: "participant",
                name: "Participant",
                discountEligible: false,
              },
            ]),
          ),
        ),
      } as unknown as Model<IProgram>,
      purchaseModel: { aggregate } as unknown as Model<IPurchase>,
    });

    const diagnostics = await service.inspectInTransaction(PROGRAM_ID, SESSION);
    expect(diagnostics).toEqual({
      effectivePurchases: 7,
      resolved: 4,
      unresolved: 3,
      missingStudentRoleId: 2,
      invalidStudentRoleId: 1,
      autoResolvable: 2,
      ambiguous: 0,
      unavailable: 1,
    });
    await expect(
      service.assertResolvedInTransaction(PROGRAM_ID, SESSION),
    ).rejects.toMatchObject({
      code: "PROGRAM_PURCHASE_ROLE_PREFLIGHT_FAILED",
      diagnostics,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /email|name|order|purchaseId|userId/iu,
    );
  });

  it("requires a transaction and treats a missing Program as unavailable", async () => {
    const missingService = new ProgramPurchaseRolePreflightService({
      programModel: {
        findById: vi.fn(() => query(null)),
      } as unknown as Model<IProgram>,
      purchaseModel: { aggregate: vi.fn() } as unknown as Model<IPurchase>,
    });

    await expect(
      missingService.inspectInTransaction(
        PROGRAM_ID,
        { inTransaction: () => false } as ClientSession,
      ),
    ).rejects.toThrow("requires a transaction");
    await expect(
      missingService.inspectInTransaction(PROGRAM_ID, SESSION),
    ).rejects.toBeInstanceOf(ProgramPurchaseRolePreflightError);
  });
});
