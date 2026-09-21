import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { io as createSocketClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../../../src/app";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../../src/config/alumniProfilePublicationConsent";
import { chatMessagePurgeAt } from "../../../src/contracts/chatRooms";
import { TokenService } from "../../../src/middleware/auth";
import { MIGRATION_REGISTRY } from "../../../src/migrations/registry";
import AlumniAffiliation from "../../../src/models/AlumniAffiliation";
import AlumniProfile from "../../../src/models/AlumniProfile";
import AuditLog from "../../../src/models/AuditLog";
import ChatMessage from "../../../src/models/ChatMessage";
import ConsentRecord from "../../../src/models/ConsentRecord";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import FeatureControl, {
  FEATURE_CONTROL_SINGLETON_ID,
} from "../../../src/models/FeatureControl";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import Program from "../../../src/models/Program";
import ProgramCommunitySettings from "../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../src/models/Purchase";
import SchemaMigration from "../../../src/models/SchemaMigration";
import User from "../../../src/models/User";
import { chatMessageDeliveryHandler } from "../../../src/services/chat/ChatMessageDeliveryHandler";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { buildAlumniProfileSearchProjection } from "../../../src/services/alumni/AlumniProfileProjectionService";
import { NotificationOutboxDeliveryRegistry } from "../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import { notificationOutboxService } from "../../../src/services/reliability/NotificationOutboxService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { NotificationOutboxWorker } from "../../../src/services/reliability/NotificationOutboxWorker";
import { NotificationOutboxWorkerAuthorization } from "../../../src/services/reliability/NotificationOutboxWorkerAuthorization";
import {
  deriveAlumniAffiliationKey,
} from "../../../src/contracts/alumniDirectoryData";
import type {
  ChatMessageUpdate,
  ChatUnreadUpdate,
  ConversationRoomAck,
} from "../../../src/types/realtime";
import { clearIntegrationDB, ensureIntegrationDB } from "../setup/connect";

/**
 * G1 release qualification is deliberately only runnable through the guarded
 * loopback rs0 harness. It combines the approved Directory, Room, message,
 * announcement, and Socket.IO dimensions in one database so isolated happy
 * paths cannot conceal a coexistence regression.
 */
const APPROVED_PROFILE = process.env.G1_RELEASE_CAPACITY_PROFILE === "approved";
const PROFILE = Object.freeze(
  APPROVED_PROFILE
    ? {
        name: "approved",
        users: 2_000,
        publishedProfiles: 500,
        programs: 500,
        openPrograms: 50,
        conversations: 5_000,
        messages: 1_000_000,
        programMemberCapacity: 500,
        announcementRecipients: 500,
        realtimeUsers: 250,
        socketConnections: 500,
        listHelpRooms: 30,
        httpSamples: 20,
        sendActors: 250,
        sendSeconds: 5 * 60,
        sendsPerSecond: 20,
      }
    : {
        name: "smoke",
        users: 600,
        publishedProfiles: 100,
        programs: 20,
        openPrograms: 5,
        conversations: 100,
        messages: 5_000,
        programMemberCapacity: 50,
        announcementRecipients: 50,
        realtimeUsers: 10,
        socketConnections: 20,
        listHelpRooms: 10,
        httpSamples: 5,
        sendActors: 10,
        sendSeconds: 2,
        sendsPerSecond: 20,
      },
);

const INSERT_BATCH_SIZE = 5_000;
const HTTP_P95_MAX_MS = 1_000;
const ACK_P95_MAX_MS = 1_500;
const ACK_P99_MAX_MS = 3_000;
const REQUEST_TIMEOUT_MS = 3_000;
const SOCKET_TIMEOUT_MS = 30_000;
const NOW = new Date();
const MESSAGE_PURGE_AT = chatMessagePurgeAt(NOW);

const models = [
  AlumniAffiliation,
  AlumniProfile,
  AuditLog,
  ChatMessage,
  ConsentRecord,
  ConversationMember,
  Conversation,
  FeatureControl,
  IdempotencyRecord,
  NotificationOutbox,
  ProgramCommunitySettings,
  Purchase,
  Program,
  SchemaMigration,
  User,
] as const;

interface CapacityUser {
  readonly id: mongoose.Types.ObjectId;
  readonly email: string;
  readonly role: "Leader" | "Participant";
  readonly token: string;
}

interface RoomPair {
  readonly first: mongoose.Types.ObjectId;
  readonly second: mongoose.Types.ObjectId;
}

interface SendRoom {
  readonly conversationId: mongoose.Types.ObjectId;
  readonly sender: CapacityUser;
}

interface JsonResponse<T> {
  readonly status: number;
  readonly body: T;
}

type SuccessEnvelope<T> = {
  readonly success: true;
  readonly data: T;
};

interface SocketObservation {
  readonly userIndex: number;
  readonly socket: ClientSocket;
  readonly messages: ChatMessageUpdate[];
  readonly unreads: ChatUnreadUpdate[];
}

let server: Server | null = null;
let origin = "";
let previousReleaseFlag: string | undefined;
let users: CapacityUser[] = [];
let programRoomIds: mongoose.Types.ObjectId[] = [];
let helpRoomIds: mongoose.Types.ObjectId[] = [];
let roomIds: mongoose.Types.ObjectId[] = [];
let roomPairs: RoomPair[] = [];
let sendRooms: SendRoom[] = [];
let historyRoomId: mongoose.Types.ObjectId;
let fanoutRoomId: mongoose.Types.ObjectId;
const clients: ClientSocket[] = [];

function percentile(samples: readonly number[], value: number): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]!;
}

function deterministicUuid(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function chunks<T>(items: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitUntil(
  description: string,
  predicate: () => boolean,
  timeoutMs = SOCKET_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await wait(20);
  }
}

function withTimeout<T>(
  description: string,
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}.`)),
      SOCKET_TIMEOUT_MS,
    );
    timer.unref?.();
    subscribe(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForConnection(socket: ClientSocket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return withTimeout<void>("Socket.IO connection", (resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

function waitForDisconnect(socket: ClientSocket): Promise<void> {
  if (!socket.connected) return Promise.resolve();
  return withTimeout<void>("Socket.IO disconnect", (resolve) => {
    socket.once("disconnect", () => resolve());
  });
}

function joinConversation(
  socket: ClientSocket,
  conversationId: string,
): Promise<Parameters<ConversationRoomAck>[0]> {
  return withTimeout<Parameters<ConversationRoomAck>[0]>(
    "conversation room acknowledgement",
    (resolve) => socket.emit("join_conversation_room", conversationId, resolve),
  );
}

function connectClient(token: string): ClientSocket {
  return createSocketClient(origin, {
    path: "/socket.io/",
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
    reconnection: false,
  });
}

function observeSocket(userIndex: number, socket: ClientSocket): SocketObservation {
  const observation: SocketObservation = {
    userIndex,
    socket,
    messages: [],
    unreads: [],
  };
  socket.on("chat_message", (payload: ChatMessageUpdate) => {
    observation.messages.push(payload);
  });
  socket.on("chat_unread_update", (payload: ChatUnreadUpdate) => {
    observation.unreads.push(payload);
  });
  clients.push(socket);
  return observation;
}

async function jsonRequest<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse<T>> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  return {
    status: response.status,
    body: (await response.json()) as T,
  };
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "TimeoutError",
  );
}

function assertGuardedLoopbackConfiguration(): void {
  const uri = process.env.MONGODB_TEST_URI;
  if (
    !uri ||
    !/^mongodb:\/\/127\.0\.0\.1:27018\/atcloud_g1_capacity_test_[A-Za-z0-9_-]+\?replicaSet=rs0$/u.test(
      uri,
    ) ||
    process.env.VITEST_DB_ISOLATION !== "false"
  ) {
    throw new Error(
      "G1 capacity qualification requires the guarded loopback rs0 runner and an isolated atcloud_g1_capacity_test database.",
    );
  }
}

async function seedAppliedMigrationLedger(): Promise<void> {
  await SchemaMigration.collection.insertMany(
    MIGRATION_REGISTRY.map((definition) => ({
      _id: definition.id,
      migrationId: definition.id,
      description: definition.description,
      checksum: definition.checksum,
      status: "applied",
      direction: "up",
      applyCheckpoint: null,
      rollbackCheckpoint: null,
      counts: {
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
      attempt: 1,
      runId: "22222222-2222-4222-8222-222222222222",
      operator: "g1-release-capacity-qualification",
      appVersion: "g1-capacity",
      runStartedAt: NOW,
      runFinishedAt: NOW,
      lastHeartbeatAt: NOW,
      appliedAt: NOW,
      rolledBackAt: null,
      rollbackReasonCode: null,
      lastError: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
}

function userDocument(id: mongoose.Types.ObjectId, index: number) {
  const username = `g1cap${index.toString().padStart(4, "0")}`;
  return {
    _id: id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    phone: "+12065550199",
    birthYear: 1970 + (index % 45),
    password: "g1-capacity-test-only",
    firstName: "Capacity",
    lastName: `Alumni ${index.toString().padStart(4, "0")}`,
    avatar: null,
    residenceCity: index % 2 === 0 ? "Seattle" : "Bellevue",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: `Capacity Company ${index % 10}`,
    occupation: "Product Manager",
    role: index === 0 ? "Leader" : "Participant",
    isAtCloudLeader: index === 0,
    isActive: true,
    isVerified: true,
    emailNotifications: false,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function seedUsers(): Promise<void> {
  const ids = Array.from(
    { length: PROFILE.users },
    () => new mongoose.Types.ObjectId(),
  );
  await User.collection.insertMany(ids.map(userDocument));
  users = ids.map((id, index) => {
    const email = `g1cap${index.toString().padStart(4, "0")}@private.example.org`;
    const role = index === 0 ? "Leader" : "Participant";
    return Object.freeze({
      id,
      email,
      role,
      token: TokenService.generateAccessToken({
        userId: id.toString(),
        email,
        role,
      }),
    });
  });
}

async function seedDirectory(): Promise<void> {
  const profiles: Record<string, unknown>[] = [];
  const consents: Record<string, unknown>[] = [];
  const affiliations: Record<string, unknown>[] = [];
  for (let index = 0; index < PROFILE.publishedProfiles; index += 1) {
    const profileId = new mongoose.Types.ObjectId();
    const consentId = new mongoose.Types.ObjectId();
    const affiliationId = new mongoose.Types.ObjectId();
    const cohortLabel = String(2032 + (index % 5));
    const affiliationSource = {
      programName: `Capacity Program ${index % PROFILE.openPrograms}`,
      cohortLabel,
    };
    const userSource = {
      username: `g1cap${index.toString().padStart(4, "0")}`,
      firstName: "Capacity",
      lastName: `Alumni ${index.toString().padStart(4, "0")}`,
      company: `Capacity Company ${index % 10}`,
      occupation: "Product Manager",
      residenceCity: index % 2 === 0 ? "Seattle" : "Bellevue",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
    };
    const profileSource = {
      professionalHeadline: `Capacity professional ${index}`,
      industry: index % 2 === 0 ? "Technology" : "Education",
      skills: [index % 2 === 0 ? "Cloud Architecture" : "Career Coaching"],
    };
    profiles.push({
      _id: profileId,
      userId: users[index]!.id,
      ...profileSource,
      bio: null,
      helpOfferings: {
        careerAdvice: true,
        warmIntroduction: index % 3 === 0,
        formalEmployeeReferral: index % 5 === 0,
      },
      publishStatus: "published",
      currentPublicationConsentId: consentId,
      searchProjection: buildAlumniProfileSearchProjection({
        user: userSource,
        profile: profileSource,
        affiliations: [affiliationSource],
      }),
      publishedAt: NOW,
      withdrawnAt: null,
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    consents.push({
      _id: consentId,
      subjectUserId: users[index]!.id,
      alumniProfileId: profileId,
      purpose: "alumni_profile_publication",
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
      status: "active",
      acceptedAt: NOW,
      supersededAt: null,
      supersededByConsentId: null,
      withdrawnAt: null,
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    affiliations.push({
      _id: affiliationId,
      alumniProfileId: profileId,
      ...affiliationSource,
      affiliationKey: deriveAlumniAffiliationKey(affiliationSource),
      verificationStatus: "verified",
      reviewedAt: NOW,
      reviewedBy: users[0]!.id,
      accountDeletionApprovedAt: null,
      purgeAt: null,
      revision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  await Promise.all([
    AlumniProfile.collection.insertMany(profiles),
    ConsentRecord.collection.insertMany(consents),
    AlumniAffiliation.collection.insertMany(affiliations),
  ]);
}

function memberDocument(
  conversationId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  role: "mentor" | "mentee" | "requester" | "provider",
) {
  return {
    _id: new mongoose.Types.ObjectId(),
    conversationId,
    userId,
    role,
    status: "active",
    joinedAt: NOW,
    accessWindows: [
      {
        visibleFromSequence: 1,
        visibleThroughSequence: null,
        openedAt: NOW,
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
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function seedProgramsRoomsAndMembers(): Promise<void> {
  const programIds = Array.from(
    { length: PROFILE.programs },
    () => new mongoose.Types.ObjectId(),
  );
  programRoomIds = Array.from(
    { length: PROFILE.openPrograms },
    () => new mongoose.Types.ObjectId(),
  );
  const opensAt = new Date(NOW.getTime() - 60 * 60_000);
  const closesAt = new Date(NOW.getTime() + 2 * 60 * 60_000);
  const fanoutMentees = users
    .slice(1, PROFILE.announcementRecipients + 1)
    .map(({ id }) => id);
  const capacityMentees = users
    .slice(1, PROFILE.programMemberCapacity)
    .map(({ id }) => id);

  await Program.collection.insertMany(
    programIds.map((_id, index) => ({
      _id,
      title: `G1 Capacity Program ${index}`,
      programType: "EMBA Mentor Circles",
      hostedBy: "@Cloud Marketplace Ministry",
      isFree: true,
      fullPriceTicket: 0,
      classRepDiscount: 0,
      earlyBirdDiscount: 0,
      classRepLimit: 0,
      classRepCount: 0,
      mentors: index < PROFILE.openPrograms ? [{ userId: users[0]!.id }] : [],
      adminEnrollments: {
        classReps: [],
        mentees:
          index === 0
            ? fanoutMentees
            : index === 1
              ? capacityMentees
              : [],
      },
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
        ],
      },
      createdBy: users[0]!.id,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
  await ProgramCommunitySettings.collection.insertMany(
    programIds.map((programId, index) => ({
      _id: new mongoose.Types.ObjectId(),
      programId,
      enabled: index < PROFILE.openPrograms,
      opensAt: index < PROFILE.openPrograms ? opensAt : null,
      closesAt: index < PROFILE.openPrograms ? closesAt : null,
      archivedAt: null,
      studentRoleMappings: [
        { studentRoleId: "participant", memberRole: "mentee" },
      ],
      membershipFenceRevision: 1,
      membershipProjectionRevision: 1,
      membershipProjectionState: index < PROFILE.openPrograms ? "open" : "cutoff",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  );
  await Conversation.collection.insertMany(
    programRoomIds.map((_id, index) => ({
      _id,
      kind: "program",
      status: "current",
      programId: programIds[index],
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

  const programMembers: Record<string, unknown>[] = [];
  const programPairs: RoomPair[] = [];
  for (let index = 0; index < programRoomIds.length; index += 1) {
    const conversationId = programRoomIds[index]!;
    programMembers.push(memberDocument(conversationId, users[0]!.id, "mentor"));
    if (index === 0) {
      for (const userId of fanoutMentees) {
        programMembers.push(memberDocument(conversationId, userId, "mentee"));
      }
      programPairs.push(Object.freeze({ first: users[0]!.id, second: fanoutMentees[0]! }));
    } else if (index === 1) {
      for (const userId of capacityMentees) {
        programMembers.push(memberDocument(conversationId, userId, "mentee"));
      }
      programPairs.push(Object.freeze({ first: users[0]!.id, second: capacityMentees[0]! }));
    } else {
      const partner = users[(index % (users.length - 1)) + 1]!.id;
      programMembers.push(memberDocument(conversationId, partner, "mentee"));
      programPairs.push(Object.freeze({ first: users[0]!.id, second: partner }));
    }
  }

  const helpRoomCount = PROFILE.conversations - PROFILE.openPrograms;
  helpRoomIds = Array.from(
    { length: helpRoomCount },
    () => new mongoose.Types.ObjectId(),
  );
  await Conversation.collection.insertMany(
    helpRoomIds.map((_id) => ({
      _id,
      kind: "alumni_help",
      status: "current",
      helpRequestId: new mongoose.Types.ObjectId(),
      programId: null,
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
  const helpMembers: Record<string, unknown>[] = [];
  const helpPairs: RoomPair[] = [];
  for (let index = 0; index < helpRoomIds.length; index += 1) {
    const conversationId = helpRoomIds[index]!;
    let first: mongoose.Types.ObjectId;
    let second: mongoose.Types.ObjectId;
    if (index < PROFILE.listHelpRooms) {
      first = users[0]!.id;
      second = users[PROFILE.announcementRecipients + 1 + (index % 20)]!.id;
    } else {
      const senderIndex =
        1 + ((index - PROFILE.listHelpRooms) % PROFILE.sendActors);
      first = users[senderIndex]!.id;
      second = users[
        PROFILE.announcementRecipients +
          1 +
          ((index - PROFILE.listHelpRooms) % (users.length - PROFILE.announcementRecipients - 1))
      ]!.id;
      if (first.equals(second)) {
        second = users[(senderIndex + PROFILE.announcementRecipients + 1) % users.length]!.id;
      }
    }
    helpMembers.push(memberDocument(conversationId, first, "requester"));
    helpMembers.push(memberDocument(conversationId, second, "provider"));
    helpPairs.push(Object.freeze({ first, second }));
  }
  await ConversationMember.collection.insertMany([...programMembers, ...helpMembers]);

  roomIds = [...programRoomIds, ...helpRoomIds];
  roomPairs = [...programPairs, ...helpPairs];
  historyRoomId = helpRoomIds[0]!;
  fanoutRoomId = programRoomIds[0]!;
  sendRooms = Array.from({ length: PROFILE.sendActors }, (_unused, index) => {
    const roomIndex = PROFILE.listHelpRooms + index;
    const sender = users[1 + index]!;
    return Object.freeze({
      conversationId: helpRoomIds[roomIndex]!,
      sender,
    });
  });
}

async function seedMessages(): Promise<void> {
  const basePerRoom = Math.floor(PROFILE.messages / roomIds.length);
  const extraRooms = PROFILE.messages % roomIds.length;
  const roomUpdates: Parameters<typeof Conversation.collection.bulkWrite>[0] = [];
  let batch: Record<string, unknown>[] = [];
  let globalIndex = 1;
  for (let roomIndex = 0; roomIndex < roomIds.length; roomIndex += 1) {
    const conversationId = roomIds[roomIndex]!;
    const pair = roomPairs[roomIndex]!;
    const count = basePerRoom + (roomIndex < extraRooms ? 1 : 0);
    let lastMessageId: mongoose.Types.ObjectId | null = null;
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const _id = new mongoose.Types.ObjectId();
      const senderId = sequence % 2 === 0 ? pair.second : pair.first;
      lastMessageId = _id;
      batch.push({
        _id,
        conversationId,
        sequence,
        senderId,
        senderSnapshot: {
          displayName: `Capacity Sender ${senderId.toString().slice(-6)}`,
          avatar: null,
        },
        clientMessageId: deterministicUuid(globalIndex),
        kind: "text",
        content: `g1-capacity-retained-message-${globalIndex}`,
        safeLink: null,
        createdAt: NOW,
        purgeAt: MESSAGE_PURGE_AT,
      });
      globalIndex += 1;
      if (batch.length === INSERT_BATCH_SIZE) {
        await ChatMessage.collection.insertMany(batch, { ordered: true });
        batch = [];
      }
    }
    roomUpdates.push({
      updateOne: {
        filter: { _id: conversationId },
        update: {
          $set: {
            lastSequence: count,
            lastMessageId,
            latestMessagePurgeAt: MESSAGE_PURGE_AT,
            updatedAt: NOW,
          },
        },
      },
    });
  }
  if (batch.length > 0) {
    await ChatMessage.collection.insertMany(batch, { ordered: true });
  }
  await Conversation.collection.bulkWrite(roomUpdates, { ordered: false });
}

async function startLoopbackServer(): Promise<void> {
  previousReleaseFlag = process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE;
  process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE = "true";
  server = createServer(app);
  socketService.initialize(server);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("G1 capacity server did not bind a loopback TCP port.");
  }
  origin = `http://127.0.0.1:${address.port}`;
}

async function assertHttpReadP95(): Promise<void> {
  const actor = users[0]!;
  const directoryPaths = [
    "/api/directory?page=1&limit=24",
    "/api/directory?page=1&limit=100&company=Capacity%20Company%205",
    "/api/directory?page=1&limit=24&q=Capacity%20Alumni%200499",
    "/api/directory?page=1&limit=100&offering=career_advice",
    "/api/directory?page=1&limit=100&cohort=2032",
  ] as const;
  const roomListPath = "/api/conversations?view=current&page=1&limit=30";
  const historyPath = `/api/conversations/${historyRoomId.toString()}/messages?limit=50`;
  for (const path of directoryPaths) {
    await expect(jsonRequest<SuccessEnvelope<unknown>>(actor.token, path)).resolves.toMatchObject({
      status: 200,
    });
  }
  await expect(jsonRequest<SuccessEnvelope<unknown>>(actor.token, roomListPath)).resolves.toMatchObject({
    status: 200,
  });
  await expect(jsonRequest<SuccessEnvelope<unknown>>(actor.token, historyPath)).resolves.toMatchObject({
    status: 200,
  });

  const directoryLatencies: number[] = [];
  const roomListLatencies: number[] = [];
  const historyLatencies: number[] = [];
  for (let sample = 0; sample < PROFILE.httpSamples; sample += 1) {
    let started = performance.now();
    const directory = await jsonRequest<SuccessEnvelope<unknown>>(
      actor.token,
      directoryPaths[sample % directoryPaths.length]!,
    );
    directoryLatencies.push(performance.now() - started);
    expect(directory.status).toBe(200);

    started = performance.now();
    const roomList = await jsonRequest<SuccessEnvelope<unknown>>(
      actor.token,
      roomListPath,
    );
    roomListLatencies.push(performance.now() - started);
    expect(roomList.status).toBe(200);

    started = performance.now();
    const history = await jsonRequest<SuccessEnvelope<unknown>>(
      actor.token,
      historyPath,
    );
    historyLatencies.push(performance.now() - started);
    expect(history.status).toBe(200);
  }
  const directoryP95 = percentile(directoryLatencies, 0.95);
  const roomListP95 = percentile(roomListLatencies, 0.95);
  const historyP95 = percentile(historyLatencies, 0.95);
  console.info(
    `G1_CAPACITY profile=${PROFILE.name} directory_p95_ms=${directoryP95.toFixed(1)} room_list_p95_ms=${roomListP95.toFixed(1)} history_p95_ms=${historyP95.toFixed(1)}`,
  );
  expect(directoryP95).toBeLessThanOrEqual(HTTP_P95_MAX_MS);
  expect(roomListP95).toBeLessThanOrEqual(HTTP_P95_MAX_MS);
  expect(historyP95).toBeLessThanOrEqual(HTTP_P95_MAX_MS);
}

async function connectQualifiedSockets(): Promise<{
  readonly connected: SocketObservation[];
  readonly outsider: SocketObservation[];
}> {
  const outsiderIndex = users.length - 1;
  const connected: SocketObservation[] = [];
  for (let userIndex = 0; userIndex < PROFILE.realtimeUsers - 1; userIndex += 1) {
    for (let connection = 0; connection < 2; connection += 1) {
      connected.push(observeSocket(userIndex, connectClient(users[userIndex]!.token)));
    }
  }
  const outsider: SocketObservation[] = [];
  for (let connection = 0; connection < 2; connection += 1) {
    outsider.push(observeSocket(outsiderIndex, connectClient(users[outsiderIndex]!.token)));
  }
  expect(connected.length + outsider.length).toBe(PROFILE.socketConnections);
  for (const batch of chunks([...connected, ...outsider], 25)) {
    await Promise.all(batch.map(({ socket }) => waitForConnection(socket)));
  }
  expect(
    [...connected, ...outsider].filter(({ socket }) => socket.connected),
  ).toHaveLength(PROFILE.socketConnections);
  await waitUntil(
    `${PROFILE.realtimeUsers} simultaneous authenticated Socket.IO users`,
    () => socketService.getOnlineUsersCount() === PROFILE.realtimeUsers,
  );
  for (const batch of chunks(connected, 25)) {
    const acknowledgements = await Promise.all(
      batch.map(({ socket }) => joinConversation(socket, fanoutRoomId.toString())),
    );
    for (const acknowledgement of acknowledgements) {
      expect(acknowledgement).toEqual({
        ok: true,
        conversationId: fanoutRoomId.toString(),
      });
    }
  }
  for (const observation of outsider) {
    await expect(
      joinConversation(observation.socket, fanoutRoomId.toString()),
    ).resolves.toEqual({ ok: false, code: "CONVERSATION_NOT_FOUND" });
  }
  return Object.freeze({ connected, outsider });
}

function matchingMessages(
  observation: SocketObservation,
  clientMessageId: string,
): readonly ChatMessageUpdate[] {
  return observation.messages.filter(
    ({ message }) => message.clientMessageId === clientMessageId,
  );
}

function matchingUnreads(
  observation: SocketObservation,
  conversationId: string,
): readonly ChatUnreadUpdate[] {
  return observation.unreads.filter(
    (update) => update.conversationId === conversationId,
  );
}

async function assertAnnouncementTransportAndRecovery(): Promise<void> {
  const { connected, outsider } = await connectQualifiedSockets();
  const offlineUserIndex = 1;
  const offline = connected.filter(
    ({ userIndex }) => userIndex === offlineUserIndex,
  );
  expect(offline).toHaveLength(2);
  await Promise.all(
    offline.map(async ({ socket }) => {
      const disconnected = waitForDisconnect(socket);
      socket.disconnect();
      await disconnected;
    }),
  );
  await waitUntil(
    "offline recipient socket removal",
    () => socketService.getOnlineUsersCount() === PROFILE.realtimeUsers - 1,
  );

  const clientMessageId = randomUUID();
  const insertManySpy = vi.spyOn(NotificationOutbox, "insertMany");
  let batchSizes: number[] = [];
  let announcement: JsonResponse<
    SuccessEnvelope<{
      readonly message: { readonly id: string; readonly sequence: number };
    }>
  >;
  try {
    announcement = await jsonRequest(
      users[0]!.token,
      `/api/conversations/${fanoutRoomId.toString()}/announcements`,
      {
        method: "POST",
        headers: { "Idempotency-Key": clientMessageId },
        body: JSON.stringify({
          clientMessageId,
          content: "G1 capacity announcement",
        }),
      },
    );
    batchSizes = insertManySpy.mock.calls.map(([documents]) => documents.length);
  } finally {
    insertManySpy.mockRestore();
  }
  expect(announcement!.status).toBe(201);
  const expectedBatchSizes = chunks(
    Array.from({ length: PROFILE.announcementRecipients }, (_, index) => index),
    100,
  ).map((batch) => batch.length);
  expect(batchSizes).toEqual(expectedBatchSizes);
  const announcementMessage = announcement!.body.data.message;
  expect(
    await NotificationOutbox.countDocuments({
      topic: "web_push.chat_message",
      "payload.conversationId": fanoutRoomId.toString(),
      "payload.messageId": announcementMessage.id,
    }),
  ).toBe(PROFILE.announcementRecipients);
  expect(
    await ConversationMember.countDocuments({
      conversationId: fanoutRoomId,
      unreadCount: 1,
    }),
  ).toBe(PROFILE.announcementRecipients);

  const worker = new NotificationOutboxWorker({
    outbox: notificationOutboxService,
    registry: new NotificationOutboxDeliveryRegistry([chatMessageDeliveryHandler]),
    authorizer: new NotificationOutboxWorkerAuthorization(),
    workerId: "g1-release-capacity-transport",
    config: { batchSize: 5 },
  });
  await expect(worker.runOnce()).resolves.toMatchObject({
    claimed: 1,
    delivered: 1,
  });
  const liveRecipients = connected.filter(
    ({ userIndex }) => userIndex !== offlineUserIndex,
  );
  await waitUntil("authorized Socket.IO announcement delivery", () =>
    liveRecipients.every(
      (observation) =>
        matchingMessages(observation, clientMessageId).length === 1 &&
        matchingUnreads(observation, fanoutRoomId.toString()).length === 1,
    ),
  );
  for (const observation of liveRecipients) {
    expect(matchingMessages(observation, clientMessageId)).toHaveLength(1);
    expect(matchingUnreads(observation, fanoutRoomId.toString())).toHaveLength(1);
  }
  for (const observation of [...offline, ...outsider]) {
    expect(matchingMessages(observation, clientMessageId)).toHaveLength(0);
    expect(matchingUnreads(observation, fanoutRoomId.toString())).toHaveLength(0);
  }

  const reconnected = [
    observeSocket(offlineUserIndex, connectClient(users[offlineUserIndex]!.token)),
    observeSocket(offlineUserIndex, connectClient(users[offlineUserIndex]!.token)),
  ];
  await Promise.all(reconnected.map(({ socket }) => waitForConnection(socket)));
  await Promise.all(
    reconnected.map(({ socket }) =>
      expect(joinConversation(socket, fanoutRoomId.toString())).resolves.toEqual({
        ok: true,
        conversationId: fanoutRoomId.toString(),
      }),
    ),
  );
  await waitUntil(
    "reconnected Socket.IO user restoration",
    () => socketService.getOnlineUsersCount() === PROFILE.realtimeUsers,
  );
  const recovery = await jsonRequest<
    SuccessEnvelope<{
      readonly messages: readonly {
        readonly id: string;
        readonly clientMessageId: string;
        readonly sequence: number;
      }[];
    }>
  >(
    users[offlineUserIndex]!.token,
    `/api/conversations/${fanoutRoomId.toString()}/messages?afterSequence=${announcementMessage.sequence - 1}&limit=10`,
  );
  expect(recovery.status).toBe(200);
  expect(recovery.body.data.messages).toContainEqual(
    expect.objectContaining({
      id: announcementMessage.id,
      clientMessageId,
      sequence: announcementMessage.sequence,
    }),
  );
  for (const observation of outsider) {
    expect(matchingMessages(observation, clientMessageId)).toHaveLength(0);
    expect(matchingUnreads(observation, fanoutRoomId.toString())).toHaveLength(0);
  }
}

async function assertHttpMessageLoad(): Promise<void> {
  const latencies: number[] = [];
  const clientMessageIds: string[] = [];
  const acknowledgedClientMessageIds: string[] = [];
  let failures = 0;
  let serverErrors = 0;
  let timeoutFailures = 0;
  let clientErrors = 0;
  let transportFailures = 0;
  for (let second = 0; second < PROFILE.sendSeconds; second += 1) {
    const tickStarted = performance.now();
    await Promise.all(
      Array.from({ length: PROFILE.sendsPerSecond }, async (_unused, offset) => {
        const room = sendRooms[
          (second * PROFILE.sendsPerSecond + offset) % sendRooms.length
        ]!;
        const clientMessageId = randomUUID();
        clientMessageIds.push(clientMessageId);
        const started = performance.now();
        try {
          const response = await jsonRequest<SuccessEnvelope<unknown>>(
            room.sender.token,
            `/api/conversations/${room.conversationId.toString()}/messages`,
            {
              method: "POST",
              headers: { "Idempotency-Key": clientMessageId },
              body: JSON.stringify({
                clientMessageId,
                content: `g1-capacity-send-${second}-${offset}`,
              }),
            },
          );
          if (response.status !== 201) {
            failures += 1;
            if (response.status >= 500) {
              serverErrors += 1;
            } else if (response.status >= 400) {
              clientErrors += 1;
            }
            return;
          }
          acknowledgedClientMessageIds.push(clientMessageId);
          latencies.push(performance.now() - started);
        } catch (error) {
          failures += 1;
          if (isTimeoutError(error)) {
            timeoutFailures += 1;
          } else {
            transportFailures += 1;
          }
        }
      }),
    );
    const remainingMs = 1_000 - (performance.now() - tickStarted);
    if (remainingMs > 0 && second + 1 < PROFILE.sendSeconds) {
      await wait(remainingMs);
    }
  }
  const expected = PROFILE.sendSeconds * PROFILE.sendsPerSecond;
  const persisted = await ChatMessage.countDocuments({
    clientMessageId: { $in: clientMessageIds },
  });
  const distinctPersisted = await ChatMessage.distinct("clientMessageId", {
    clientMessageId: { $in: clientMessageIds },
  });
  const acknowledgedPersisted = await ChatMessage.countDocuments({
    clientMessageId: { $in: acknowledgedClientMessageIds },
  });
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  console.info(
    `G1_CAPACITY profile=${PROFILE.name} sends=${expected} failures=${failures} server_5xx=${serverErrors} timeouts=${timeoutFailures} client_4xx=${clientErrors} transport_failures=${transportFailures} http_ack_p95_ms=${p95.toFixed(1)} http_ack_p99_ms=${p99.toFixed(1)}`,
  );
  expect(failures / expected).toBeLessThan(0.01);
  expect((serverErrors + timeoutFailures) / expected).toBeLessThan(0.01);
  expect(acknowledgedPersisted).toBe(acknowledgedClientMessageIds.length);
  expect(distinctPersisted).toHaveLength(persisted);
  expect(p95).toBeLessThanOrEqual(ACK_P95_MAX_MS);
  expect(p99).toBeLessThanOrEqual(ACK_P99_MAX_MS);
}

describe(`G1 release capacity qualification (${PROFILE.name} profile)`, () => {
  beforeAll(async () => {
    assertGuardedLoopbackConfiguration();
    await ensureIntegrationDB();
    expect(mongoose.connection.host).toBe("127.0.0.1");
    expect(mongoose.connection.port).toBe(27018);
    expect(mongoose.connection.db?.databaseName).toMatch(
      /^atcloud_g1_capacity_test_[A-Za-z0-9_-]+$/u,
    );
    expect(mongoose.connection.getClient().options.maxPoolSize).toBe(10);
    await clearIntegrationDB();
    await Promise.all(models.map((model) => model.init()));
    const transactions = new MongoTransactionService(mongoose.connection);
    await expect(transactions.assertTopologyCapability(true)).resolves.toMatchObject({
      supported: true,
    });
    await seedAppliedMigrationLedger();
    await seedUsers();
    await FeatureControl.collection.insertOne({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "on",
      revision: 1,
      changedBy: users[0]!.id.toString(),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await seedDirectory();
    await seedProgramsRoomsAndMembers();
    await seedMessages();
    expect(await ChatMessage.countDocuments()).toBe(PROFILE.messages);
    expect(await Conversation.countDocuments()).toBe(PROFILE.conversations);
    expect(await User.countDocuments()).toBe(PROFILE.users);
    expect(await AlumniProfile.countDocuments()).toBe(PROFILE.publishedProfiles);
    expect(await Program.countDocuments()).toBe(PROFILE.programs);
    expect(
      await ProgramCommunitySettings.countDocuments({ enabled: true }),
    ).toBe(PROFILE.openPrograms);
    expect(
      await ConversationMember.countDocuments({
        conversationId: programRoomIds[1],
      }),
    ).toBe(PROFILE.programMemberCapacity);
    await startLoopbackServer();
  }, APPROVED_PROFILE ? 12 * 60_000 : 2 * 60_000);

  afterAll(async () => {
    clients.forEach((client) => {
      client.removeAllListeners();
      client.disconnect();
    });
    await socketService.shutdown();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (previousReleaseFlag === undefined) {
      delete process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE;
    } else {
      process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE = previousReleaseFlag;
    }
    await clearIntegrationDB();
  }, APPROVED_PROFILE ? 2 * 60_000 : 30_000);

  it(
    "qualifies coexisting HTTP, 500-recipient fan-out, real Socket.IO transport, reconnect recovery, and sustained HTTP sends",
    async () => {
      await assertHttpReadP95();
      await assertAnnouncementTransportAndRecovery();
      await assertHttpMessageLoad();
    },
    APPROVED_PROFILE ? 12 * 60_000 : 2 * 60_000,
  );
});
