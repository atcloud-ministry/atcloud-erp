import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProgramActorRoomReadResolver,
  type ProgramActorRoomReadDataSource,
} from "../../../../src/services/programs/ProgramActorRoomReadResolver";

const ACTOR_ID = new mongoose.Types.ObjectId("64c000000000000000000001");
const NOW = new Date("2026-09-12T12:00:00.000Z");
const PROGRAM_IDS = Array.from(
  { length: 7 },
  (_, index) =>
    new mongoose.Types.ObjectId(
      `64c0000000000000000001${String(index + 1).padStart(2, "0")}`,
    ),
);
const ROOM_IDS = Array.from(
  { length: 7 },
  (_, index) =>
    new mongoose.Types.ObjectId(
      `64c0000000000000000002${String(index + 1).padStart(2, "0")}`,
    ),
);

function openSettings(programId: mongoose.Types.ObjectId) {
  return {
    programId,
    enabled: true,
    opensAt: new Date("2026-09-01T00:00:00.000Z"),
    closesAt: new Date("2027-01-01T00:00:00.000Z"),
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" as const },
      {
        studentRoleId: "class-rep",
        memberRole: "class_representative" as const,
      },
    ],
  };
}

function program(
  programId: mongoose.Types.ObjectId,
  membership: {
    mentor?: boolean;
    classRepresentative?: boolean;
    mentee?: boolean;
  } = {},
) {
  return {
    _id: programId,
    mentors: membership.mentor ? [{ userId: ACTOR_ID }] : [],
    adminEnrollments: {
      classReps: membership.classRepresentative ? [ACTOR_ID] : [],
      mentees: membership.mentee ? [ACTOR_ID] : [],
    },
    programRoles: {
      teacherRoleName: "Mentor",
      studentRoles: [
        { id: "participant", name: "Participant" },
        { id: "class-rep", name: "Class Representative" },
      ],
    },
  };
}

function createDataSource(): ProgramActorRoomReadDataSource & {
  loadEligibleActor: ReturnType<typeof vi.fn>;
  loadSettings: ReturnType<typeof vi.fn>;
  loadProgramsForActor: ReturnType<typeof vi.fn>;
  loadPrimaryConversations: ReturnType<typeof vi.fn>;
  loadEffectivePurchasesForActor: ReturnType<typeof vi.fn>;
} {
  return {
    loadEligibleActor: vi.fn().mockResolvedValue(true),
    loadSettings: vi
      .fn()
      .mockResolvedValue(PROGRAM_IDS.map((programId) => openSettings(programId))),
    loadProgramsForActor: vi.fn().mockResolvedValue([
      program(PROGRAM_IDS[0]!, { mentor: true, classRepresentative: true, mentee: true }),
      program(PROGRAM_IDS[1]!, { classRepresentative: true, mentee: true }),
      program(PROGRAM_IDS[2]!, { mentee: true }),
      program(PROGRAM_IDS[3]!),
      program(PROGRAM_IDS[4]!, { mentor: true }),
      program(PROGRAM_IDS[5]!, { mentee: true }),
      program(PROGRAM_IDS[6]!, { mentee: true }),
    ]),
    loadPrimaryConversations: vi.fn().mockResolvedValue(
      PROGRAM_IDS.map((programId, index) => ({
        _id: ROOM_IDS[index],
        programId,
      })),
    ),
    loadEffectivePurchasesForActor: vi.fn().mockResolvedValue([
      {
        programId: PROGRAM_IDS[3],
        userId: ACTOR_ID,
        studentRoleId: "class-rep",
      },
    ]),
  } as ProgramActorRoomReadDataSource & {
    loadEligibleActor: ReturnType<typeof vi.fn>;
    loadSettings: ReturnType<typeof vi.fn>;
    loadProgramsForActor: ReturnType<typeof vi.fn>;
    loadPrimaryConversations: ReturnType<typeof vi.fn>;
    loadEffectivePurchasesForActor: ReturnType<typeof vi.fn>;
  };
}

function candidate(
  index: number,
  materializedRole: "mentor" | "class_representative" | "mentee",
) {
  return {
    programId: PROGRAM_IDS[index]!,
    conversationId: ROOM_IDS[index]!,
    materializedRole,
  };
}

describe("ProgramActorRoomReadResolver", () => {
  let dataSource: ReturnType<typeof createDataSource>;
  let resolver: ProgramActorRoomReadResolver;

  beforeEach(() => {
    dataSource = createDataSource();
    resolver = new ProgramActorRoomReadResolver({
      dataSource,
      now: () => NOW,
    });
  });

  it("batch-resolves mentor, admin, and purchase roles with canonical priority", async () => {
    const result = await resolver.resolveEligibleRooms(ACTOR_ID, [
      candidate(0, "mentor"),
      candidate(1, "class_representative"),
      candidate(2, "mentee"),
      candidate(3, "class_representative"),
    ]);

    expect(result).toEqual([
      {
        programId: PROGRAM_IDS[0]!.toString(),
        conversationId: ROOM_IDS[0]!.toString(),
        role: "mentor",
      },
      {
        programId: PROGRAM_IDS[1]!.toString(),
        conversationId: ROOM_IDS[1]!.toString(),
        role: "class_representative",
      },
      {
        programId: PROGRAM_IDS[2]!.toString(),
        conversationId: ROOM_IDS[2]!.toString(),
        role: "mentee",
      },
      {
        programId: PROGRAM_IDS[3]!.toString(),
        conversationId: ROOM_IDS[3]!.toString(),
        role: "class_representative",
      },
    ]);
    expect(dataSource.loadEligibleActor).toHaveBeenCalledTimes(1);
    expect(dataSource.loadSettings).toHaveBeenCalledTimes(1);
    expect(dataSource.loadProgramsForActor).toHaveBeenCalledTimes(1);
    expect(dataSource.loadPrimaryConversations).toHaveBeenCalledTimes(1);
    expect(dataSource.loadEffectivePurchasesForActor).toHaveBeenCalledTimes(1);
    expect(dataSource.loadProgramsForActor).toHaveBeenCalledWith(
      PROGRAM_IDS.slice(0, 4),
      ACTOR_ID,
      undefined,
    );
  });

  it("uses the same role policy as canonical projection and fails closed on mismatches", async () => {
    const wrongRoom = new mongoose.Types.ObjectId();
    const result = await resolver.resolveEligibleRooms(ACTOR_ID, [
      candidate(0, "class_representative"),
      { ...candidate(1, "class_representative"), conversationId: wrongRoom },
      candidate(2, "mentor"),
      candidate(4, "mentor"),
    ]);

    expect(result).toEqual([
      {
        programId: PROGRAM_IDS[4]!.toString(),
        conversationId: ROOM_IDS[4]!.toString(),
        role: "mentor",
      },
    ]);
  });

  it("excludes missing, disabled, future, expired, archived, and mapping-invalid Programs", async () => {
    dataSource.loadSettings.mockResolvedValue([
      { ...openSettings(PROGRAM_IDS[0]!), enabled: false },
      {
        ...openSettings(PROGRAM_IDS[1]!),
        opensAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      {
        ...openSettings(PROGRAM_IDS[2]!),
        closesAt: NOW,
      },
      {
        ...openSettings(PROGRAM_IDS[3]!),
        archivedAt: new Date("2026-09-10T00:00:00.000Z"),
      },
      {
        ...openSettings(PROGRAM_IDS[4]!),
        studentRoleMappings: [
          { studentRoleId: "participant", memberRole: "mentee" },
        ],
      },
    ]);

    await expect(
      resolver.resolveEligibleRooms(
        ACTOR_ID,
        PROGRAM_IDS.map((_programId, index) => candidate(index, "mentee")),
      ),
    ).resolves.toEqual([]);
  });

  it("returns no Rooms for an inactive or unverified actor without loading Program data", async () => {
    dataSource.loadEligibleActor.mockResolvedValue(false);

    await expect(
      resolver.resolveEligibleRooms(ACTOR_ID, [candidate(0, "mentor")]),
    ).resolves.toEqual([]);
    expect(dataSource.loadSettings).not.toHaveBeenCalled();
    expect(dataSource.loadProgramsForActor).not.toHaveBeenCalled();
    expect(dataSource.loadPrimaryConversations).not.toHaveBeenCalled();
    expect(dataSource.loadEffectivePurchasesForActor).not.toHaveBeenCalled();
  });

  it("deduplicates identical candidates and rejects conflicting projections", async () => {
    const result = await resolver.resolveEligibleRooms(ACTOR_ID, [
      candidate(0, "mentor"),
      candidate(0, "mentor"),
      candidate(1, "class_representative"),
      candidate(1, "mentee"),
    ]);

    expect(result).toEqual([
      {
        programId: PROGRAM_IDS[0]!.toString(),
        conversationId: ROOM_IDS[0]!.toString(),
        role: "mentor",
      },
    ]);
    expect(dataSource.loadSettings.mock.calls[0]![0]).toEqual([PROGRAM_IDS[0]]);
  });

  it("propagates batch read failures so callers cannot expose stale candidates", async () => {
    dataSource.loadSettings.mockRejectedValue(new Error("settings unavailable"));

    await expect(
      resolver.resolveEligibleRooms(ACTOR_ID, [candidate(0, "mentor")]),
    ).rejects.toThrow("settings unavailable");
  });
});
