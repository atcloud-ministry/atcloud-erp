import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Conversation from "../../../src/models/Conversation";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import User from "../../../src/models/User";
import { ProgramActorRoomReadResolver } from "../../../src/services/programs/ProgramActorRoomReadResolver";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const OPENS_AT = new Date("2026-09-01T00:00:00.000Z");
const CLOSES_AT = new Date("2027-01-01T00:00:00.000Z");
const models = [
  Conversation,
  ProgramCommunitySettings,
  Purchase,
  Program,
  User,
] as const;

async function insertUser(label: string) {
  const _id = new mongoose.Types.ObjectId();
  const username = `m6batch${label}${_id.toString().slice(-6)}`.toLowerCase();
  await User.collection.insertOne({
    _id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    phone: "+12065550199",
    birthYear: 1988,
    password: "Integration1",
    firstName: label,
    lastName: "Member",
    role: "Participant",
    isAtCloudLeader: false,
    isActive: true,
    isVerified: true,
    emailNotifications: false,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return _id;
}

function programDocument(
  _id: mongoose.Types.ObjectId,
  actorId: mongoose.Types.ObjectId,
  source: "mentor" | "class_representative" | "mentee" | "purchase",
) {
  return {
    _id,
    title: `Batch Program ${_id.toString().slice(-6)}`,
    programType: "EMBA Mentor Circles",
    isFree: true,
    fullPriceTicket: 0,
    createdBy: actorId,
    mentors: source === "mentor" ? [{ userId: actorId }] : [],
    adminEnrollments: {
      classReps:
        source === "mentor" || source === "class_representative"
          ? [actorId]
          : [],
      mentees:
        source === "mentor" ||
        source === "class_representative" ||
        source === "mentee"
          ? [actorId]
          : [],
    },
    programRoles: {
      teacherRoleName: "Mentor",
      studentRoles: [
        { id: "participant", name: "Participant" },
        { id: "class-rep", name: "Class Representative" },
      ],
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function settingsDocument(
  programId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {},
) {
  return {
    _id: new mongoose.Types.ObjectId(),
    programId,
    enabled: true,
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    archivedAt: null,
    studentRoleMappings: [
      { studentRoleId: "participant", memberRole: "mentee" },
      { studentRoleId: "class-rep", memberRole: "class_representative" },
    ],
    membershipFenceRevision: 1,
    membershipProjectionRevision: 1,
    membershipProjectionState: "open",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Program actor Room batch read resolution integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("resolves mixed canonical sources in one actor-scoped batch and fails closed", async () => {
    const actorId = await insertUser("actor");
    const outsiderId = await insertUser("outsider");
    const programIds = Array.from(
      { length: 6 },
      () => new mongoose.Types.ObjectId(),
    );
    const roomIds = Array.from(
      { length: 6 },
      () => new mongoose.Types.ObjectId(),
    );
    await Program.collection.insertMany([
      programDocument(programIds[0]!, actorId, "mentor"),
      programDocument(programIds[1]!, actorId, "class_representative"),
      programDocument(programIds[2]!, actorId, "mentee"),
      programDocument(programIds[3]!, actorId, "purchase"),
      programDocument(programIds[4]!, actorId, "mentee"),
      programDocument(programIds[5]!, actorId, "mentee"),
    ]);
    await ProgramCommunitySettings.collection.insertMany([
      settingsDocument(programIds[0]!),
      settingsDocument(programIds[1]!),
      settingsDocument(programIds[2]!),
      settingsDocument(programIds[3]!),
      settingsDocument(programIds[4]!, { enabled: false }),
      settingsDocument(programIds[5]!, {
        studentRoleMappings: [
          { studentRoleId: "participant", memberRole: "mentee" },
        ],
      }),
    ]);
    await Conversation.collection.insertMany(
      programIds.map((programId, index) => ({
        _id: roomIds[index],
        kind: "program",
        status: "current",
        programId,
        helpRequestId: null,
        lastSequence: 0,
        lastMessageId: null,
        latestMessagePurgeAt: null,
        archivedAt: null,
        purgeAt: null,
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    );
    await Purchase.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        userId: actorId,
        purchaseType: "program",
        programId: programIds[3],
        studentRoleId: "class-rep",
        status: "completed",
        orderNumber: "M6-BATCH-ACTOR",
        purchaseDate: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        userId: outsiderId,
        purchaseType: "program",
        programId: programIds[3],
        studentRoleId: "participant",
        status: "completed",
        orderNumber: "M6-BATCH-OUTSIDER",
        purchaseDate: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const roles = [
      "mentor",
      "class_representative",
      "mentee",
      "class_representative",
      "mentee",
      "mentee",
    ] as const;
    const candidates = programIds.map((programId, index) => ({
      programId,
      conversationId: roomIds[index]!,
      materializedRole: roles[index]!,
    }));
    const resolver = new ProgramActorRoomReadResolver({ now: () => NOW });

    await expect(
      resolver.resolveEligibleRooms(actorId, candidates),
    ).resolves.toEqual(
      [0, 1, 2, 3].map((index) => ({
        programId: programIds[index]!.toString(),
        conversationId: roomIds[index]!.toString(),
        role: roles[index],
      })),
    );

    await User.collection.updateOne(
      { _id: actorId },
      { $set: { isActive: false } },
    );
    await expect(
      resolver.resolveEligibleRooms(actorId, candidates),
    ).resolves.toEqual([]);
  });

  it("requires the candidate Room ID and materialized role to match canonical state", async () => {
    const actorId = await insertUser("actor");
    const programId = new mongoose.Types.ObjectId();
    const roomId = new mongoose.Types.ObjectId();
    await Program.collection.insertOne(
      programDocument(programId, actorId, "mentor"),
    );
    await ProgramCommunitySettings.collection.insertOne(
      settingsDocument(programId),
    );
    await Conversation.collection.insertOne({
      _id: roomId,
      kind: "program",
      status: "current",
      programId,
      helpRequestId: null,
      lastSequence: 0,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const resolver = new ProgramActorRoomReadResolver({ now: () => NOW });

    await expect(
      resolver.resolveEligibleRooms(actorId, [
        {
          programId,
          conversationId: new mongoose.Types.ObjectId(),
          materializedRole: "mentor",
        },
      ]),
    ).resolves.toEqual([]);
    await expect(
      resolver.resolveEligibleRooms(actorId, [
        { programId, conversationId: roomId, materializedRole: "mentee" },
      ]),
    ).resolves.toEqual([]);
  });
});
