import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import AuditLog from "../../../src/models/AuditLog";
import Conversation from "../../../src/models/Conversation";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import { initializeAlumniDataModels } from "../../../src/models/initializeAlumniDataModels";
import { ProgramCommunitySettingsService } from "../../../src/services/programs/ProgramCommunitySettingsService";
import { ProgramPurchaseRolePreflightError } from "../../../src/services/programs/ProgramPurchaseRolePreflightService";
import { ProgramRoomMembershipSyncService } from "../../../src/services/programs/ProgramRoomMembershipSyncService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2026-09-12T16:00:00.000Z");
const ACTOR_ID = new mongoose.Types.ObjectId("660000000000000000000001");
const models = [
  AuditLog,
  IdempotencyRecord,
  ProgramCommunitySettings,
  Conversation,
  Purchase,
  Program,
] as const;

async function createProgram() {
  return Program.create({
    title: `M6 Program ${randomUUID()}`,
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: ACTOR_ID,
    programRoles: {
      teacherRoleName: "Mentor",
      studentRoles: [
        {
          id: "participant",
          name: "Participant",
          discountEligible: false,
          discountAmount: 0,
          limit: 0,
          count: 0,
        },
        {
          id: "class-rep",
          name: "Class Representative",
          discountEligible: true,
          discountAmount: 0,
          limit: 0,
          count: 0,
        },
      ],
    },
  });
}

function updateInput(
  programId: mongoose.Types.ObjectId,
  options: {
    expectedRevision?: number;
    idempotencyKey?: string;
    closesAt?: Date | null;
  } = {},
) {
  return {
    programId: programId.toString(),
    actor: { id: ACTOR_ID.toString(), role: "Administrator" },
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    correlationId: "m6-integration",
    enabled: true,
    opensAt: new Date("2026-09-01T00:00:00.000Z"),
    closesAt:
      options.closesAt === undefined
        ? new Date("2027-01-01T00:00:00.000Z")
        : options.closesAt,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" as const },
      {
        studentRoleId: "class-rep",
        memberRole: "class_representative" as const,
      },
    ],
    expectedRevision: options.expectedRevision ?? 0,
  };
}

describe("ProgramCommunitySettings transaction integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await initializeAlumniDataModels();
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("initializes stable Program identity/open-scan indexes without an independent TTL", async () => {
    const indexes = await ProgramCommunitySettings.collection.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_program_community_settings_program",
          key: { programId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: "idx_program_community_settings_open_scan",
          key: {
            enabled: 1,
            archivedAt: 1,
            opensAt: 1,
            closesAt: 1,
            programId: 1,
          },
        }),
        expect.objectContaining({
          name: "idx_program_community_membership_repair",
          key: {
            membershipProjectionState: 1,
            membershipProjectionRevision: 1,
            _id: 1,
          },
        }),
      ]),
    );
    expect(indexes.some((index) => index.expireAfterSeconds !== undefined)).toBe(
      false,
    );
  });

  it("returns a revision-zero candidate without persisting configuration", async () => {
    const program = await createProgram();
    const service = new ProgramCommunitySettingsService();

    const settings = await service.get(program._id.toString());

    expect(settings).toMatchObject({
      id: null,
      programId: program._id.toString(),
      primaryConversationId: null,
      enabled: false,
      revision: 0,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
    });
    expect(await ProgramCommunitySettings.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  it("provisions exactly one primary Room and replays the original full DTO", async () => {
    const program = await createProgram();
    const service = new ProgramCommunitySettingsService({ now: () => NOW });
    const firstKey = randomUUID();
    const firstInput = updateInput(program._id, { idempotencyKey: firstKey });

    const first = await service.update(firstInput);
    const second = await service.update(
      updateInput(program._id, {
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        closesAt: new Date("2027-02-01T00:00:00.000Z"),
      }),
    );
    const replay = await service.update(firstInput);

    expect(first.replayed).toBe(false);
    expect(first.settings).toMatchObject({
      programId: program._id.toString(),
      enabled: true,
      revision: 1,
      closesAt: "2027-01-01T00:00:00.000Z",
    });
    expect(first.settings.primaryConversationId).toMatch(/^[a-f\d]{24}$/u);
    expect(second.settings).toMatchObject({
      revision: 2,
      closesAt: "2027-02-01T00:00:00.000Z",
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await ProgramCommunitySettings.countDocuments({ programId: program._id })).toBe(
      1,
    );
    expect(await Conversation.countDocuments({ programId: program._id })).toBe(1);
    expect(await AuditLog.countDocuments({
      action: "program.community_settings_updated",
    })).toBe(2);

    const stored = await ProgramCommunitySettings.findOne({
      programId: program._id,
    })
      .lean()
      .orFail();
    expect(stored.revision).toBe(2);
    expect("primaryConversationId" in stored).toBe(false);

    const receipt = await IdempotencyRecord.findOne({
      scope: "program.community-settings.update",
      state: "completed",
      "response.revision": 1,
    })
      .lean()
      .orFail();
    expect(receipt.response).toEqual(first.settings);
  });

  it("rolls settings, Room, audit, and idempotency receipt back together", async () => {
    const program = await createProgram();
    const service = new ProgramCommunitySettingsService({
      now: () => NOW,
      writeRequiredAudit: async () => {
        throw new Error("audit unavailable");
      },
    });

    await expect(service.update(updateInput(program._id))).rejects.toThrow(
      "audit unavailable",
    );

    await expect(
      Promise.all([
        ProgramCommunitySettings.countDocuments({ programId: program._id }),
        Conversation.countDocuments({ programId: program._id }),
        AuditLog.countDocuments({
          action: "program.community_settings_updated",
        }),
        IdempotencyRecord.countDocuments({
          scope: "program.community-settings.update",
        }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0]);
  });

  it("blocks Room enablement until every effective historical purchase is persisted with a valid role", async () => {
    const program = await createProgram();
    const purchaseId = new mongoose.Types.ObjectId();
    await Purchase.collection.insertOne({
      _id: purchaseId,
      userId: new mongoose.Types.ObjectId(),
      programId: program._id,
      purchaseType: "program",
      status: "completed",
      isClassRep: false,
      orderNumber: `M6-PREFLIGHT-${randomUUID()}`,
      purchaseDate: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const service = new ProgramCommunitySettingsService({ now: () => NOW });

    await expect(service.update(updateInput(program._id))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProgramPurchaseRolePreflightError &&
        error.diagnostics.unresolved === 1 &&
        error.diagnostics.autoResolvable === 1,
    );
    await expect(
      Promise.all([
        ProgramCommunitySettings.countDocuments({ programId: program._id }),
        Conversation.countDocuments({ programId: program._id }),
        AuditLog.countDocuments({
          action: "program.community_settings_updated",
        }),
        IdempotencyRecord.countDocuments({
          scope: "program.community-settings.update",
        }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0]);

    await Purchase.collection.updateOne(
      { _id: purchaseId },
      { $set: { studentRoleId: "participant" } },
    );
    await expect(
      service.update(
        updateInput(program._id, { idempotencyKey: randomUUID() }),
      ),
    ).resolves.toMatchObject({
      settings: { enabled: true, revision: 1 },
    });
  });

  it("does not let an abandoned pending purchase permanently block Room provisioning", async () => {
    const program = await createProgram();
    const pendingId = new mongoose.Types.ObjectId();
    await Purchase.collection.insertOne({
      _id: pendingId,
      userId: new mongoose.Types.ObjectId(),
      programId: program._id,
      purchaseType: "program",
      status: "pending",
      isClassRep: false,
      orderNumber: `M6-PENDING-PREFLIGHT-${randomUUID()}`,
      purchaseDate: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const service = new ProgramCommunitySettingsService({ now: () => NOW });

    await expect(service.update(updateInput(program._id))).resolves.toMatchObject({
      settings: { enabled: true, revision: 1 },
    });
    await expect(Purchase.findById(pendingId).lean().orFail()).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("lets the close worker win while rejecting a concurrent settings update at closesAt", async () => {
    const program = await createProgram();
    const beforeClose = new Date(NOW.getTime() - 1);
    const setupService = new ProgramCommunitySettingsService({
      now: () => beforeClose,
    });
    await setupService.update(
      updateInput(program._id, {
        idempotencyKey: randomUUID(),
        closesAt: NOW,
      }),
    );

    const boundaryService = new ProgramCommunitySettingsService({
      now: () => NOW,
    });
    const worker = new ProgramRoomMembershipSyncService({
      now: () => NOW,
      runtimeReader: {
        getOperationalRuntimeConfig: async () =>
          createRuntimeConfigDTO("on", 1),
      },
    });
    const [updateResult, workerResult] = await Promise.allSettled([
      boundaryService.update(
        updateInput(program._id, {
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
          closesAt: new Date("2027-02-01T00:00:00.000Z"),
        }),
      ),
      worker.reconcileProgram(program._id, { source: "worker" }),
    ]);

    expect(updateResult.status).toBe("rejected");
    if (updateResult.status === "rejected") {
      expect(updateResult.reason).toMatchObject({
        code: "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT",
      });
    }
    expect(workerResult).toMatchObject({
      status: "fulfilled",
      value: {
        resolutionState: "closed",
        roomArchived: true,
      },
    });
    await expect(
      ProgramCommunitySettings.findOne({ programId: program._id }).lean(),
    ).resolves.toMatchObject({
      enabled: false,
      archivedAt: NOW,
      revision: 2,
    });
    await expect(
      Conversation.findOne({ programId: program._id }).lean(),
    ).resolves.toMatchObject({ status: "archived", archivedAt: NOW });
  });
});
