import mongoose, { type Model } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import {
  ProgramMembershipSyncConflictError,
  ProgramRoomMembershipSyncService,
} from "../../../../src/services/programs/ProgramRoomMembershipSyncService";
import type { ProgramMembershipResolution } from "../../../../src/services/programs/ProgramMembershipResolver";
import { acquireProgramMembershipRuntimePermit } from "../../../../src/services/programs/ProgramMembershipRuntimeGate";
import { featureControlService } from "../../../../src/services/runtime/FeatureControlService";
import type { IProgramCommunitySettings } from "../../../../src/models/ProgramCommunitySettings";
import { conversationPurgeAt } from "../../../../src/contracts/chatRooms";

const PROGRAM_ID = new mongoose.Types.ObjectId("64c000000000000000000001");
const ROOM_ID = new mongoose.Types.ObjectId("64c000000000000000000002");
const SETTINGS_ID = new mongoose.Types.ObjectId("64c000000000000000000003");
const PROGRAM_B = new mongoose.Types.ObjectId("64c000000000000000000004");
const USER_A = new mongoose.Types.ObjectId("64c000000000000000000011");
const USER_B = new mongoose.Types.ObjectId("64c000000000000000000012");
const USER_C = new mongoose.Types.ObjectId("64c000000000000000000013");
const USER_D = new mongoose.Types.ObjectId("64c000000000000000000014");
const NOW = new Date("2026-09-02T12:00:00.000Z");
const SESSION = { inTransaction: () => true } as any;

function resolution(
  overrides: Partial<ProgramMembershipResolution> = {},
): ProgramMembershipResolution {
  return {
    programId: PROGRAM_ID.toString(),
    conversationId: ROOM_ID.toString(),
    state: "open",
    lifecycleAction: "synchronize",
    lifecycleReason: "community_open",
    archiveAt: null,
    memberships: [],
    roleMappingDiagnostics: {
      canonicalRoleCount: 0,
      configuredMappingCount: 0,
      invalidCanonicalRoleIdCount: 0,
      duplicateCanonicalRoleIdCount: 0,
      invalidConfiguredMappingCount: 0,
      duplicateConfiguredRoleIdCount: 0,
      missingMappingCount: 0,
      unexpectedMappingCount: 0,
    },
    ignoredPurchases: {
      missingStudentRoleId: 0,
      unmappedStudentRoleId: 0,
    },
    ...overrides,
  };
}

function query(value: unknown) {
  const chain: any = {
    select: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    session: vi.fn(() => chain),
    lean: vi.fn(() => chain),
    exec: vi.fn().mockResolvedValue(value),
  };
  return chain;
}

function memberSnapshot(
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId,
    role: "mentee",
    status: "active",
    joinedAt: new Date("2026-09-01T00:00:00.000Z"),
    accessWindows: [
      {
        visibleFromSequence: 1,
        visibleThroughSequence: null,
        openedAt: new Date("2026-09-01T00:00:00.000Z"),
        closedAt: null,
      },
    ],
    lastReadSequence: 0,
    unreadCount: 0,
    unreadReconciledThroughSequence: 0,
    unreadReconciledAt: NOW,
    muted: false,
    mutedAt: null,
    purgeAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    revision: 0,
    ...overrides,
  };
}

describe("ProgramRoomMembershipSyncService", () => {
  let resolver: { resolveProgram: ReturnType<typeof vi.fn> };
  let provisioner: {
    ensurePrimaryRoomInTransaction: ReturnType<typeof vi.fn>;
  };
  let conversations: {
    findOne: ReturnType<typeof vi.fn>;
    updateOne: ReturnType<typeof vi.fn>;
  };
  let members: {
    find: ReturnType<typeof vi.fn>;
    updateOne: ReturnType<typeof vi.fn>;
    bulkWrite: ReturnType<typeof vi.fn>;
  };
  let settings: {
    findOne: ReturnType<typeof vi.fn>;
    updateOne: ReturnType<typeof vi.fn>;
  };
  let transactions: { run: ReturnType<typeof vi.fn> };
  let audit: { recordRequiredInTransaction: ReturnType<typeof vi.fn> };
  let runtimeReader: { getOperationalRuntimeConfig: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    resolver = { resolveProgram: vi.fn().mockResolvedValue(resolution()) };
    provisioner = {
      ensurePrimaryRoomInTransaction: vi.fn().mockResolvedValue(ROOM_ID),
    };
    conversations = {
      findOne: vi.fn(() =>
        query({
          _id: ROOM_ID,
          status: "current",
          lastSequence: 7,
          revision: 3,
        }),
      ),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    members = {
      find: vi.fn(() => query([])),
      updateOne: vi
        .fn()
        .mockResolvedValue({ upsertedCount: 1, modifiedCount: 1 }),
      bulkWrite: vi.fn().mockImplementation(async (operations: unknown[]) => ({
        upsertedCount: operations.length,
        modifiedCount: operations.length,
      })),
    };
    settings = {
      findOne: vi.fn(() =>
        query({
          _id: SETTINGS_ID,
          revision: 1,
          membershipFenceRevision: 4,
          membershipProjectionRevision: 0,
          membershipProjectionState: "pending",
        }),
      ),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    transactions = {
      run: vi.fn(async (operation) => operation(SESSION)),
    };
    audit = {
      recordRequiredInTransaction: vi.fn().mockResolvedValue(undefined),
    };
    runtimeReader = {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function service(
    maximumConflictAttempts = 3,
    now: () => Date = () => NOW,
  ) {
    return new ProgramRoomMembershipSyncService({
      resolver: resolver as any,
      provisioner: provisioner as any,
      conversationModel: conversations as any,
      memberModel: members as any,
      settingsModel: settings as unknown as Model<IProgramCommunitySettings>,
      transactions: transactions as any,
      audit,
      now,
      maximumConflictAttempts,
      runtimeReader,
    });
  }

  it.each(["off", "read_only"] as const)(
    "does not open a transaction or inspect projection data while Alumni runtime is %s",
    async (mode) => {
      runtimeReader.getOperationalRuntimeConfig.mockResolvedValue(
        createRuntimeConfigDTO(mode, 2),
      );

      const result = await service().reconcileProgram(PROGRAM_ID);

      expect(result).toMatchObject({
        programId: PROGRAM_ID.toString(),
        conversationId: null,
        resolutionState: "runtime_unavailable",
        paused: true,
        createdMemberships: 0,
        updatedRoles: 0,
      });
      expect(transactions.run).not.toHaveBeenCalled();
      expect(resolver.resolveProgram).not.toHaveBeenCalled();
      expect(provisioner.ensurePrimaryRoomInTransaction).not.toHaveBeenCalled();
      expect(conversations.findOne).not.toHaveBeenCalled();
      expect(conversations.updateOne).not.toHaveBeenCalled();
      expect(members.find).not.toHaveBeenCalled();
      expect(members.updateOne).not.toHaveBeenCalled();
    },
  );

  it("uses the default operational reader fail-closed when runtime loading fails", async () => {
    vi.spyOn(
      featureControlService,
      "getOperationalRuntimeConfig",
    ).mockRejectedValue(new Error("runtime unavailable"));
    const guarded = new ProgramRoomMembershipSyncService({
      resolver: resolver as any,
      provisioner: provisioner as any,
      conversationModel: conversations as any,
      memberModel: members as any,
      settingsModel: settings as unknown as Model<IProgramCommunitySettings>,
      transactions: transactions as any,
      audit,
      now: () => NOW,
    });

    await expect(guarded.reconcileProgram(PROGRAM_ID)).resolves.toMatchObject({
      resolutionState: "runtime_unavailable",
      paused: true,
    });
    expect(transactions.run).not.toHaveBeenCalled();
    expect(resolver.resolveProgram).not.toHaveBeenCalled();
  });

  it("does not accept a caller-fabricated runtime permit", async () => {
    runtimeReader.getOperationalRuntimeConfig.mockResolvedValue(
      createRuntimeConfigDTO("on", 3),
    );

    const result = await service().reconcileProgram(PROGRAM_ID, {
      runtimePermit: Object.freeze({}) as never,
    });

    expect(result.paused).toBe(true);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
    expect(transactions.run).not.toHaveBeenCalled();
  });

  it("performs a fresh operational read even with a valid outer permit", async () => {
    const outerPermit = await acquireProgramMembershipRuntimePermit({
      getOperationalRuntimeConfig: async () =>
        createRuntimeConfigDTO("on", 2),
    });
    expect(outerPermit).not.toBeNull();

    const result = await service().reconcileProgram(PROGRAM_ID, {
      runtimePermit: outerPermit!,
    });

    expect(result.paused).toBe(false);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
    expect(transactions.run).toHaveBeenCalledOnce();
  });

  it("stops the next Program when runtime changes from on to off", async () => {
    const outerPermit = await acquireProgramMembershipRuntimePermit({
      getOperationalRuntimeConfig: async () =>
        createRuntimeConfigDTO("on", 2),
    });
    runtimeReader.getOperationalRuntimeConfig
      .mockResolvedValueOnce(createRuntimeConfigDTO("on", 3))
      .mockResolvedValueOnce(createRuntimeConfigDTO("off", 4));
    const guarded = service();

    const first = await guarded.reconcileProgram(PROGRAM_ID, {
      runtimePermit: outerPermit!,
    });
    const second = await guarded.reconcileProgram(PROGRAM_B, {
      runtimePermit: outerPermit!,
    });

    expect(first.paused).toBe(false);
    expect(second).toMatchObject({
      programId: PROGRAM_B.toString(),
      resolutionState: "runtime_unavailable",
      paused: true,
    });
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(transactions.run).toHaveBeenCalledOnce();
  });

  it("creates first-time active members from lastSequence + 1 and fences the Room", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        memberships: [
          {
            userId: USER_A.toString(),
            role: "mentor",
            sourceKinds: ["mentor_assignment"],
          },
        ],
      }),
    );

    const result = await service().reconcileProgram(PROGRAM_ID, {
      correlationId: "request-1",
    });

    expect(result).toMatchObject({
      createdMemberships: 1,
      updatedRoles: 0,
      unchangedMemberships: 0,
      deferredRevocations: 0,
      deferredReactivations: 0,
    });
    expect(conversations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ROOM_ID,
        lastSequence: 7,
        revision: 3,
      }),
      expect.objectContaining({ $inc: { revision: 1 } }),
      expect.objectContaining({ session: SESSION }),
    );
    expect(members.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: expect.objectContaining({
            filter: { conversationId: ROOM_ID, userId: USER_A },
            update: {
              $setOnInsert: expect.objectContaining({
                role: "mentor",
                status: "active",
                lastReadSequence: 7,
                unreadReconciledThroughSequence: 7,
                accessWindows: [
                  {
                    visibleFromSequence: 8,
                    visibleThroughSequence: null,
                    openedAt: NOW,
                    closedAt: null,
                  },
                ],
              }),
            },
            upsert: true,
          }),
        },
      ],
      { session: SESSION, ordered: true },
    );
    expect(audit.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "program.membership_synchronized",
        correlationId: "request-1",
      }),
      SESSION,
    );
  });

  it("writes a 500-member projection in Flex-safe batches of at most 100", async () => {
    const desired = Array.from({ length: 500 }, () => ({
      userId: new mongoose.Types.ObjectId().toString(),
      role: "mentee" as const,
      sourceKinds: ["program_purchase" as const],
    }));
    resolver.resolveProgram.mockResolvedValue(
      resolution({ memberships: desired }),
    );

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result.createdMemberships).toBe(500);
    expect(members.bulkWrite).toHaveBeenCalledTimes(5);
    expect(
      members.bulkWrite.mock.calls.map(([operations]) => operations.length),
    ).toEqual([100, 100, 100, 100, 100]);
    for (const [, options] of members.bulkWrite.mock.calls) {
      expect(options).toEqual({ session: SESSION, ordered: true });
    }
  });

  it("cuts off 500 active members in Flex-safe batches of at most 100", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        conversationId: null,
        state: "closed",
        lifecycleAction: "cutoff",
        lifecycleReason: "community_disabled",
      }),
    );
    members.find.mockReturnValue(
      query(
        Array.from({ length: 500 }, (_, index) =>
          memberSnapshot(new mongoose.Types.ObjectId(), { revision: index }),
        ),
      ),
    );

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result.closedMemberships).toBe(500);
    expect(members.bulkWrite).toHaveBeenCalledTimes(5);
    expect(
      members.bulkWrite.mock.calls.map(([operations]) => operations.length),
    ).toEqual([100, 100, 100, 100, 100]);
  });

  it("advances the Room fence for an open member persistence no-op", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        memberships: [
          {
            userId: USER_A.toString(),
            role: "mentor",
            sourceKinds: ["mentor_assignment"],
          },
        ],
      }),
    );
    members.find.mockReturnValue(
      query([memberSnapshot(USER_A, { role: "mentor", revision: 2 })]),
    );

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      createdMemberships: 0,
      updatedRoles: 0,
      unchangedMemberships: 1,
    });
    expect(conversations.updateOne).toHaveBeenCalledOnce();
    expect(conversations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ROOM_ID,
        lastSequence: 7,
        revision: 3,
      }),
      {
        $inc: { revision: 1 },
      },
      expect.objectContaining({ session: SESSION }),
    );
    expect(members.updateOne).not.toHaveBeenCalled();
    expect(audit.recordRequiredInTransaction).not.toHaveBeenCalled();
  });

  it("updates roles, reactivates history, and closes removed members at the same Room sequence", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        memberships: [
          {
            userId: USER_A.toString(),
            role: "mentor",
            sourceKinds: ["mentor_assignment"],
          },
          {
            userId: USER_B.toString(),
            role: "class_representative",
            sourceKinds: ["admin_class_representative"],
          },
          {
            userId: USER_C.toString(),
            role: "mentee",
            sourceKinds: ["program_purchase"],
          },
        ],
      }),
    );
    const memberA = memberSnapshot(USER_A, { role: "mentor", revision: 2 });
    const memberB = memberSnapshot(USER_B, { revision: 4 });
    const memberC = memberSnapshot(USER_C, {
      status: "history_only",
      revision: 5,
      muted: true,
      mutedAt: new Date("2026-09-01T06:00:00.000Z"),
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: 5,
          openedAt: new Date("2026-09-01T00:00:00.000Z"),
          closedAt: new Date("2026-09-01T12:00:00.000Z"),
        },
      ],
    });
    const memberD = memberSnapshot(USER_D, {
      revision: 1,
      accessWindows: [
        {
          visibleFromSequence: 8,
          visibleThroughSequence: null,
          openedAt: new Date("2026-09-02T11:00:00.000Z"),
          closedAt: null,
        },
      ],
    });
    members.find.mockReturnValue(
      query([memberA, memberB, memberC, memberD]),
    );

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      createdMemberships: 0,
      updatedRoles: 1,
      unchangedMemberships: 1,
      closedMemberships: 1,
      reactivatedMemberships: 1,
      deferredReactivations: 0,
      deferredRevocations: 0,
    });
    expect(members.bulkWrite).toHaveBeenCalledOnce();
    const operations = members.bulkWrite.mock.calls[0]![0] as any[];
    expect(operations).toHaveLength(3);
    expect(operations.find((operation) =>
      operation.updateOne.filter._id.equals(memberB._id),
    )).toMatchObject({
      updateOne: {
        filter: { _id: memberB._id, status: "active", revision: 4 },
        update: {
          $set: { role: "class_representative", updatedAt: NOW },
          $inc: { revision: 1 },
        },
      },
    });
    const reactivation = operations.find((operation) =>
      operation.updateOne.filter._id.equals(memberC._id),
    );
    expect(reactivation.updateOne.update.$set).toMatchObject({
      role: "mentee",
      status: "active",
      lastReadSequence: 7,
      unreadCount: 0,
      unreadReconciledThroughSequence: 7,
      purgeAt: null,
      accessWindows: [
        expect.objectContaining({ visibleThroughSequence: 5 }),
        {
          visibleFromSequence: 8,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
    });
    expect(reactivation.updateOne.update.$set).not.toHaveProperty("muted");
    const cutoff = operations.find((operation) =>
      operation.updateOne.filter._id.equals(memberD._id),
    );
    expect(cutoff.updateOne.update.$set).toMatchObject({
      status: "history_only",
      lastReadSequence: 7,
      unreadCount: 0,
      unreadReconciledThroughSequence: 7,
      accessWindows: [
        {
          visibleFromSequence: 8,
          visibleThroughSequence: 7,
          openedAt: new Date("2026-09-02T11:00:00.000Z"),
          closedAt: NOW,
        },
      ],
    });
    expect(members.bulkWrite).toHaveBeenCalledWith(
      operations,
      { session: SESSION, ordered: true },
    );
  });

  it("repairs a missing primary Room through the M6-01 provisioner", async () => {
    resolver.resolveProgram
      .mockResolvedValueOnce(
        resolution({ conversationId: null, state: "room_unavailable" }),
      )
      .mockResolvedValueOnce(resolution());

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(provisioner.ensurePrimaryRoomInTransaction).toHaveBeenCalledWith({
      programId: PROGRAM_ID,
      provisionedAt: NOW,
      session: SESSION,
    });
    expect(result.roomProvisioned).toBe(true);
    expect(settings.updateOne).toHaveBeenCalledWith(
      {
        _id: SETTINGS_ID,
        programId: PROGRAM_ID,
        membershipFenceRevision: 4,
      },
      { $inc: { membershipFenceRevision: 1 } },
      expect.objectContaining({ session: SESSION, timestamps: false }),
    );
    expect(settings.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
      provisioner.ensurePrimaryRoomInTransaction.mock.invocationCallOrder[0]!,
    );
    expect(conversations.updateOne).toHaveBeenCalledOnce();
    expect(audit.recordRequiredInTransaction).toHaveBeenCalledTimes(1);
  });

  it("cuts off every active member at N for a disabled Program community", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        conversationId: null,
        state: "closed",
        lifecycleAction: "cutoff",
        lifecycleReason: "community_disabled",
      }),
    );
    members.find.mockReturnValue(query([memberSnapshot(USER_A, { revision: 2 })]));

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result.resolutionState).toBe("closed");
    expect(result.closedMemberships).toBe(1);
    expect(conversations.findOne).toHaveBeenCalledWith({
      kind: "program",
      programId: PROGRAM_ID,
    });
    expect(conversations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ROOM_ID,
        programId: PROGRAM_ID,
        lastSequence: 7,
        revision: 3,
      }),
      expect.objectContaining({ $inc: { revision: 1 } }),
      expect.objectContaining({ session: SESSION }),
    );
    expect(members.bulkWrite).toHaveBeenCalledOnce();
    expect(audit.recordRequiredInTransaction).toHaveBeenCalledOnce();
  });

  it("returns a fail-closed result without a fence when no Program Room exists", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        conversationId: null,
        state: "settings_unavailable",
        lifecycleAction: "cutoff",
        lifecycleReason: "settings_unavailable",
      }),
    );
    conversations.findOne.mockReturnValue(query(null));
    settings.findOne.mockReturnValue(query(null));

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result.resolutionState).toBe("settings_unavailable");
    expect(conversations.updateOne).not.toHaveBeenCalled();
    expect(settings.updateOne).not.toHaveBeenCalled();
    expect(members.find).not.toHaveBeenCalled();
  });

  it("archives the Room and members with one shared retention clock", async () => {
    const latestMessagePurgeAt = new Date("2027-10-01T00:00:00.000Z");
    conversations.findOne.mockReturnValue(
      query({
        _id: ROOM_ID,
        status: "current",
        lastSequence: 7,
        lastMessageId: new mongoose.Types.ObjectId(),
        latestMessagePurgeAt,
        archivedAt: null,
        purgeAt: null,
        revision: 3,
      }),
    );
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        conversationId: null,
        state: "closed",
        lifecycleAction: "archive",
        lifecycleReason: "community_closed",
      }),
    );
    members.find.mockReturnValue(query([memberSnapshot(USER_A, { revision: 2 })]));
    const purgeAt = conversationPurgeAt(NOW, latestMessagePurgeAt);

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      resolutionState: "closed",
      roomArchived: true,
      closedMemberships: 1,
    });
    expect(conversations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ROOM_ID,
        status: "current",
        lastSequence: 7,
        revision: 3,
      }),
      {
        $set: {
          status: "archived",
          archivedAt: NOW,
          purgeAt,
          updatedAt: NOW,
        },
        $inc: { revision: 1 },
      },
      { session: SESSION, runValidators: false, timestamps: false },
    );
    expect(settings.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: SETTINGS_ID,
        revision: 1,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          enabled: false,
          archivedAt: NOW,
          membershipProjectionState: "archived",
          membershipProjectionRevision: 2,
        }),
        $inc: { revision: 1 },
      }),
      expect.objectContaining({ session: SESSION }),
    );
    const memberOperation = members.bulkWrite.mock.calls[0]![0][0];
    expect(memberOperation).toMatchObject({
      updateOne: {
        update: {
          $set: {
            status: "history_only",
            lastReadSequence: 7,
            unreadCount: 0,
            purgeAt,
          },
        },
      },
    });
    expect(audit.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "program.room_archived" }),
      SESSION,
    );
  });

  it("advances the settings generation for a non-open projection without a Room", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        conversationId: null,
        state: "role_mapping_invalid",
        lifecycleAction: "cutoff",
        lifecycleReason: "role_mapping_invalid",
      }),
    );
    conversations.findOne.mockReturnValue(query(null));

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result.resolutionState).toBe("role_mapping_invalid");
    expect(settings.updateOne).toHaveBeenCalledWith(
      {
        _id: SETTINGS_ID,
        programId: PROGRAM_ID,
        revision: 1,
      },
      {
        $set: {
          membershipProjectionRevision: 1,
          membershipProjectionState: "cutoff",
        },
      },
      { session: SESSION, runValidators: false, timestamps: false },
    );
    expect(provisioner.ensurePrimaryRoomInTransaction).not.toHaveBeenCalled();
    expect(members.find).not.toHaveBeenCalled();
  });

  it("retries a logical Room fence conflict without duplicating mutations", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        memberships: [
          {
            userId: USER_A.toString(),
            role: "mentee",
            sourceKinds: ["program_purchase"],
          },
        ],
      }),
    );
    conversations.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result.createdMemberships).toBe(1);
    expect(transactions.run).toHaveBeenCalledTimes(2);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
    expect(members.bulkWrite).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh clock when a fence retry crosses the Program close boundary", async () => {
    const beforeClose = new Date("2026-09-02T12:59:59.999Z");
    const afterClose = new Date("2026-09-02T13:00:00.001Z");
    const clock = vi
      .fn()
      .mockReturnValueOnce(beforeClose)
      .mockReturnValueOnce(afterClose);
    resolver.resolveProgram
      .mockResolvedValueOnce(
        resolution({
          memberships: [
            {
              userId: USER_A.toString(),
              role: "mentee",
              sourceKinds: ["program_purchase"],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        resolution({
          conversationId: null,
          state: "closed",
          lifecycleAction: "cutoff",
          lifecycleReason: "community_disabled",
        }),
      );
    conversations.updateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });

    const result = await service(3, clock).reconcileProgram(PROGRAM_ID);

    expect(result.resolutionState).toBe("closed");
    expect(clock).toHaveBeenCalledTimes(2);
    expect(resolver.resolveProgram).toHaveBeenNthCalledWith(1, PROGRAM_ID, {
      now: beforeClose,
      session: SESSION,
    });
    expect(resolver.resolveProgram).toHaveBeenNthCalledWith(2, PROGRAM_ID, {
      now: afterClose,
      session: SESSION,
    });
    expect(transactions.run).toHaveBeenCalledTimes(2);
    expect(runtimeReader.getOperationalRuntimeConfig).toHaveBeenCalledOnce();
    expect(members.bulkWrite).not.toHaveBeenCalled();
  });

  it("fails after the configured number of persistent conflicts", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        memberships: [
          {
            userId: USER_A.toString(),
            role: "mentee",
            sourceKinds: ["program_purchase"],
          },
        ],
      }),
    );
    conversations.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(service(2).reconcileProgram(PROGRAM_ID)).rejects.toBeInstanceOf(
      ProgramMembershipSyncConflictError,
    );
    expect(transactions.run).toHaveBeenCalledTimes(2);
  });

  it("surfaces fail-closed legacy-purchase diagnostics", async () => {
    resolver.resolveProgram.mockResolvedValue(
      resolution({
        ignoredPurchases: {
          missingStudentRoleId: 2,
          unmappedStudentRoleId: 3,
        },
      }),
    );

    const result = await service().reconcileProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      ignoredPurchasesMissingStudentRoleId: 2,
      ignoredPurchasesUnmappedStudentRoleId: 3,
    });
  });
});
