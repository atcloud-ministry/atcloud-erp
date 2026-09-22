import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MongoProgramMembershipResolverDataSource,
  ProgramMembershipResolver,
  type ProgramMembershipResolverDataSource,
} from "../../../../src/services/programs/ProgramMembershipResolver";

const PROGRAM_ID = new mongoose.Types.ObjectId("64b000000000000000000001");
const ROOM_ID = new mongoose.Types.ObjectId("64b000000000000000000002");
const USER_IDS = Array.from(
  { length: 8 },
  (_, index) =>
    new mongoose.Types.ObjectId(
      `64b0000000000000000001${String(index + 1).padStart(2, "0")}`,
    ),
);
const NOW = new Date("2026-09-01T12:00:00.000Z");

function createDataSource(): ProgramMembershipResolverDataSource & {
  loadSettings: ReturnType<typeof vi.fn>;
  loadPrimaryConversationId: ReturnType<typeof vi.fn>;
  loadProgram: ReturnType<typeof vi.fn>;
  loadProgramForUser: ReturnType<typeof vi.fn>;
  loadEffectiveProgramPurchases: ReturnType<typeof vi.fn>;
  loadEffectiveProgramPurchasesForUser: ReturnType<typeof vi.fn>;
  loadEligibleUserIds: ReturnType<typeof vi.fn>;
} {
  return {
    loadSettings: vi.fn().mockResolvedValue({
      enabled: true,
      opensAt: new Date("2026-08-01T00:00:00.000Z"),
      closesAt: null,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        {
          studentRoleId: "class-rep",
          memberRole: "class_representative",
        },
      ],
    }),
    loadPrimaryConversationId: vi.fn().mockResolvedValue(ROOM_ID.toString()),
    loadProgram: vi.fn().mockResolvedValue({
      mentors: [],
      adminEnrollments: { mentees: [], classReps: [] },
      programRoles: {
        studentRoles: [{ id: "participant" }, { id: "class-rep" }],
      },
    }),
    loadProgramForUser: vi.fn().mockResolvedValue({
      mentors: [],
      adminEnrollments: { mentees: [], classReps: [] },
      programRoles: {
        studentRoles: [{ id: "participant" }, { id: "class-rep" }],
      },
    }),
    loadEffectiveProgramPurchases: vi.fn().mockResolvedValue([]),
    loadEffectiveProgramPurchasesForUser: vi.fn().mockResolvedValue([]),
    loadEligibleUserIds: vi
      .fn()
      .mockImplementation(async (ids: readonly mongoose.Types.ObjectId[]) =>
        ids.map(String),
      ),
  } as unknown as ProgramMembershipResolverDataSource & {
    loadSettings: ReturnType<typeof vi.fn>;
    loadPrimaryConversationId: ReturnType<typeof vi.fn>;
    loadProgram: ReturnType<typeof vi.fn>;
    loadProgramForUser: ReturnType<typeof vi.fn>;
    loadEffectiveProgramPurchases: ReturnType<typeof vi.fn>;
    loadEffectiveProgramPurchasesForUser: ReturnType<typeof vi.fn>;
    loadEligibleUserIds: ReturnType<typeof vi.fn>;
  };
}

describe("ProgramMembershipResolver", () => {
  let dataSource: ReturnType<typeof createDataSource>;
  let resolver: ProgramMembershipResolver;

  beforeEach(() => {
    dataSource = createDataSource();
    resolver = new ProgramMembershipResolver({
      dataSource,
      now: () => NOW,
    });
  });

  it("merges canonical sources, filters account eligibility, and applies display-role priority", async () => {
    dataSource.loadProgram.mockResolvedValue({
      mentors: [{ userId: USER_IDS[0] }, { userId: USER_IDS[1] }],
      adminEnrollments: {
        classReps: [USER_IDS[1], USER_IDS[2]],
        mentees: [USER_IDS[2], USER_IDS[3]],
      },
      programRoles: {
        studentRoles: [{ id: "participant" }, { id: "class-rep" }],
      },
    });
    dataSource.loadEffectiveProgramPurchases.mockResolvedValue([
      { userId: USER_IDS[3], studentRoleId: "participant" },
      { userId: USER_IDS[4], studentRoleId: "class-rep" },
      { userId: USER_IDS[5] },
      { userId: USER_IDS[6], studentRoleId: "legacy-role" },
    ]);
    dataSource.loadEligibleUserIds.mockResolvedValue(
      USER_IDS.slice(0, 5).map(String),
    );

    const result = await resolver.resolveProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      programId: PROGRAM_ID.toString(),
      conversationId: ROOM_ID.toString(),
      state: "open",
      ignoredPurchases: {
        missingStudentRoleId: 1,
        unmappedStudentRoleId: 1,
      },
      roleMappingDiagnostics: {
        canonicalRoleCount: 2,
        configuredMappingCount: 2,
        invalidCanonicalRoleIdCount: 0,
        duplicateCanonicalRoleIdCount: 0,
        invalidConfiguredMappingCount: 0,
        duplicateConfiguredRoleIdCount: 0,
        missingMappingCount: 0,
        unexpectedMappingCount: 0,
      },
    });
    expect(result.memberships).toEqual([
      {
        userId: USER_IDS[0].toString(),
        role: "mentor",
        sourceKinds: ["mentor_assignment"],
      },
      {
        userId: USER_IDS[1].toString(),
        role: "mentor",
        sourceKinds: [
          "mentor_assignment",
          "admin_class_representative",
        ],
      },
      {
        userId: USER_IDS[2].toString(),
        role: "class_representative",
        sourceKinds: [
          "admin_class_representative",
          "admin_mentee",
        ],
      },
      {
        userId: USER_IDS[3].toString(),
        role: "mentee",
        sourceKinds: ["admin_mentee", "program_purchase"],
      },
      {
        userId: USER_IDS[4].toString(),
        role: "class_representative",
        sourceKinds: ["program_purchase"],
      },
    ]);
  });

  it("resolves one recipient through targeted Program and purchase reads", async () => {
    dataSource.loadProgramForUser.mockResolvedValue({
      mentors: [{ userId: USER_IDS[0] }],
      adminEnrollments: {
        classReps: [USER_IDS[0]],
        mentees: [USER_IDS[0]],
      },
      programRoles: {
        studentRoles: [{ id: "participant" }, { id: "class-rep" }],
      },
    });
    dataSource.loadEffectiveProgramPurchasesForUser.mockResolvedValue([
      { userId: USER_IDS[0], studentRoleId: "participant" },
    ]);
    dataSource.loadEligibleUserIds.mockResolvedValue([USER_IDS[0]!.toString()]);

    const result = await resolver.resolveProgramMember(
      PROGRAM_ID,
      USER_IDS[0]!,
    );

    expect(result).toEqual({
      programId: PROGRAM_ID.toString(),
      conversationId: ROOM_ID.toString(),
      state: "open",
      membership: {
        userId: USER_IDS[0]!.toString(),
        role: "mentor",
        sourceKinds: [
          "mentor_assignment",
          "admin_class_representative",
          "admin_mentee",
          "program_purchase",
        ],
      },
    });
    expect(dataSource.loadProgram).not.toHaveBeenCalled();
    expect(dataSource.loadEffectiveProgramPurchases).not.toHaveBeenCalled();
    expect(dataSource.loadProgramForUser).toHaveBeenCalledWith(
      PROGRAM_ID,
      USER_IDS[0],
      undefined,
    );
    expect(
      dataSource.loadEffectiveProgramPurchasesForUser,
    ).toHaveBeenCalledWith(PROGRAM_ID, USER_IDS[0], undefined);
  });

  it("fails closed for inactive or unverified users", async () => {
    dataSource.loadProgram.mockResolvedValue({
      mentors: [{ userId: USER_IDS[0] }],
      adminEnrollments: { mentees: [USER_IDS[1]], classReps: [] },
      programRoles: {
        studentRoles: [{ id: "participant" }, { id: "class-rep" }],
      },
    });
    dataSource.loadEligibleUserIds.mockResolvedValue([]);

    const result = await resolver.resolveProgram(PROGRAM_ID);

    expect(result.state).toBe("open");
    expect(result.memberships).toEqual([]);
  });

  it.each([
    [{ enabled: false, opensAt: NOW, closesAt: null, archivedAt: null }],
    [
      {
        enabled: true,
        opensAt: new Date("2026-09-01T12:00:00.001Z"),
        closesAt: null,
        archivedAt: null,
      },
    ],
    [
      {
        enabled: true,
        opensAt: new Date("2026-08-01T00:00:00.000Z"),
        closesAt: NOW,
        archivedAt: null,
      },
    ],
    [
      {
        enabled: false,
        opensAt: new Date("2026-08-01T00:00:00.000Z"),
        closesAt: null,
        archivedAt: NOW,
      },
    ],
  ])("does not resolve members while the Program community is closed", async (settings) => {
    dataSource.loadSettings.mockResolvedValue(settings);

    const result = await resolver.resolveProgram(PROGRAM_ID);

    expect(result.state).toBe("closed");
    expect(result.memberships).toEqual([]);
    expect(dataSource.loadPrimaryConversationId).not.toHaveBeenCalled();
  });

  it("distinguishes missing settings, Program, and primary Room", async () => {
    dataSource.loadSettings.mockResolvedValueOnce(null);
    await expect(resolver.resolveProgram(PROGRAM_ID)).resolves.toMatchObject({
      state: "settings_unavailable",
      lifecycleAction: "cutoff",
    });

    dataSource.loadProgram.mockResolvedValueOnce(null);
    await expect(resolver.resolveProgram(PROGRAM_ID)).resolves.toMatchObject({
      state: "program_unavailable",
      lifecycleAction: "archive",
    });

    dataSource.loadPrimaryConversationId.mockResolvedValueOnce(null);
    await expect(resolver.resolveProgram(PROGRAM_ID)).resolves.toMatchObject({
      state: "room_unavailable",
      lifecycleAction: "synchronize",
    });
  });

  it.each([
    {
      name: "missing mapping",
      programRoleIds: ["participant", "class-rep", "new-role"],
      mappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        { studentRoleId: "class-rep", memberRole: "class_representative" },
      ],
      expected: { missingMappingCount: 1 },
    },
    {
      name: "unexpected mapping",
      programRoleIds: ["participant"],
      mappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        { studentRoleId: "removed-role", memberRole: "mentee" },
      ],
      expected: { unexpectedMappingCount: 1 },
    },
    {
      name: "duplicate configured role ID",
      programRoleIds: ["participant"],
      mappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
        { studentRoleId: "participant", memberRole: "class_representative" },
      ],
      expected: { duplicateConfiguredRoleIdCount: 1 },
    },
    {
      name: "invalid configured mapping",
      programRoleIds: ["participant"],
      mappings: [{ studentRoleId: "invalid role", memberRole: "mentee" }],
      expected: { invalidConfiguredMappingCount: 1 },
    },
  ])("fails the entire Program Room closed for $name without leaking role IDs", async ({
    programRoleIds,
    mappings,
    expected,
  }) => {
    dataSource.loadProgram.mockResolvedValue({
      mentors: [{ userId: USER_IDS[0] }],
      adminEnrollments: { mentees: [USER_IDS[1]], classReps: [] },
      programRoles: {
        studentRoles: programRoleIds.map((id) => ({ id })),
      },
    });
    dataSource.loadSettings.mockResolvedValue({
      enabled: true,
      opensAt: new Date("2026-08-01T00:00:00.000Z"),
      closesAt: null,
      archivedAt: null,
      studentRoleMappings: mappings,
    });

    const result = await resolver.resolveProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      state: "role_mapping_invalid",
      conversationId: null,
      memberships: [],
      roleMappingDiagnostics: expected,
    });
    expect(JSON.stringify(result.roleMappingDiagnostics)).not.toMatch(
      /participant|class-rep|new-role|removed-role|invalid role/,
    );
    expect(dataSource.loadPrimaryConversationId).not.toHaveBeenCalled();
    expect(dataSource.loadEffectiveProgramPurchases).not.toHaveBeenCalled();
    expect(dataSource.loadEligibleUserIds).not.toHaveBeenCalled();
  });

  it("accepts role reordering when the canonical and configured ID sets match", async () => {
    dataSource.loadProgram.mockResolvedValue({
      mentors: [],
      adminEnrollments: { mentees: [], classReps: [] },
      programRoles: {
        studentRoles: [{ id: "class-rep" }, { id: "participant" }],
      },
    });

    const result = await resolver.resolveProgram(PROGRAM_ID);

    expect(result.state).toBe("open");
    expect(result.roleMappingDiagnostics).toMatchObject({
      missingMappingCount: 0,
      unexpectedMappingCount: 0,
    });
    expect(dataSource.loadPrimaryConversationId).toHaveBeenCalledTimes(1);
  });

  it("uses normalized IDs for legacy whitespace and duplicate raw Program roles", async () => {
    dataSource.loadProgram.mockResolvedValue({
      mentors: [],
      adminEnrollments: { mentees: [], classReps: [] },
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
    });
    dataSource.loadSettings.mockResolvedValue({
      enabled: true,
      opensAt: new Date("2026-08-01T00:00:00.000Z"),
      closesAt: null,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant-role", memberRole: "mentee" },
        {
          studentRoleId: "participant-role-2",
          memberRole: "class_representative",
        },
      ],
    });
    dataSource.loadEffectiveProgramPurchases.mockResolvedValue([
      {
        userId: USER_IDS[0],
        studentRoleId: "participant-role-2",
      },
    ]);
    dataSource.loadEligibleUserIds.mockResolvedValue([USER_IDS[0]!.toString()]);

    const result = await resolver.resolveProgram(PROGRAM_ID);

    expect(result).toMatchObject({
      state: "open",
      roleMappingDiagnostics: {
        canonicalRoleCount: 2,
        invalidCanonicalRoleIdCount: 0,
        duplicateCanonicalRoleIdCount: 0,
        missingMappingCount: 0,
        unexpectedMappingCount: 0,
      },
      memberships: [
        {
          userId: USER_IDS[0]!.toString(),
          role: "class_representative",
          sourceKinds: ["program_purchase"],
        },
      ],
    });
  });

  it("rejects invalid identifiers and clocks before reading membership data", async () => {
    await expect(resolver.resolveProgram("invalid")).rejects.toThrow(
      "requires a Program ID",
    );
    await expect(
      resolver.resolveProgram(PROGRAM_ID, { now: new Date("invalid") }),
    ).rejects.toThrow("requires a valid time");
    expect(dataSource.loadSettings).not.toHaveBeenCalled();
  });

  it("loads every Program field required by shared role normalization", async () => {
    const resolved = {
      _id: PROGRAM_ID,
      programRoles: { studentRoles: [] },
    };
    const query = {
      select: vi.fn(),
      lean: vi.fn(),
      exec: vi.fn().mockResolvedValue(resolved),
    };
    query.select.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const programModel = { findById: vi.fn().mockReturnValue(query) };
    const source = new MongoProgramMembershipResolverDataSource({
      programModel: programModel as never,
    });

    await expect(source.loadProgram(PROGRAM_ID)).resolves.toBe(resolved);

    const projection = String(query.select.mock.calls[0]?.[0]);
    for (const field of [
      "programRoles.teacherRoleName",
      "programRoles.studentRoles.id",
      "programRoles.studentRoles.name",
      "programRoles.studentRoles.discountEligible",
      "programRoles.studentRoles.discountAmount",
      "programRoles.studentRoles.limit",
      "programRoles.studentRoles.count",
      "classRepDiscount",
      "classRepLimit",
      "classRepCount",
    ]) {
      expect(projection).toContain(field);
    }
  });
});
