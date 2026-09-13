import mongoose, { type ClientSession, type Model } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Program, { type IProgram } from "../../../../src/models/Program";
import ProgramCommunitySettings, {
  type IProgramCommunitySettings,
} from "../../../../src/models/ProgramCommunitySettings";
import type { IConversation } from "../../../../src/models/Conversation";
import {
  ProgramCommunitySettingsError,
  ProgramCommunitySettingsService,
} from "../../../../src/services/programs/ProgramCommunitySettingsService";
import type {
  IdempotencyReplayResponseDto,
  IdempotencyService,
} from "../../../../src/services/reliability/IdempotencyService";

const PROGRAM_ID = new mongoose.Types.ObjectId("650000000000000000000001");
const ACTOR_ID = new mongoose.Types.ObjectId("650000000000000000000002");
const ROOM_ID = new mongoose.Types.ObjectId("650000000000000000000003");
const NOW = new Date("2026-09-12T16:00:00.000Z");
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";
const SESSION = { inTransaction: () => true } as ClientSession;

function program(): IProgram {
  return new Program({
    _id: PROGRAM_ID,
    title: "EMBA 2027",
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: ACTOR_ID,
    programRoles: {
      teacherRoleName: "Mentor",
      studentRoles: [
        { id: "participant", name: "Participant", discountEligible: false },
        {
          id: "class-rep",
          name: "Class Representative",
          discountEligible: true,
        },
      ],
    },
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

function updateInput(expectedRevision = 0) {
  return {
    programId: PROGRAM_ID.toString(),
    actor: { id: ACTOR_ID.toString(), role: "Administrator" },
    idempotencyKey: IDEMPOTENCY_KEY,
    correlationId: "m6-unit",
    enabled: true,
    opensAt: new Date("2026-09-01T00:00:00.000Z"),
    closesAt: new Date("2027-01-01T00:00:00.000Z"),
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" as const },
      {
        studentRoleId: "class-rep",
        memberRole: "class_representative" as const,
      },
    ],
    expectedRevision,
  };
}

function replayingIdempotency() {
  let receipt: IdempotencyReplayResponseDto | undefined;
  const execute = vi.fn(
    async (input: Parameters<IdempotencyService["execute"]>[0]) => {
      if (receipt) {
        return {
          receiptId: "receipt-1",
          replayed: true,
          httpStatus: 200,
          response: receipt,
        };
      }
      const result = await input.execute(SESSION, { attempt: 1 });
      receipt = result.response;
      return {
        receiptId: "receipt-1",
        replayed: false,
        ...result,
      };
    },
  );
  return { execute };
}

describe("ProgramCommunitySettingsService", () => {
  let programs: { findById: ReturnType<typeof vi.fn> };
  let settings: {
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let conversations: { findOne: ReturnType<typeof vi.fn> };
  let roomProvisioner: {
    ensurePrimaryRoomInTransaction: ReturnType<typeof vi.fn>;
  };
  let writeRequiredAudit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    programs = { findById: vi.fn(() => query(program())) };
    settings = {
      findOne: vi.fn(() => query(null)),
      create: vi.fn(async ([fields]: [Record<string, unknown>]) => [
        new ProgramCommunitySettings({
          _id: new mongoose.Types.ObjectId("650000000000000000000004"),
          ...fields,
        }),
      ]),
    };
    conversations = { findOne: vi.fn(() => query(null)) };
    roomProvisioner = {
      ensurePrimaryRoomInTransaction: vi.fn().mockResolvedValue(ROOM_ID),
    };
    writeRequiredAudit = vi.fn().mockResolvedValue(undefined);
  });

  function service(idempotency = replayingIdempotency()) {
    return new ProgramCommunitySettingsService({
      now: () => NOW,
      programModel: programs as unknown as Model<IProgram>,
      settingsModel: settings as unknown as Model<IProgramCommunitySettings>,
      conversationModel: conversations as unknown as Model<IConversation>,
      idempotency: idempotency as unknown as IdempotencyService,
      roomProvisioner,
      writeRequiredAudit,
    });
  }

  it("returns a virtual disabled DTO with deterministic candidate mappings", async () => {
    await expect(service().get(PROGRAM_ID.toString())).resolves.toEqual({
      id: null,
      programId: PROGRAM_ID.toString(),
      primaryConversationId: null,
      enabled: false,
      opensAt: null,
      closesAt: null,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
    expect(conversations.findOne).toHaveBeenCalledWith({
      kind: "program",
      programId: PROGRAM_ID,
    });
  });

  it("normalizes legacy whitespace and duplicate raw role IDs when enabling", async () => {
    programs.findById.mockImplementation(() =>
      query({
        _id: PROGRAM_ID,
        programRoles: {
          teacherRoleName: " Mentor ",
          studentRoles: [
            {
              id: " Participant Role ",
              name: "Participant Role",
              discountEligible: false,
            },
            {
              id: "Participant Role",
              name: "Class Representative",
              discountEligible: true,
            },
          ],
        },
      } as unknown as IProgram),
    );
    const input = {
      ...updateInput(),
      studentRoleMappings: [
        { studentRoleId: "participant-role", memberRole: "mentee" as const },
        {
          studentRoleId: "participant-role-2",
          memberRole: "class_representative" as const,
        },
      ],
    };

    const result = await service().update(input);

    expect(result.settings.studentRoleMappings).toEqual(
      input.studentRoleMappings,
    );
    expect(settings.create.mock.calls[0]?.[0]?.[0]).toMatchObject({
      enabled: true,
      studentRoleMappings: input.studentRoleMappings,
    });
    expect(roomProvisioner.ensurePrimaryRoomInTransaction).toHaveBeenCalledOnce();
  });

  it("stores mappings in normalized Program role order", async () => {
    programs.findById.mockImplementation(() =>
      query({
        _id: PROGRAM_ID,
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [
            {
              id: "class-rep",
              name: "Class Representative",
              discountEligible: true,
            },
            {
              id: "participant",
              name: "Participant",
              discountEligible: false,
            },
          ],
        },
      } as unknown as IProgram),
    );

    const result = await service().update(updateInput());

    expect(result.settings.studentRoleMappings).toEqual([
      { studentRoleId: "class-rep", memberRole: "class_representative" },
      { studentRoleId: "participant", memberRole: "mentee" },
    ]);
  });

  it("rejects enabling when normalized Program roles exceed the mapping limit", async () => {
    programs.findById.mockImplementation(() =>
      query({
        _id: PROGRAM_ID,
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: Array.from({ length: 101 }, (_, index) => ({
            id: `role-${index}`,
            name: `Role ${index}`,
            discountEligible: false,
          })),
        },
      } as unknown as IProgram),
    );

    await expect(
      service().update({
        ...updateInput(),
        studentRoleMappings: Array.from({ length: 100 }, (_, index) => ({
          studentRoleId: `role-${index}`,
          memberRole: "mentee" as const,
        })),
      }),
    ).rejects.toMatchObject({
      code: "PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT",
    });
    expect(roomProvisioner.ensurePrimaryRoomInTransaction).not.toHaveBeenCalled();
    expect(settings.create).not.toHaveBeenCalled();
  });

  it("atomically provisions one Room and replays the exact committed DTO", async () => {
    const idempotency = replayingIdempotency();
    const target = service(idempotency);

    const first = await target.update(updateInput());
    const replay = await target.update(updateInput());

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.settings).toMatchObject({
      programId: PROGRAM_ID.toString(),
      primaryConversationId: ROOM_ID.toString(),
      enabled: true,
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(first.settings).not.toHaveProperty("membershipFenceRevision");
    expect(settings.create).toHaveBeenCalledOnce();
    expect(roomProvisioner.ensurePrimaryRoomInTransaction).toHaveBeenCalledOnce();
    expect(writeRequiredAudit).toHaveBeenCalledOnce();
    expect(writeRequiredAudit.mock.calls[0][0].details).toMatchObject({
      changedFields: [
        "enabled",
        "opensAt",
        "closesAt",
        "studentRoleMappings",
      ],
      studentRoleMappings: updateInput().studentRoleMappings,
    });
  });

  it("rejects stale revisions and incomplete enabled mappings before provisioning", async () => {
    const current = new ProgramCommunitySettings({
      _id: new mongoose.Types.ObjectId(),
      programId: PROGRAM_ID,
      enabled: false,
      opensAt: null,
      closesAt: null,
      archivedAt: null,
      studentRoleMappings: [],
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
    settings.findOne.mockImplementation(() => query(current));
    const target = service();

    await expect(target.update(updateInput(1))).rejects.toMatchObject({
      code: "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT",
    });
    await expect(
      target.update({
        ...updateInput(2),
        idempotencyKey: "4f00aa31-36f0-4f05-8f4a-a362bf33a222",
        studentRoleMappings: [
          { studentRoleId: "participant", memberRole: "mentee" },
        ],
      }),
    ).rejects.toMatchObject({ code: "PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT" });
    expect(roomProvisioner.ensurePrimaryRoomInTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when enabled settings point at a retained archived Room", async () => {
    settings.findOne.mockImplementation(() =>
      query(
        new ProgramCommunitySettings({
          _id: new mongoose.Types.ObjectId(),
          programId: PROGRAM_ID,
          enabled: true,
          opensAt: NOW,
          closesAt: null,
          archivedAt: null,
          studentRoleMappings: updateInput().studentRoleMappings,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
    );
    conversations.findOne.mockImplementation(() =>
      query({
        _id: ROOM_ID,
        status: "archived",
        archivedAt: NOW,
        purgeAt: new Date("2028-09-12T16:00:00.000Z"),
      }),
    );

    await expect(service().get(PROGRAM_ID.toString())).rejects.toBeInstanceOf(
      ProgramCommunitySettingsError,
    );
  });

  it("rejects a settings write exactly at an enabled community close boundary", async () => {
    const current = new ProgramCommunitySettings({
      _id: new mongoose.Types.ObjectId(),
      programId: PROGRAM_ID,
      enabled: true,
      opensAt: new Date("2026-09-01T00:00:00.000Z"),
      closesAt: NOW,
      archivedAt: null,
      studentRoleMappings: updateInput().studentRoleMappings,
      revision: 1,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    settings.findOne.mockImplementation(() => query(current));

    await expect(service().update(updateInput(1))).rejects.toMatchObject({
      code: "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT",
    });
    expect(roomProvisioner.ensurePrimaryRoomInTransaction).not.toHaveBeenCalled();
    expect(settings.create).not.toHaveBeenCalled();
    expect(writeRequiredAudit).not.toHaveBeenCalled();
  });
});
