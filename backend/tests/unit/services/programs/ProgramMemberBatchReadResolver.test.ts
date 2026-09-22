import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  ProgramMemberBatchReadResolver,
  type ProgramMemberBatchReadDataSource,
} from "../../../../src/services/programs/ProgramMemberBatchReadResolver";

const NOW = new Date("2032-09-12T12:00:00.000Z");

function openSettings(programId: mongoose.Types.ObjectId) {
  return {
    programId,
    enabled: true,
    opensAt: new Date("2032-01-01T00:00:00.000Z"),
    closesAt: new Date("2033-01-01T00:00:00.000Z"),
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" as const },
    ],
  };
}

function buildCapacityFixture(programCount = 50, memberCount = 500) {
  const programIds = Array.from(
    { length: programCount },
    () => new mongoose.Types.ObjectId(),
  );
  const roomIds = Array.from(
    { length: programCount },
    () => new mongoose.Types.ObjectId(),
  );
  const userIds = Array.from(
    { length: memberCount },
    () => new mongoose.Types.ObjectId(),
  );
  const calls = {
    users: vi.fn().mockResolvedValue(userIds),
    settings: vi
      .fn()
      .mockResolvedValue(programIds.map((programId) => openSettings(programId))),
    programs: vi.fn().mockResolvedValue(
      programIds.map((_id) => ({
        _id,
        mentors: [],
        adminEnrollments: { classReps: [], mentees: userIds },
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [{ id: "participant", name: "Participant" }],
        },
      })),
    ),
    conversations: vi.fn().mockResolvedValue(
      programIds.map((programId, index) => ({
        _id: roomIds[index],
        programId,
      })),
    ),
    purchases: vi.fn().mockResolvedValue([]),
  };
  const dataSource: ProgramMemberBatchReadDataSource = {
    loadEligibleUsers: calls.users,
    loadSettings: calls.settings,
    loadPrograms: calls.programs,
    loadPrimaryConversations: calls.conversations,
    loadEffectivePurchases: calls.purchases,
  };
  return {
    programIds,
    roomIds,
    userIds,
    calls,
    dataSource,
    candidates: programIds.flatMap((programId, programIndex) =>
      userIds.map((userId) => ({
        programId,
        conversationId: roomIds[programIndex]!,
        userId,
        materializedRole: "mentee" as const,
      })),
    ),
  };
}

describe("ProgramMemberBatchReadResolver", () => {
  it("resolves 50 Programs x 500 members with exactly five batch reads", async () => {
    const fixture = buildCapacityFixture();
    const resolver = new ProgramMemberBatchReadResolver({
      dataSource: fixture.dataSource,
      now: () => NOW,
    });

    const result = await resolver.resolveEligibleMemberships(
      fixture.candidates,
    );

    expect(result).toHaveLength(25_000);
    expect(result[0]).toEqual({
      programId: fixture.programIds[0]!.toString(),
      conversationId: fixture.roomIds[0]!.toString(),
      userId: fixture.userIds[0]!.toString(),
      role: "mentee",
    });
    expect(result.at(-1)).toEqual({
      programId: fixture.programIds[49]!.toString(),
      conversationId: fixture.roomIds[49]!.toString(),
      userId: fixture.userIds[499]!.toString(),
      role: "mentee",
    });
    expect(fixture.calls.users).toHaveBeenCalledTimes(1);
    expect(fixture.calls.settings).toHaveBeenCalledTimes(1);
    expect(fixture.calls.programs).toHaveBeenCalledTimes(1);
    expect(fixture.calls.conversations).toHaveBeenCalledTimes(1);
    expect(fixture.calls.purchases).toHaveBeenCalledTimes(1);
  });

  it("fails closed on projection conflicts and role mismatches", async () => {
    const fixture = buildCapacityFixture(2, 2);
    fixture.calls.programs.mockResolvedValue([
      {
        _id: fixture.programIds[0],
        mentors: [{ userId: fixture.userIds[0] }],
        adminEnrollments: {
          classReps: [],
          mentees: fixture.userIds,
        },
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [{ id: "participant", name: "Participant" }],
        },
      },
      {
        _id: fixture.programIds[1],
        mentors: [],
        adminEnrollments: { classReps: [], mentees: fixture.userIds },
        programRoles: {
          teacherRoleName: "Mentor",
          studentRoles: [{ id: "participant", name: "Participant" }],
        },
      },
    ]);
    const resolver = new ProgramMemberBatchReadResolver({
      dataSource: fixture.dataSource,
      now: () => NOW,
    });

    const result = await resolver.resolveEligibleMemberships([
      fixture.candidates[0]!,
      { ...fixture.candidates[0]!, materializedRole: "mentor" },
      fixture.candidates[1]!,
      {
        ...fixture.candidates[2]!,
        conversationId: new mongoose.Types.ObjectId(),
      },
      fixture.candidates[3]!,
    ]);

    expect(result).toEqual([
      {
        programId: fixture.programIds[0]!.toString(),
        conversationId: fixture.roomIds[0]!.toString(),
        userId: fixture.userIds[1]!.toString(),
        role: "mentee",
      },
      {
        programId: fixture.programIds[1]!.toString(),
        conversationId: fixture.roomIds[1]!.toString(),
        userId: fixture.userIds[1]!.toString(),
        role: "mentee",
      },
    ]);
  });

  it("does no reads for an empty candidate set and propagates read failures", async () => {
    const fixture = buildCapacityFixture(1, 1);
    const resolver = new ProgramMemberBatchReadResolver({
      dataSource: fixture.dataSource,
      now: () => NOW,
    });

    await expect(resolver.resolveEligibleMemberships([])).resolves.toEqual([]);
    expect(fixture.calls.users).not.toHaveBeenCalled();

    fixture.calls.settings.mockRejectedValue(new Error("settings unavailable"));
    await expect(
      resolver.resolveEligibleMemberships(fixture.candidates),
    ).rejects.toThrow("settings unavailable");
  });
});
