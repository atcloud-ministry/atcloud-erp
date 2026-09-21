import mongoose, { type ClientSession, type Model } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  isProgramCommunityOpen,
  parseUpdateProgramCommunitySettingsBody,
  ProgramCommunitySettingsValidationError,
} from "../../../src/contracts/programCommunitySettings";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import type { IConversation } from "../../../src/models/Conversation";
import {
  ProgramRoomProvisioner,
  ProgramRoomProvisioningConflictError,
} from "../../../src/services/programs/ProgramRoomProvisioner";

const PROGRAM_ID = new mongoose.Types.ObjectId();
const ROOM_ID = new mongoose.Types.ObjectId();
const NOW = new Date("2026-09-12T16:00:00.000Z");

function validBody() {
  return {
    enabled: true,
    opensAt: "2026-09-12T15:00:00.000Z",
    closesAt: "2026-12-01T00:00:00.000Z",
    studentRoleMappings: [
      { studentRoleId: "mentee", memberRole: "mentee" },
      {
        studentRoleId: "class-rep",
        memberRole: "class_representative",
      },
    ],
    expectedRevision: 0,
  };
}

describe("Program community settings contract", () => {
  it("parses the exact settings replacement body into UTC instants", () => {
    const parsed = parseUpdateProgramCommunitySettingsBody(validBody());
    expect(parsed).toMatchObject({ enabled: true, expectedRevision: 0 });
    expect(parsed.opensAt?.toISOString()).toBe("2026-09-12T15:00:00.000Z");
    expect(parsed.closesAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(parsed.studentRoleMappings).toEqual(validBody().studentRoleMappings);

    const leapDay = parseUpdateProgramCommunitySettingsBody({
      ...validBody(),
      opensAt: "2028-02-29T12:00:00.1Z",
      closesAt: null,
    });
    expect(leapDay.opensAt?.toISOString()).toBe("2028-02-29T12:00:00.100Z");
  });

  it.each([
    [{ ...validBody(), archivedAt: null }],
    [{ ...validBody(), opensAt: "2026-09-12T08:00:00-07:00" }],
    [{ ...validBody(), opensAt: "2026-02-30T12:00:00.000Z" }],
    [{ ...validBody(), opensAt: "2026-04-31T12:00:00.000Z" }],
    [{ ...validBody(), opensAt: "2026-09-12T24:00:00.000Z" }],
    [{ ...validBody(), opensAt: null }],
    [{ ...validBody(), enabled: false, opensAt: null }],
    [
      {
        ...validBody(),
        closesAt: "2026-09-12T14:59:59.000Z",
      },
    ],
    [
      {
        ...validBody(),
        studentRoleMappings: [
          { studentRoleId: "mentee", memberRole: "mentee" },
          { studentRoleId: "mentee", memberRole: "class_representative" },
        ],
      },
    ],
  ])("rejects malformed or lifecycle-owned input", (body) => {
    expect(() => parseUpdateProgramCommunitySettingsBody(body)).toThrow(
      ProgramCommunitySettingsValidationError,
    );
  });

  it("rejects more than 100 role mappings at the request boundary", () => {
    expect(() =>
      parseUpdateProgramCommunitySettingsBody({
        ...validBody(),
        studentRoleMappings: Array.from({ length: 101 }, (_, index) => ({
          studentRoleId: `role-${index}`,
          memberRole: "mentee",
        })),
      }),
    ).toThrow(ProgramCommunitySettingsValidationError);
  });

  it("uses one fail-closed open predicate for invalid stored instants", () => {
    expect(
      isProgramCommunityOpen(
        {
          enabled: true,
          opensAt: "2026-09-12T15:00:00.000Z",
          closesAt: null,
          archivedAt: null,
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      isProgramCommunityOpen(
        {
          enabled: true,
          opensAt: "2026-09-12T15:00:00.000Z",
          closesAt: "corrupt",
          archivedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      isProgramCommunityOpen(
        {
          enabled: true,
          opensAt: "corrupt",
          closesAt: null,
          archivedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      isProgramCommunityOpen(
        {
          enabled: true,
          opensAt: "2026-02-30T15:00:00.000Z",
          closesAt: null,
          archivedAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("ProgramCommunitySettings model", () => {
  it("keeps an internal non-negative membership generation", async () => {
    const settings = new ProgramCommunitySettings({
      programId: PROGRAM_ID,
      enabled: false,
      studentRoleMappings: [],
    });
    expect(settings.membershipFenceRevision).toBe(0);
    expect(settings.membershipProjectionRevision).toBe(0);
    expect(settings.membershipProjectionState).toBe("pending");
    await expect(settings.validate()).resolves.toBeUndefined();

    settings.membershipFenceRevision = -1;
    await expect(settings.validate()).rejects.toThrow(
      "membershipFenceRevision",
    );

    settings.membershipFenceRevision = 0;
    settings.membershipProjectionRevision = -1;
    await expect(settings.validate()).rejects.toThrow(
      "membershipProjectionRevision",
    );
  });

  it("validates lifecycle dates and unique student-role mappings", async () => {
    await expect(
      new ProgramCommunitySettings({
        programId: PROGRAM_ID,
        enabled: true,
        opensAt: NOW,
        closesAt: new Date("2026-09-13T16:00:00.000Z"),
        studentRoleMappings: validBody().studentRoleMappings,
      }).validate(),
    ).resolves.toBeUndefined();

    await expect(
      new ProgramCommunitySettings({
        programId: PROGRAM_ID,
        enabled: true,
        opensAt: NOW,
        archivedAt: NOW,
        studentRoleMappings: validBody().studentRoleMappings,
      }).validate(),
    ).rejects.toThrow("cannot be enabled");

    await expect(
      new ProgramCommunitySettings({
        programId: PROGRAM_ID,
        enabled: false,
        opensAt: null,
        closesAt: NOW,
        studentRoleMappings: [],
      }).validate(),
    ).rejects.toThrow("closesAt requires opensAt");

    await expect(
      new ProgramCommunitySettings({
        programId: PROGRAM_ID,
        enabled: false,
        opensAt: new Date("2026-10-01T00:00:00.000Z"),
        archivedAt: NOW,
        studentRoleMappings: [],
      }).validate(),
    ).resolves.toBeUndefined();

    await expect(
      new ProgramCommunitySettings({
        programId: PROGRAM_ID,
        enabled: false,
        studentRoleMappings: [
          { studentRoleId: "mentee", memberRole: "mentee" },
          { studentRoleId: "mentee", memberRole: "mentee" },
        ],
      }).validate(),
    ).rejects.toThrow("mapped only once");
  });

  it("declares one Program identity and an open-scan index without a Room pointer", () => {
    expect(ProgramCommunitySettings.schema.path("primaryConversationId")).toBeUndefined();
    expect(ProgramCommunitySettings.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { programId: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_program_community_settings_program",
          }),
        ],
        [
          {
            enabled: 1,
            archivedAt: 1,
            opensAt: 1,
            closesAt: 1,
            programId: 1,
          },
          expect.objectContaining({
            name: "idx_program_community_settings_open_scan",
          }),
        ],
        [
          {
            membershipProjectionState: 1,
            membershipProjectionRevision: 1,
            _id: 1,
          },
          expect.objectContaining({
            name: "idx_program_community_membership_repair",
          }),
        ],
      ]),
    );
  });
});

describe("ProgramRoomProvisioner", () => {
  const session = { inTransaction: () => true } as ClientSession;
  const resolvedPreflight = () => ({
    assertResolvedInTransaction: vi.fn().mockResolvedValue(undefined),
  });

  it("uses Program identity as the idempotent primary-Room key", async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue({
      _id: ROOM_ID,
      kind: "program",
      status: "current",
      programId: PROGRAM_ID,
      helpRequestId: null,
      archivedAt: null,
      purgeAt: null,
    });
    const purchaseRolePreflight = resolvedPreflight();
    const provisioner = new ProgramRoomProvisioner({
      conversationModel: { findOneAndUpdate } as unknown as Model<IConversation>,
      purchaseRolePreflight,
    });

    await expect(
      provisioner.ensurePrimaryRoomInTransaction({
        programId: PROGRAM_ID,
        provisionedAt: NOW,
        session,
      }),
    ).resolves.toEqual(ROOM_ID);
    expect(
      purchaseRolePreflight.assertResolvedInTransaction,
    ).toHaveBeenCalledWith(PROGRAM_ID, session);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { programId: PROGRAM_ID },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          kind: "program",
          programId: PROGRAM_ID,
          lastSequence: 0,
        }),
      }),
      expect.objectContaining({ upsert: true, new: true, session }),
    );
  });

  it("rejects inactive transactions and retained archived Rooms", async () => {
    const provisioner = new ProgramRoomProvisioner({
      conversationModel: {
        findOneAndUpdate: vi.fn().mockResolvedValue({
          _id: ROOM_ID,
          kind: "program",
          status: "archived",
          programId: PROGRAM_ID,
          helpRequestId: null,
          archivedAt: NOW,
          purgeAt: new Date("2028-09-12T16:00:00.000Z"),
        }),
      } as unknown as Model<IConversation>,
      purchaseRolePreflight: resolvedPreflight(),
    });

    await expect(
      provisioner.ensurePrimaryRoomInTransaction({
        programId: PROGRAM_ID,
        provisionedAt: NOW,
        session: { inTransaction: () => false } as ClientSession,
      }),
    ).rejects.toThrow("requires a transaction");
    await expect(
      provisioner.ensurePrimaryRoomInTransaction({
        programId: PROGRAM_ID,
        provisionedAt: NOW,
        session,
      }),
    ).rejects.toBeInstanceOf(ProgramRoomProvisioningConflictError);
  });

  it("does not provision a Room while purchase roles are unresolved", async () => {
    const findOneAndUpdate = vi.fn();
    const preflightError = new Error("unresolved");
    const provisioner = new ProgramRoomProvisioner({
      conversationModel: { findOneAndUpdate } as unknown as Model<IConversation>,
      purchaseRolePreflight: {
        assertResolvedInTransaction: vi.fn().mockRejectedValue(preflightError),
      },
    });

    await expect(
      provisioner.ensurePrimaryRoomInTransaction({
        programId: PROGRAM_ID,
        provisionedAt: NOW,
        session,
      }),
    ).rejects.toBe(preflightError);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});
