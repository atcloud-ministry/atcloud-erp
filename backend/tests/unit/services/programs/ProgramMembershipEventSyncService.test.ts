import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramMembershipEventSyncService } from "../../../../src/services/programs/ProgramMembershipEventSyncService";

const PROGRAM_A = new mongoose.Types.ObjectId("64f000000000000000000001");
const PROGRAM_B = new mongoose.Types.ObjectId("64f000000000000000000002");
const PROGRAM_C = new mongoose.Types.ObjectId("64f000000000000000000003");
const USER_ID = new mongoose.Types.ObjectId("64f000000000000000000011");

function result(programId: string) {
  return {
    programId,
    conversationId: new mongoose.Types.ObjectId().toString(),
    resolutionState: "open" as const,
    paused: false,
    roomProvisioned: false,
    desiredMemberships: 0,
    createdMemberships: 0,
    updatedRoles: 0,
    unchangedMemberships: 0,
    ignoredPurchasesMissingStudentRoleId: 0,
    ignoredPurchasesUnmappedStudentRoleId: 0,
    deferredRevocations: 0,
    deferredReactivations: 0,
  };
}

describe("ProgramMembershipEventSyncService", () => {
  let dataSource: { findProgramIdsForUser: ReturnType<typeof vi.fn> };
  let sync: { reconcileProgram: ReturnType<typeof vi.fn> };
  let service: ProgramMembershipEventSyncService;

  beforeEach(() => {
    dataSource = {
      findProgramIdsForUser: vi
        .fn()
        .mockResolvedValue([PROGRAM_A.toString(), PROGRAM_B.toString()]),
    };
    sync = {
      reconcileProgram: vi
        .fn()
        .mockImplementation(async (programId: mongoose.Types.ObjectId) =>
          result(programId.toString()),
        ),
    };
    service = new ProgramMembershipEventSyncService({
      dataSource,
      sync: sync as any,
    });
  });

  it("treats assignment and settings events as scope hints for a full reconcile", async () => {
    const context = { correlationId: "request-2" };

    await service.programAssignmentsChanged(PROGRAM_A, context);
    await service.communitySettingsChanged(PROGRAM_B, context);

    expect(sync.reconcileProgram).toHaveBeenNthCalledWith(
      1,
      PROGRAM_A,
      context,
    );
    expect(sync.reconcileProgram).toHaveBeenNthCalledWith(
      2,
      PROGRAM_B,
      context,
    );
  });

  it("syncs only direct Program purchase events", async () => {
    await expect(
      service.programPurchaseChanged({
        purchaseType: "membership",
        programId: PROGRAM_A,
      }),
    ).resolves.toEqual({ programIds: [], results: [] });
    await expect(
      service.programPurchaseChanged({
        purchaseType: "event",
        programId: PROGRAM_A,
      }),
    ).resolves.toEqual({ programIds: [], results: [] });
    expect(sync.reconcileProgram).not.toHaveBeenCalled();

    const programResult = await service.programPurchaseChanged({
      purchaseType: "program",
      programId: PROGRAM_A,
    });
    expect(programResult.programIds).toEqual([PROGRAM_A.toString()]);
    expect(sync.reconcileProgram).toHaveBeenCalledTimes(1);
  });

  it("discovers and sequentially reconciles every Program affected by an account change", async () => {
    const order: string[] = [];
    sync.reconcileProgram.mockImplementation(async (programId) => {
      order.push(String(programId));
      return result(String(programId));
    });
    const context = {
      actor: { type: "system" as const, key: "account-state-change" },
      source: "system" as const,
    };

    const value = await service.userEligibilityChanged(USER_ID, context);

    expect(dataSource.findProgramIdsForUser).toHaveBeenCalledWith(USER_ID);
    expect(order).toEqual([PROGRAM_A.toString(), PROGRAM_B.toString()]);
    expect(sync.reconcileProgram).toHaveBeenNthCalledWith(
      1,
      PROGRAM_A.toString(),
      context,
    );
    expect(sync.reconcileProgram).toHaveBeenNthCalledWith(
      2,
      PROGRAM_B.toString(),
      context,
    );
    expect(value.programIds).toEqual([
      PROGRAM_A.toString(),
      PROGRAM_B.toString(),
    ]);
  });

  it("stops a user-scope pass when a Program reports a runtime pause", async () => {
    dataSource.findProgramIdsForUser.mockResolvedValue([
      PROGRAM_A.toString(),
      PROGRAM_B.toString(),
      PROGRAM_C.toString(),
    ]);
    sync.reconcileProgram
      .mockResolvedValueOnce(result(PROGRAM_A.toString()))
      .mockResolvedValueOnce({
        ...result(PROGRAM_B.toString()),
        conversationId: null,
        resolutionState: "runtime_unavailable",
        paused: true,
      });

    const value = await service.userEligibilityChanged(USER_ID);

    expect(sync.reconcileProgram).toHaveBeenCalledTimes(2);
    expect(value.programIds).toEqual([
      PROGRAM_A.toString(),
      PROGRAM_B.toString(),
    ]);
    expect(value.results).toHaveLength(2);
    expect(value.results[1]).toMatchObject({ paused: true });
  });

  it("rejects malformed internal event scopes", async () => {
    await expect(
      service.programAssignmentsChanged("not-an-id"),
    ).rejects.toThrow("valid ObjectId");
    await expect(service.userEligibilityChanged("not-an-id")).rejects.toThrow(
      "valid ObjectId",
    );
  });
});
