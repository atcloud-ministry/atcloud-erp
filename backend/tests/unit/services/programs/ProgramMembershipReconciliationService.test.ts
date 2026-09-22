import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import {
  EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
  PROGRAM_MEMBERSHIP_RECONCILIATION_CAPACITY,
  ProgramMembershipReconciliationService,
} from "../../../../src/services/programs/ProgramMembershipReconciliationService";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const PROGRAM_IDS = Array.from(
  { length: 6 },
  (_, index) =>
    new mongoose.Types.ObjectId(
      `64d0000000000000000000${String(index + 1).padStart(2, "0")}`,
    ),
);
const SETTING_IDS = Array.from(
  { length: 6 },
  (_, index) =>
    new mongoose.Types.ObjectId(
      `64e0000000000000000000${String(index + 1).padStart(2, "0")}`,
    ),
);
const ANOMALY_IDS = Array.from(
  { length: 4 },
  (_, index) =>
    new mongoose.Types.ObjectId(
      `64f0000000000000000000${String(index + 1).padStart(2, "0")}`,
    ),
);
const RUN_CONTEXT = {
  source: "worker",
  runId: "run-1",
  trigger: "scheduled",
  principal: {
    kind: "service",
    serviceKey: "program-membership-reconciler",
    capabilities: ["program.membership.reconcile"],
    runId: "run-1",
  },
} as any;

function syncResult(programId: mongoose.Types.ObjectId) {
  return {
    programId: programId.toString(),
    conversationId: new mongoose.Types.ObjectId().toString(),
    resolutionState: "open" as const,
    paused: false,
    roomProvisioned: false,
    roomArchived: false,
    desiredMemberships: 1,
    createdMemberships: 1,
    updatedRoles: 0,
    closedMemberships: 0,
    reactivatedMemberships: 0,
    unchangedMemberships: 0,
    ignoredPurchasesMissingStudentRoleId: 0,
    ignoredPurchasesUnmappedStudentRoleId: 0,
    deferredRevocations: 0,
    deferredReactivations: 0,
  };
}

function settingsModel(rows: Array<{ _id: mongoose.Types.ObjectId; programId: mongoose.Types.ObjectId }>) {
  return {
    find: vi.fn((filter: { _id?: { $gt?: mongoose.Types.ObjectId } }) => {
      let maximum = Number.MAX_SAFE_INTEGER;
      const chain: any = {
        select: vi.fn(() => chain),
        sort: vi.fn(() => chain),
        limit: vi.fn((value: number) => {
          maximum = value;
          return chain;
        }),
        lean: vi.fn(() => chain),
        exec: vi.fn(async () => {
          const after = filter._id?.$gt;
          return rows
            .filter((row) => !after || row._id.toString() > after.toString())
            .slice(0, maximum);
        }),
      };
      return chain;
    }),
  };
}

describe("ProgramMembershipReconciliationService", () => {
  let sync: { reconcileProgram: ReturnType<typeof vi.fn> };
  let authorization: { assertCapability: ReturnType<typeof vi.fn> };
  let runtimeReader: { getOperationalRuntimeConfig: ReturnType<typeof vi.fn> };
  let anomalyCandidateLoader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sync = {
      reconcileProgram: vi
        .fn()
        .mockImplementation(async (programId: mongoose.Types.ObjectId) =>
          syncResult(programId),
        ),
    };
    authorization = {
      assertCapability: vi.fn().mockResolvedValue(undefined),
    };
    runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
    };
    anomalyCandidateLoader = vi.fn().mockResolvedValue([]);
  });

  it("publishes the approved bounded-capacity envelope", () => {
    expect(PROGRAM_MEMBERSHIP_RECONCILIATION_CAPACITY).toEqual({
      baselinePrograms: 500,
      baselineSimultaneouslyOpenPrograms: 50,
      defaultLimit: 25,
      maximumLimit: 100,
      cadenceMs: 60_000,
      baselineMaximumSweepMinutes: 2,
    });
  });

  it("advances a stable cursor so every open Program is reconciled without starvation", async () => {
    const rows = PROGRAM_IDS.slice(0, 5).map((programId, index) => ({
      _id: SETTING_IDS[index],
      programId,
    }));
    const model = settingsModel(rows);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const first = await service.runBounded(RUN_CONTEXT);
    const second = await service.runBounded(RUN_CONTEXT);
    const third = await service.runBounded(RUN_CONTEXT);

    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([
      true,
      true,
      false,
    ]);
    expect(sync.reconcileProgram.mock.calls.map(([id]) => String(id))).toEqual(
      PROGRAM_IDS.slice(0, 5).map(String),
    );
    expect(model.find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        _id: { $gt: SETTING_IDS[1] },
      }),
    );
    expect(model.find).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        _id: { $gt: SETTING_IDS[3] },
      }),
    );
    expect(first.createdMemberships).toBe(2);
    expect(third.candidatesScanned).toBe(1);
  });

  it("returns caller-owned settings checkpoints without changing the scheduler sweep", async () => {
    const rows = PROGRAM_IDS.slice(0, 5).map((programId, index) => ({
      _id: SETTING_IDS[index]!,
      programId,
    }));
    const model = settingsModel(rows);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const first = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    );
    const second = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      first.checkpoint,
    );
    const third = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      second.checkpoint,
    );

    expect(first).toMatchObject({
      result: { candidatesScanned: 2, hasMore: true },
      checkpoint: {
        settingsAfterId: SETTING_IDS[1]!.toHexString(),
        anomalyAfterId: null,
      },
    });
    expect(second).toMatchObject({
      result: { candidatesScanned: 2, hasMore: true },
      checkpoint: {
        settingsAfterId: SETTING_IDS[3]!.toHexString(),
        anomalyAfterId: null,
      },
    });
    expect(third).toMatchObject({
      result: { candidatesScanned: 1, hasMore: false },
      checkpoint: EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    });
    expect(model.find).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ _id: { $gt: SETTING_IDS[1] } }),
    );
    expect(model.find).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ _id: { $gt: SETTING_IDS[3] } }),
    );

    await service.runBounded(RUN_CONTEXT);
    expect(model.find.mock.calls[3]![0]).not.toHaveProperty("_id");
  });

  it("returns a separately persisted anomaly checkpoint", async () => {
    const anomalyRows = PROGRAM_IDS.slice(0, 4).map((programId, index) => ({
      _id: ANOMALY_IDS[index]!,
      programId,
    }));
    anomalyCandidateLoader.mockImplementation(
      async (afterId: mongoose.Types.ObjectId | null, limit: number) =>
        anomalyRows
          .filter(
            (candidate) =>
              !afterId ||
              candidate._id.toHexString() > afterId.toHexString(),
          )
          .slice(0, limit),
    );
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: settingsModel([]) as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const first = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    );
    const second = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      first.checkpoint,
    );

    expect(first.checkpoint).toEqual({
      settingsAfterId: null,
      anomalyAfterId: ANOMALY_IDS[1]!.toHexString(),
    });
    expect(second.checkpoint).toEqual(
      EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    );
    expect(anomalyCandidateLoader).toHaveBeenNthCalledWith(1, null, 3);
    expect(anomalyCandidateLoader).toHaveBeenNthCalledWith(
      2,
      ANOMALY_IDS[1],
      3,
    );
  });

  it("does not wrap a persisted checkpoint when remaining candidates disappear", async () => {
    const rows = PROGRAM_IDS.slice(0, 3).map((programId, index) => ({
      _id: SETTING_IDS[index]!,
      programId,
    }));
    const model = settingsModel(rows);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const first = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    );
    rows.splice(0, rows.length);
    const exhausted = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      first.checkpoint,
    );

    expect(first).toMatchObject({
      result: { hasMore: true },
      checkpoint: {
        settingsAfterId: SETTING_IDS[1]!.toHexString(),
        anomalyAfterId: null,
      },
    });
    expect(exhausted).toMatchObject({
      result: { candidatesScanned: 0, hasMore: false },
      checkpoint: EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    });
    expect(model.find).toHaveBeenCalledTimes(2);
    expect(model.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: { $gt: SETTING_IDS[1] } }),
    );
  });

  it("does not wrap a persisted anomaly checkpoint when anomalies disappear", async () => {
    const anomalyRows = PROGRAM_IDS.slice(0, 3).map((programId, index) => ({
      _id: ANOMALY_IDS[index]!,
      programId,
    }));
    anomalyCandidateLoader.mockImplementation(
      async (afterId: mongoose.Types.ObjectId | null, limit: number) =>
        anomalyRows
          .filter(
            (candidate) =>
              !afterId ||
              candidate._id.toHexString() > afterId.toHexString(),
          )
          .slice(0, limit),
    );
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: settingsModel([]) as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const first = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    );
    anomalyRows.splice(0, anomalyRows.length);
    const exhausted = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      first.checkpoint,
    );

    expect(first.checkpoint.anomalyAfterId).toBe(
      ANOMALY_IDS[1]!.toHexString(),
    );
    expect(exhausted).toMatchObject({
      result: { candidatesScanned: 0, hasMore: false },
      checkpoint: EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    });
    expect(anomalyCandidateLoader).toHaveBeenCalledTimes(2);
    expect(anomalyCandidateLoader).toHaveBeenLastCalledWith(ANOMALY_IDS[1], 3);
  });

  it("keeps an unvisited settings sweep pending when anomalies fill the pass", async () => {
    anomalyCandidateLoader.mockResolvedValue(
      PROGRAM_IDS.slice(0, 2).map((programId, index) => ({
        _id: ANOMALY_IDS[index]!,
        programId,
      })),
    );
    const model = settingsModel([
      { _id: SETTING_IDS[0]!, programId: PROGRAM_IDS[2]! },
    ]);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const run = await service.runBoundedFromCheckpoint(
      RUN_CONTEXT,
      EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    );

    expect(run).toMatchObject({
      result: { candidatesScanned: 2, hasMore: true },
      checkpoint: EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
    });
    expect(model.find).toHaveBeenCalledOnce();
  });

  it("keeps a supplied checkpoint unchanged when the runtime is paused", async () => {
    runtimeReader.getOperationalRuntimeConfig.mockResolvedValue(
      createRuntimeConfigDTO("read_only", 2),
    );
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: settingsModel([]) as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });
    const checkpoint = {
      settingsAfterId: SETTING_IDS[0]!.toHexString().toUpperCase(),
      anomalyAfterId: ANOMALY_IDS[0]!.toHexString().toUpperCase(),
    };

    const run = await service.runBoundedFromCheckpoint(RUN_CONTEXT, checkpoint);

    expect(run).toMatchObject({
      result: { paused: true, candidatesScanned: 0 },
      checkpoint: {
        settingsAfterId: SETTING_IDS[0]!.toHexString(),
        anomalyAfterId: ANOMALY_IDS[0]!.toHexString(),
      },
    });
    expect(authorization.assertCapability).toHaveBeenCalledWith(
      RUN_CONTEXT,
      "program.membership.reconcile",
      expect.any(Object),
    );
    expect(anomalyCandidateLoader).not.toHaveBeenCalled();
  });

  it("retains the prior external checkpoint when a candidate races", async () => {
    sync.reconcileProgram
      .mockRejectedValueOnce(new Error("raced"))
      .mockResolvedValueOnce(syncResult(PROGRAM_IDS[2]!));
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 2,
      settingsModel: settingsModel([
        { _id: SETTING_IDS[1]!, programId: PROGRAM_IDS[1]! },
        { _id: SETTING_IDS[2]!, programId: PROGRAM_IDS[2]! },
      ]) as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });
    const checkpoint = {
      settingsAfterId: SETTING_IDS[0]!.toHexString(),
      anomalyAfterId: null,
    };

    const run = await service.runBoundedFromCheckpoint(RUN_CONTEXT, checkpoint);

    expect(run).toMatchObject({
      result: {
        candidatesScanned: 2,
        reconciledPrograms: 1,
        racedOrUnavailable: 1,
        hasMore: true,
      },
      checkpoint,
    });
  });

  it("rejects malformed external checkpoints before reconciliation", async () => {
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: settingsModel([]) as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    await expect(
      service.runBoundedFromCheckpoint(RUN_CONTEXT, {
        settingsAfterId: "not-an-object-id",
        anomalyAfterId: null,
      } as any),
    ).rejects.toThrow("settings checkpoint must be a 24-character ObjectId");
    expect(authorization.assertCapability).not.toHaveBeenCalled();
    expect(anomalyCandidateLoader).not.toHaveBeenCalled();
  });

  it("authorizes every run and passes a fixed worker audit context to sync", async () => {
    const model = settingsModel([
      { _id: SETTING_IDS[0], programId: PROGRAM_IDS[0] },
    ]);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    await service.runBounded(RUN_CONTEXT);

    expect(authorization.assertCapability).toHaveBeenCalledWith(
      RUN_CONTEXT,
      "program.membership.reconcile",
      {
        resource: { type: "program_membership", id: "open-programs" },
      },
    );
    expect(sync.reconcileProgram).toHaveBeenCalledWith(
      PROGRAM_IDS[0],
      expect.objectContaining({
        actor: {
          type: "worker",
          key: "program-membership-reconciler",
        },
        source: "worker",
        correlationId: "run-1",
        runtimePermit: expect.any(Object),
      }),
    );
    expect(sync.reconcileProgram.mock.calls[0]?.[1]).not.toHaveProperty("now");
  });

  it("isolates one failed candidate and aggregates migration diagnostics", async () => {
    const model = settingsModel([
      { _id: SETTING_IDS[0], programId: PROGRAM_IDS[0] },
      { _id: SETTING_IDS[1], programId: PROGRAM_IDS[1] },
    ]);
    sync.reconcileProgram
      .mockRejectedValueOnce(new Error("raced"))
      .mockResolvedValueOnce({
        ...syncResult(PROGRAM_IDS[1]),
        createdMemberships: 2,
        updatedRoles: 1,
        closedMemberships: 2,
        reactivatedMemberships: 1,
        roomArchived: true,
        ignoredPurchasesMissingStudentRoleId: 3,
        ignoredPurchasesUnmappedStudentRoleId: 4,
        deferredRevocations: 5,
        deferredReactivations: 6,
      });
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const result = await service.runBounded(RUN_CONTEXT);

    expect(result).toMatchObject({
      candidatesScanned: 2,
      reconciledPrograms: 1,
      createdMemberships: 2,
      updatedRoles: 1,
      closedMemberships: 2,
      reactivatedMemberships: 1,
      archivedRooms: 1,
      ignoredPurchasesMissingStudentRoleId: 3,
      ignoredPurchasesUnmappedStudentRoleId: 4,
      deferredRevocations: 5,
      deferredReactivations: 6,
      racedOrUnavailable: 1,
      hasMore: false,
    });
  });

  it("stops on a low-level runtime pause and resumes from that candidate", async () => {
    const rows = PROGRAM_IDS.slice(0, 3).map((programId, index) => ({
      _id: SETTING_IDS[index],
      programId,
    }));
    const model = settingsModel(rows);
    sync.reconcileProgram
      .mockResolvedValueOnce(syncResult(PROGRAM_IDS[0]))
      .mockResolvedValueOnce({
        ...syncResult(PROGRAM_IDS[1]),
        conversationId: null,
        resolutionState: "runtime_unavailable",
        paused: true,
        createdMemberships: 0,
      });
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const paused = await service.runBounded(RUN_CONTEXT);

    expect(paused).toMatchObject({
      paused: true,
      candidatesScanned: 2,
      reconciledPrograms: 1,
      createdMemberships: 1,
      racedOrUnavailable: 0,
      hasMore: true,
    });
    expect(sync.reconcileProgram.mock.calls.map(([id]) => String(id))).toEqual([
      PROGRAM_IDS[0]?.toString(),
      PROGRAM_IDS[1]?.toString(),
    ]);

    const resumed = await service.runBounded(RUN_CONTEXT);

    expect(resumed.paused).toBe(false);
    expect(sync.reconcileProgram.mock.calls.map(([id]) => String(id))).toEqual([
      PROGRAM_IDS[0]?.toString(),
      PROGRAM_IDS[1]?.toString(),
      PROGRAM_IDS[0]?.toString(),
      PROGRAM_IDS[1]?.toString(),
      PROGRAM_IDS[2]?.toString(),
    ]);
    expect(model.find).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      _id: expect.anything(),
    }));
  });

  it("rejects limits above the fixed Flex-safe maximum", () => {
    expect(
      () =>
        new ProgramMembershipReconciliationService({
          limit: 101,
          settingsModel: settingsModel([]) as any,
          sync: sync as any,
          authorization: authorization as any,
          runtimeReader,
          anomalyCandidateLoader,
        }),
    ).toThrow("must be an integer from 1 to 100");
  });

  it("selects durable pending, revision-drift, disabled, due, and archived repair states", async () => {
    const model = settingsModel([]);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    await service.runBounded(RUN_CONTEXT);

    const filter = model.find.mock.calls[0]![0] as any;
    expect(filter.$or).toEqual(
      expect.arrayContaining([
        { membershipProjectionState: "pending" },
        { membershipProjectionState: { $exists: false } },
        expect.objectContaining({ $expr: expect.any(Object) }),
        expect.objectContaining({
          enabled: true,
          closesAt: { $lte: NOW },
          membershipProjectionState: { $ne: "archived" },
        }),
        expect.objectContaining({
          archivedAt: { $ne: null },
          membershipProjectionState: { $ne: "archived" },
        }),
      ]),
    );
  });

  it("reserves bounded anomaly capacity and deduplicates it from settings candidates", async () => {
    const model = settingsModel([
      { _id: SETTING_IDS[0], programId: PROGRAM_IDS[0] },
    ]);
    anomalyCandidateLoader.mockResolvedValue([
      { _id: new mongoose.Types.ObjectId(), programId: PROGRAM_IDS[0] },
      { _id: new mongoose.Types.ObjectId(), programId: PROGRAM_IDS[1] },
    ]);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      limit: 3,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const result = await service.runBounded(RUN_CONTEXT);

    expect(result).toMatchObject({
      candidatesScanned: 2,
      reconciledPrograms: 2,
      capacityPerRun: 3,
    });
    expect(sync.reconcileProgram.mock.calls.map(([id]) => String(id))).toEqual([
      PROGRAM_IDS[0]!.toString(),
      PROGRAM_IDS[1]!.toString(),
    ]);
    expect(anomalyCandidateLoader).toHaveBeenCalledWith(null, 4);
    expect(model.find.mock.calls[0]![0]).not.toHaveProperty("_id");
  });

  it.each(["off", "read_only"] as const)(
    "pauses before candidate reads while Alumni runtime is %s",
    async (mode) => {
      runtimeReader.getOperationalRuntimeConfig.mockResolvedValue(
        createRuntimeConfigDTO(mode, 2),
      );
      const model = settingsModel([
        { _id: SETTING_IDS[0], programId: PROGRAM_IDS[0] },
      ]);
      const service = new ProgramMembershipReconciliationService({
        now: () => NOW,
        settingsModel: model as any,
        sync: sync as any,
        authorization: authorization as any,
        runtimeReader,
        anomalyCandidateLoader,
      });

      await expect(service.runBounded(RUN_CONTEXT)).resolves.toEqual({
        paused: true,
        candidatesScanned: 0,
        reconciledPrograms: 0,
        createdMemberships: 0,
        updatedRoles: 0,
        closedMemberships: 0,
        reactivatedMemberships: 0,
        archivedRooms: 0,
        ignoredPurchasesMissingStudentRoleId: 0,
        ignoredPurchasesUnmappedStudentRoleId: 0,
        deferredRevocations: 0,
        deferredReactivations: 0,
        racedOrUnavailable: 0,
        hasMore: false,
        capacityPerRun: 25,
      });
      expect(authorization.assertCapability).toHaveBeenCalledOnce();
      expect(model.find).not.toHaveBeenCalled();
      expect(sync.reconcileProgram).not.toHaveBeenCalled();
    },
  );

  it("fails closed before candidate reads when runtime configuration is unavailable", async () => {
    runtimeReader.getOperationalRuntimeConfig.mockRejectedValue(
      new Error("runtime unavailable"),
    );
    const model = settingsModel([
      { _id: SETTING_IDS[0], programId: PROGRAM_IDS[0] },
    ]);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const result = await service.runBounded(RUN_CONTEXT);

    expect(result.paused).toBe(true);
    expect(model.find).not.toHaveBeenCalled();
    expect(sync.reconcileProgram).not.toHaveBeenCalled();
  });

  it("reads runtime once and shares one opaque permit across a bounded worker pass", async () => {
    const model = settingsModel([
      { _id: SETTING_IDS[0], programId: PROGRAM_IDS[0] },
      { _id: SETTING_IDS[1], programId: PROGRAM_IDS[1] },
    ]);
    const service = new ProgramMembershipReconciliationService({
      now: () => NOW,
      settingsModel: model as any,
      sync: sync as any,
      authorization: authorization as any,
      runtimeReader,
      anomalyCandidateLoader,
    });

    const result = await service.runBounded(RUN_CONTEXT);

    expect(result.paused).toBe(false);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
    const firstPermit = sync.reconcileProgram.mock.calls[0]?.[1]?.runtimePermit;
    const secondPermit = sync.reconcileProgram.mock.calls[1]?.[1]?.runtimePermit;
    expect(firstPermit).toBeDefined();
    expect(secondPermit).toBe(firstPermit);
    for (const [, context] of sync.reconcileProgram.mock.calls) {
      expect(context).not.toHaveProperty("now");
    }
  });
});
