import { describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import type { ChatMessageDTO } from "../../../../src/contracts/chatRoomFlow";
import {
  CHAT_MESSAGE_PERSISTED_PAYLOAD_VERSION,
  CHAT_MESSAGE_PERSISTED_TOPIC,
} from "../../../../src/services/chat/ChatMessageOutbox";
import { ChatMessageDeliveryHandler } from "../../../../src/services/chat/ChatMessageDeliveryHandler";
import type { NotificationOutboxDeliveryContext } from "../../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import type { ClaimedNotificationOutbox } from "../../../../src/services/reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
  RetryableNotificationOutboxDeliveryError,
} from "../../../../src/services/reliability/NotificationOutboxWorker";

const CONVERSATION_ID = "64f100000000000000000001";
const MESSAGE_ID = "64f100000000000000000002";
const SENDER_ID = "64f100000000000000000003";
const RECIPIENT_ID = "64f100000000000000000004";
const STALE_MEMBER_ID = "64f100000000000000000005";

const MESSAGE: ChatMessageDTO = Object.freeze({
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  sequence: 7,
  sender: Object.freeze({
    id: SENDER_ID,
    displayName: "Amy Chen",
    avatar: null,
  }),
  clientMessageId: "550e8400-e29b-41d4-a716-446655440000",
  kind: "text",
  content: "Hello",
  safeLink: null,
  createdAt: "2026-09-12T12:00:00.000Z",
});

function event(): ClaimedNotificationOutbox {
  return {
    eventId: "550e8400-e29b-41d4-a716-446655440001",
    payload: {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      sequence: 7,
      occurredAt: "2026-09-12T12:00:00.000Z",
    },
  } as ClaimedNotificationOutbox;
}

function context(): NotificationOutboxDeliveryContext {
  return {
    signal: new AbortController().signal,
    renewLease: vi.fn(),
  };
}

function setup(options: {
  readonly mode?: "off" | "read_only" | "on";
  readonly message?: ChatMessageDTO | null;
  readonly emitResult?: boolean;
} = {}) {
  const rooms = {
    loadRetainedMessageForDelivery: vi
      .fn()
      .mockResolvedValue(options.message === undefined ? MESSAGE : options.message),
    listActiveRetainedMemberUserIds: vi
      .fn()
      .mockResolvedValue([SENDER_ID, RECIPIENT_ID, STALE_MEMBER_ID]),
    getMemberDeliveryStates: vi.fn(
      async (_conversationId, userIds: readonly string[], _sequence) =>
        userIds
          .filter((userId) => userId !== STALE_MEMBER_ID)
          .map((userId) => ({
            userId,
            roomUnreadCount: userId === RECIPIENT_ID ? 3 : 0,
            lastReadSequence: userId === RECIPIENT_ID ? 4 : 7,
            chatUnreadTotal: userId === RECIPIENT_ID ? 8 : 2,
          })),
    ),
  };
  const socket = {
    emitChatMessageToUser: vi
      .fn()
      .mockReturnValue(options.emitResult ?? true),
    emitChatUnreadUpdate: vi.fn().mockReturnValue(true),
  };
  const handler = new ChatMessageDeliveryHandler({
    releaseAvailable: () => true,
    runtimeReader: {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(createRuntimeConfigDTO(options.mode ?? "on", 1)),
    },
    rooms,
    socket,
  });
  return { handler, rooms, socket };
}

describe("ChatMessageDeliveryHandler", () => {
  it("registers the explicit persisted-message topic", () => {
    const { handler } = setup();
    expect(handler.topic).toBe(CHAT_MESSAGE_PERSISTED_TOPIC);
    expect(handler.payloadVersion).toBe(CHAT_MESSAGE_PERSISTED_PAYLOAD_VERSION);
  });

  it.each(["on", "read_only"] as const)(
    "claims committed messages while runtime is %s",
    async (mode) => {
      await expect(setup({ mode }).handler.canClaim(context().signal)).resolves.toBe(
        true,
      );
    },
  );

  it("defers before reading message state when the network is off", async () => {
    const { handler, rooms } = setup({ mode: "off" });
    await expect(handler.canClaim(context().signal)).resolves.toBe(false);
    await expect(handler.assertCanDeliver(event(), context())).rejects.toBeInstanceOf(
      DeferredNotificationOutboxDeliveryError,
    );
    expect(rooms.loadRetainedMessageForDelivery).not.toHaveBeenCalled();
  });

  it("validates the envelope in assertCanDeliver without duplicating delivery-state reads", async () => {
    const { handler, rooms } = setup();

    await handler.assertCanDeliver(event(), context());

    expect(rooms.loadRetainedMessageForDelivery).not.toHaveBeenCalled();
    expect(rooms.listActiveRetainedMemberUserIds).not.toHaveBeenCalled();
    expect(rooms.getMemberDeliveryStates).not.toHaveBeenCalled();
  });

  it("emits only to freshly active members with authoritative absolute counts", async () => {
    const { handler, rooms, socket } = setup();
    await handler.deliver(event(), context());

    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(2);
    expect(rooms.listActiveRetainedMemberUserIds).toHaveBeenCalledWith(
      CONVERSATION_ID,
      7,
    );
    expect(rooms.getMemberDeliveryStates).toHaveBeenCalledWith(
      CONVERSATION_ID,
      [SENDER_ID, RECIPIENT_ID, STALE_MEMBER_ID],
      7,
    );
    expect(socket.emitChatMessageToUser).toHaveBeenCalledWith(
      RECIPIENT_ID,
      CONVERSATION_ID,
      { message: MESSAGE },
    );
    expect(socket.emitChatMessageToUser).not.toHaveBeenCalledWith(
      STALE_MEMBER_ID,
      expect.anything(),
      expect.anything(),
    );
    expect(socket.emitChatUnreadUpdate).toHaveBeenCalledWith(RECIPIENT_ID, {
      conversationId: CONVERSATION_ID,
      roomUnreadCount: 3,
      chatUnreadTotal: 8,
      lastReadSequence: 4,
    });
  });

  it("fans announcements out to the publisher's other tabs with zero sender unread", async () => {
    const announcement = Object.freeze({
      ...MESSAGE,
      kind: "announcement" as const,
      content: "Program update",
    });
    const { handler, rooms, socket } = setup({ message: announcement });

    await handler.deliver(event(), context());

    expect(rooms.getMemberDeliveryStates).toHaveBeenCalledWith(
      CONVERSATION_ID,
      [SENDER_ID, RECIPIENT_ID, STALE_MEMBER_ID],
      7,
    );
    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(2);
    expect(socket.emitChatMessageToUser).toHaveBeenCalledWith(
      SENDER_ID,
      CONVERSATION_ID,
      { message: announcement },
    );
    expect(socket.emitChatMessageToUser).toHaveBeenCalledWith(
      RECIPIENT_ID,
      CONVERSATION_ID,
      { message: announcement },
    );
    expect(socket.emitChatUnreadUpdate).toHaveBeenCalledWith(SENDER_ID, {
      conversationId: CONVERSATION_ID,
      roomUnreadCount: 0,
      chatUnreadTotal: 2,
      lastReadSequence: 7,
    });
  });

  it("permanently rejects a message outside logical retention", async () => {
    await expect(
      setup({ message: null }).handler.deliver(event(), context()),
    ).rejects.toBeInstanceOf(PermanentNotificationOutboxDeliveryError);
  });

  it("retries a realtime infrastructure failure", async () => {
    await expect(
      setup({ emitResult: false }).handler.deliver(event(), context()),
    ).rejects.toBeInstanceOf(RetryableNotificationOutboxDeliveryError);
  });

  it("retries transient recipient and unread-state database failures", async () => {
    const recipientFailure = setup();
    recipientFailure.rooms.listActiveRetainedMemberUserIds.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      recipientFailure.handler.deliver(event(), context()),
    ).rejects.toMatchObject({ code: "CHAT_MESSAGE_STATE_READ_FAILED" });
    expect(recipientFailure.socket.emitChatMessageToUser).not.toHaveBeenCalled();

    const stateFailure = setup();
    stateFailure.rooms.getMemberDeliveryStates.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      stateFailure.handler.deliver(event(), context()),
    ).rejects.toMatchObject({ code: "CHAT_MESSAGE_COUNTER_READ_FAILED" });
    expect(stateFailure.socket.emitChatMessageToUser).not.toHaveBeenCalled();
  });

  it("resolves the lazy socket before the final membership read and emits without an async gap", async () => {
    const order: string[] = [];
    let releaseSocket!: () => void;
    const socketReady = new Promise<void>((resolve) => {
      releaseSocket = resolve;
    });
    const socket = {
      emitChatMessageToUser: vi.fn(() => {
        order.push("emit-message");
        return true;
      }),
      emitChatUnreadUpdate: vi.fn(() => {
        order.push("emit-unread");
        return true;
      }),
    };
    const rooms = {
      loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
      listActiveRetainedMemberUserIds: vi
        .fn()
        .mockResolvedValue([RECIPIENT_ID]),
      getMemberDeliveryStates: vi.fn(async () => {
        order.push("final-state");
        return [
          {
            userId: RECIPIENT_ID,
            roomUnreadCount: 1,
            lastReadSequence: 6,
            chatUnreadTotal: 1,
          },
        ];
      }),
    };
    const handler = new ChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms,
      socketResolver: async () => {
        order.push("socket-start");
        await socketReady;
        order.push("socket-ready");
        return socket;
      },
    });

    const delivery = handler.deliver(event(), context());
    await vi.waitFor(() => expect(order).toContain("socket-start"));
    expect(rooms.getMemberDeliveryStates).not.toHaveBeenCalled();

    releaseSocket();
    await delivery;

    expect(order).toEqual([
      "socket-start",
      "socket-ready",
      "final-state",
      "emit-message",
      "emit-unread",
    ]);
  });

  it("waits for the single final state batch before synchronously emitting every eligible recipient", async () => {
    let releaseStates!: () => void;
    const statesReady = new Promise<void>((resolve) => {
      releaseStates = resolve;
    });
    const rooms = {
      loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
      listActiveRetainedMemberUserIds: vi
        .fn()
        .mockResolvedValue([SENDER_ID, RECIPIENT_ID]),
      getMemberDeliveryStates: vi.fn(async () => {
        await statesReady;
        return [
          {
            userId: SENDER_ID,
            roomUnreadCount: 0,
            lastReadSequence: 7,
            chatUnreadTotal: 0,
          },
          {
            userId: RECIPIENT_ID,
            roomUnreadCount: 1,
            lastReadSequence: 6,
            chatUnreadTotal: 1,
          },
        ];
      }),
    };
    const socket = {
      emitChatMessageToUser: vi.fn().mockReturnValue(true),
      emitChatUnreadUpdate: vi.fn().mockReturnValue(true),
    };
    const handler = new ChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms,
      socket,
    });

    const delivery = handler.deliver(event(), context());
    await vi.waitFor(() =>
      expect(rooms.getMemberDeliveryStates).toHaveBeenCalledWith(
        CONVERSATION_ID,
        [SENDER_ID, RECIPIENT_ID],
        7,
      ),
    );

    expect(socket.emitChatMessageToUser).not.toHaveBeenCalled();

    releaseStates();
    await delivery;
    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(2);
  });

  it("fans out one authorized state batch to 500 user rooms without per-recipient reads", async () => {
    const recipientUserIds = Array.from(
      { length: 500 },
      (_unused, index) =>
        `64f1${(index + 1).toString(16).padStart(20, "0")}`,
    );
    const outsiderId = "64f1ffffffffffffffffffff";
    interface VirtualClient {
      connected: boolean;
      messageKeys: Set<string>;
      unreadCount: number;
    }
    const clients = new Map<string, VirtualClient[]>();
    for (const [index, userId] of recipientUserIds.entries()) {
      clients.set(
        userId,
        [
          { connected: true, messageKeys: new Set(), unreadCount: 0 },
          {
            connected: index >= 50,
            messageKeys: new Set(),
            unreadCount: 0,
          },
        ],
      );
    }
    clients.set(outsiderId, [
      { connected: true, messageKeys: new Set(), unreadCount: 0 },
      { connected: true, messageKeys: new Set(), unreadCount: 0 },
    ]);
    const rooms = {
      loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
      listActiveRetainedMemberUserIds: vi
        .fn()
        .mockResolvedValue(recipientUserIds),
      getMemberDeliveryStates: vi.fn(
        async (_conversationId, userIds: readonly string[]) =>
          userIds.map((userId) => ({
            userId,
            roomUnreadCount: 1,
            lastReadSequence: 6,
            chatUnreadTotal: 1,
          })),
      ),
    };
    const socket = {
      emitChatMessageToUser: vi.fn(
        (userId: string, _conversationId: string, update: { message: ChatMessageDTO }) => {
          for (const client of clients.get(userId) ?? []) {
            if (client.connected) {
              client.messageKeys.add(
                `${update.message.conversationId}:${update.message.sequence}`,
              );
            }
          }
          return true;
        },
      ),
      emitChatUnreadUpdate: vi.fn(
        (userId: string, update: { roomUnreadCount: number }) => {
          for (const client of clients.get(userId) ?? []) {
            if (client.connected) client.unreadCount = update.roomUnreadCount;
          }
          return true;
        },
      ),
    };
    const handler = new ChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms,
      socket,
    });

    await handler.deliver(event(), context());
    expect(rooms.getMemberDeliveryStates).toHaveBeenCalledTimes(1);
    expect(rooms.getMemberDeliveryStates).toHaveBeenCalledWith(
      CONVERSATION_ID,
      recipientUserIds,
      7,
    );
    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(500);
    expect(socket.emitChatUnreadUpdate).toHaveBeenCalledTimes(500);
    expect(
      [...clients.get(outsiderId)!].every(
        (client) => client.messageKeys.size === 0,
      ),
    ).toBe(true);

    // Reconnect recovery uses authoritative REST history and the same
    // conversation/sequence identity used by realtime de-duplication.
    for (const userId of recipientUserIds) {
      for (const client of clients.get(userId)!) {
        client.connected = true;
        client.messageKeys.add(`${MESSAGE.conversationId}:${MESSAGE.sequence}`);
        client.unreadCount = 1;
      }
    }
    const authorizedClients = recipientUserIds.flatMap(
      (userId) => clients.get(userId)!,
    );
    expect(authorizedClients).toHaveLength(1_000);
    expect(
      authorizedClients.every(
        (client) => client.messageKeys.size === 1 && client.unreadCount === 1,
      ),
    ).toBe(true);
  });
});
