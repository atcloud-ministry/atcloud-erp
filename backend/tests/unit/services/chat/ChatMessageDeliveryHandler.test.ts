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
    getMemberDeliveryState: vi.fn(async (_conversationId, userId, _sequence) =>
      userId === STALE_MEMBER_ID
        ? null
        : {
            roomUnreadCount: userId === RECIPIENT_ID ? 3 : 0,
            lastReadSequence: userId === RECIPIENT_ID ? 4 : 7,
            chatUnreadTotal: userId === RECIPIENT_ID ? 8 : 2,
          },
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

  it("emits only to freshly active members with authoritative absolute counts", async () => {
    const { handler, rooms, socket } = setup();
    await handler.deliver(event(), context());

    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(2);
    expect(rooms.listActiveRetainedMemberUserIds).toHaveBeenCalledWith(
      CONVERSATION_ID,
      7,
    );
    expect(rooms.getMemberDeliveryState).toHaveBeenCalledWith(
      CONVERSATION_ID,
      RECIPIENT_ID,
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

  it("permanently rejects a message outside logical retention", async () => {
    await expect(
      setup({ message: null }).handler.assertCanDeliver(event(), context()),
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
    stateFailure.rooms.getMemberDeliveryState.mockRejectedValueOnce(
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
      getMemberDeliveryState: vi.fn(async () => {
        order.push("final-state");
        return {
          roomUnreadCount: 1,
          lastReadSequence: 6,
          chatUnreadTotal: 1,
        };
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
    expect(rooms.getMemberDeliveryState).not.toHaveBeenCalled();

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

  it("emits the first freshly authorized recipient while the second state read is still pending", async () => {
    let releaseSecond!: () => void;
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const rooms = {
      loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
      listActiveRetainedMemberUserIds: vi
        .fn()
        .mockResolvedValue([SENDER_ID, RECIPIENT_ID]),
      getMemberDeliveryState: vi.fn(async (_roomId: string, userId: string) => {
        if (userId === RECIPIENT_ID) {
          await secondReady;
          return null;
        }
        return {
          roomUnreadCount: 0,
          lastReadSequence: 7,
          chatUnreadTotal: 0,
        };
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
      expect(rooms.getMemberDeliveryState).toHaveBeenCalledWith(
        CONVERSATION_ID,
        RECIPIENT_ID,
        7,
      ),
    );

    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(1);
    expect(socket.emitChatMessageToUser).toHaveBeenCalledWith(
      SENDER_ID,
      CONVERSATION_ID,
      { message: MESSAGE },
    );
    expect(socket.emitChatMessageToUser).not.toHaveBeenCalledWith(
      RECIPIENT_ID,
      expect.anything(),
      expect.anything(),
    );

    releaseSecond();
    await delivery;
    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(1);
  });

  it("fans out to 250 user rooms/500 clients and recovers disconnected tabs without duplicates", async () => {
    const recipientUserIds = Array.from(
      { length: 250 },
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
      getMemberDeliveryState: vi.fn().mockResolvedValue({
        roomUnreadCount: 1,
        lastReadSequence: 6,
        chatUnreadTotal: 1,
      }),
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
    expect(socket.emitChatMessageToUser).toHaveBeenCalledTimes(250);
    expect(socket.emitChatUnreadUpdate).toHaveBeenCalledTimes(250);
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
    expect(authorizedClients).toHaveLength(500);
    expect(
      authorizedClients.every(
        (client) => client.messageKeys.size === 1 && client.unreadCount === 1,
      ),
    ).toBe(true);
  });
});
