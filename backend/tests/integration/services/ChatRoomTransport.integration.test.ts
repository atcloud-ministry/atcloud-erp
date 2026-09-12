import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import mongoose from "mongoose";
import { io as createSocketClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../../src/app";
import { TokenService } from "../../../src/middleware/auth";
import ChatMessage from "../../../src/models/ChatMessage";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import FeatureControl, {
  FEATURE_CONTROL_SINGLETON_ID,
} from "../../../src/models/FeatureControl";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import User from "../../../src/models/User";
import { chatMessageDeliveryHandler } from "../../../src/services/chat/ChatMessageDeliveryHandler";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { NotificationOutboxDeliveryRegistry } from "../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import { notificationOutboxService } from "../../../src/services/reliability/NotificationOutboxService";
import { NotificationOutboxWorker } from "../../../src/services/reliability/NotificationOutboxWorker";
import { NotificationOutboxWorkerAuthorization } from "../../../src/services/reliability/NotificationOutboxWorkerAuthorization";
import type {
  ChatMessageUpdate,
  ChatUnreadUpdate,
  ConversationRoomAck,
} from "../../../src/types/realtime";
import {
  clearIntegrationDB,
  ensureIntegrationDB,
} from "../setup/connect";

const EVENT_TIMEOUT_MS = 8_000;

interface TestMember {
  readonly id: mongoose.Types.ObjectId;
  readonly email: string;
  readonly token: string;
}

interface JsonResponse<T> {
  readonly status: number;
  readonly body: T;
}

type SuccessEnvelope<T> = {
  readonly success: true;
  readonly data: T;
};

function withTimeout<T>(
  description: string,
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}.`)),
      EVENT_TIMEOUT_MS,
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

function waitForChatMessage(socket: ClientSocket): Promise<ChatMessageUpdate> {
  return withTimeout<ChatMessageUpdate>("chat_message", (resolve) => {
    socket.once("chat_message", resolve);
  });
}

function waitForChatUnread(socket: ClientSocket): Promise<ChatUnreadUpdate> {
  return withTimeout<ChatUnreadUpdate>("chat_unread_update", (resolve) => {
    socket.once("chat_unread_update", resolve);
  });
}

function joinConversation(
  socket: ClientSocket,
  conversationId: string,
): Promise<Parameters<ConversationRoomAck>[0]> {
  return withTimeout<Parameters<ConversationRoomAck>[0]>(
    "conversation-room acknowledgement",
    (resolve) => {
      socket.emit("join_conversation_room", conversationId, resolve);
    },
  );
}

async function jsonRequest<T>(
  origin: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse<T>> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
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

async function insertMember(label: string): Promise<TestMember> {
  const id = new mongoose.Types.ObjectId();
  const suffix = id.toString().slice(-8);
  const username = `transport_${label.toLowerCase()}_${suffix}`.slice(0, 20);
  const email = `${username}@private.example.org`;
  await User.collection.insertOne({
    _id: id,
    username,
    usernameLower: username,
    email,
    phone: `+1206555${suffix.slice(-4)}`,
    birthYear: 1988,
    password: "transport-test-only",
    firstName: label,
    lastName: "Member",
    avatar: null,
    residenceCity: "Seattle",
    residenceRegion: "US-WA",
    residenceCountryCode: "US",
    employmentStatus: "employed",
    company: "Private Employer",
    occupation: "Product Manager",
    isAtCloudLeader: false,
    role: "Participant",
    isActive: true,
    isVerified: true,
    emailNotifications: false,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return Object.freeze({
    id,
    email,
    token: TokenService.generateAccessToken({
      userId: id.toString(),
      email,
      role: "Participant",
    }),
  });
}

function connectClient(origin: string, token: string): ClientSocket {
  return createSocketClient(origin, {
    path: "/socket.io/",
    transports: ["websocket"],
    auth: { token },
    forceNew: true,
    reconnection: false,
  });
}

describe("M4 Chat Room real two-client transport", () => {
  let server: Server | null = null;
  let origin = "";
  let previousReleaseFlag: string | undefined;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    await ensureIntegrationDB();
    await clearIntegrationDB();
    const capability = await mongoose.connection.db?.admin().command({
      hello: 1,
    });
    expect(capability?.setName).toBeTruthy();

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
      throw new Error("Transport test server did not bind a TCP port.");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

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
  });

  it("delivers A to B once, recovers B after reconnect, and excludes C", async () => {
    const [memberA, memberB, outsiderC] = await Promise.all([
      insertMember("Alpha"),
      insertMember("Bravo"),
      insertMember("Charlie"),
    ]);
    await FeatureControl.create({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "on",
      revision: 1,
      changedBy: memberA.id.toString(),
    });
    const room = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const joinedAt = new Date();
    await ConversationMember.create([
      {
        conversationId: room._id,
        userId: memberA.id,
        role: "requester",
        status: "active",
        joinedAt,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: joinedAt,
            closedAt: null,
          },
        ],
      },
      {
        conversationId: room._id,
        userId: memberB.id,
        role: "provider",
        status: "active",
        joinedAt,
        accessWindows: [
          {
            visibleFromSequence: 1,
            visibleThroughSequence: null,
            openedAt: joinedAt,
            closedAt: null,
          },
        ],
      },
    ]);

    const clientA = connectClient(origin, memberA.token);
    const clientB = connectClient(origin, memberB.token);
    const clientC = connectClient(origin, outsiderC.token);
    clients.push(clientA, clientB, clientC);
    await Promise.all([
      waitForConnection(clientA),
      waitForConnection(clientB),
      waitForConnection(clientC),
    ]);

    const roomId = room._id.toString();
    await expect(joinConversation(clientA, roomId)).resolves.toEqual({
      ok: true,
      conversationId: roomId,
    });
    await expect(joinConversation(clientB, roomId)).resolves.toEqual({
      ok: true,
      conversationId: roomId,
    });
    await expect(joinConversation(clientC, roomId)).resolves.toEqual({
      ok: false,
      code: "CONVERSATION_NOT_FOUND",
    });

    const outsiderMessages: ChatMessageUpdate[] = [];
    clientC.on("chat_message", (payload: ChatMessageUpdate) => {
      outsiderMessages.push(payload);
    });
    const worker = new NotificationOutboxWorker({
      outbox: notificationOutboxService,
      registry: new NotificationOutboxDeliveryRegistry([
        chatMessageDeliveryHandler,
      ]),
      authorizer: new NotificationOutboxWorkerAuthorization(),
      workerId: "m4-real-transport-test",
      config: { batchSize: 5 },
    });

    const firstClientMessageId = randomUUID();
    const firstResponse = await jsonRequest<
      SuccessEnvelope<{
        readonly message: { readonly id: string; readonly sequence: number };
      }>
    >(origin, memberA.token, `/api/conversations/${roomId}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": firstClientMessageId },
      body: JSON.stringify({
        clientMessageId: firstClientMessageId,
        content: "first transport message",
      }),
    });
    expect(firstResponse.status).toBe(201);
    expect(firstResponse.body.data.message.sequence).toBe(1);
    await expect(
      NotificationOutbox.findOne({ topic: "chat.message.persisted" })
        .lean()
        .orFail(),
    ).resolves.toMatchObject({ status: "pending" });

    const firstEvents = {
      messageA: waitForChatMessage(clientA),
      unreadA: waitForChatUnread(clientA),
      messageB: waitForChatMessage(clientB),
      unreadB: waitForChatUnread(clientB),
    };
    const [firstRun, messageA, unreadA, messageB, unreadB] = await Promise.all([
      worker.runOnce(),
      firstEvents.messageA,
      firstEvents.unreadA,
      firstEvents.messageB,
      firstEvents.unreadB,
    ]);
    expect(firstRun).toMatchObject({ claimed: 1, delivered: 1 });
    expect(messageA.message).toMatchObject({
      conversationId: roomId,
      sequence: 1,
      clientMessageId: firstClientMessageId,
    });
    expect(messageB.message).toEqual(messageA.message);
    expect(unreadA).toMatchObject({
      conversationId: roomId,
      roomUnreadCount: 0,
      chatUnreadTotal: 0,
      lastReadSequence: 0,
    });
    expect(unreadB).toMatchObject({
      conversationId: roomId,
      roomUnreadCount: 1,
      chatUnreadTotal: 1,
      lastReadSequence: 0,
    });
    expect(outsiderMessages).toHaveLength(0);
    expect(
      await ChatMessage.countDocuments({
        conversationId: room._id,
        sequence: 1,
      }),
    ).toBe(1);

    const disconnected = waitForDisconnect(clientB);
    clientB.disconnect();
    await disconnected;
    const secondClientMessageId = randomUUID();
    const secondResponse = await jsonRequest<
      SuccessEnvelope<{
        readonly message: { readonly id: string; readonly sequence: number };
      }>
    >(origin, memberA.token, `/api/conversations/${roomId}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": secondClientMessageId },
      body: JSON.stringify({
        clientMessageId: secondClientMessageId,
        content: "message while B is offline",
      }),
    });
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body.data.message.sequence).toBe(2);

    const secondMessageA = waitForChatMessage(clientA);
    const secondUnreadA = waitForChatUnread(clientA);
    await expect(worker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
    });
    await expect(secondMessageA).resolves.toMatchObject({
      message: {
        conversationId: roomId,
        sequence: 2,
        clientMessageId: secondClientMessageId,
      },
    });
    await expect(secondUnreadA).resolves.toMatchObject({
      conversationId: roomId,
      roomUnreadCount: 0,
      chatUnreadTotal: 0,
    });
    expect(outsiderMessages).toHaveLength(0);

    const reconnectedB = connectClient(origin, memberB.token);
    clients.push(reconnectedB);
    await waitForConnection(reconnectedB);
    await expect(joinConversation(reconnectedB, roomId)).resolves.toEqual({
      ok: true,
      conversationId: roomId,
    });
    const recovery = await jsonRequest<
      SuccessEnvelope<{
        readonly conversationId: string;
        readonly messages: ReadonlyArray<{
          readonly sequence: number;
          readonly clientMessageId: string;
        }>;
      }>
    >(
      origin,
      memberB.token,
      `/api/conversations/${roomId}/messages?afterSequence=1&limit=100`,
    );
    expect(recovery.status).toBe(200);
    expect(recovery.body.data).toMatchObject({ conversationId: roomId });
    expect(recovery.body.data.messages).toEqual([
      expect.objectContaining({
        sequence: 2,
        clientMessageId: secondClientMessageId,
      }),
    ]);
    expect(
      new Set([
        messageB.message.sequence,
        ...recovery.body.data.messages.map((message) => message.sequence),
      ]),
    ).toEqual(new Set([1, 2]));
    const persistedSequences = await ChatMessage.distinct("sequence", {
      conversationId: room._id,
    });
    expect(persistedSequences.sort((first, second) => first - second)).toEqual([
      1, 2,
    ]);
    expect(await ChatMessage.countDocuments({ conversationId: room._id })).toBe(
      2,
    );
    expect(outsiderMessages).toHaveLength(0);
  });
});
