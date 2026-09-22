import { describe, expect, it, vi } from "vitest";
import type { ClaimedNotificationOutbox } from "../../../../src/services/reliability/NotificationOutboxService";
import { RetryableNotificationOutboxDeliveryError } from "../../../../src/services/reliability/NotificationOutboxWorker";
import { WebPushChatMessageDeliveryHandler } from "../../../../src/services/push/WebPushChatMessageDeliveryHandler";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";

const EVENT = Object.freeze({
  eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
  topic: "web_push.chat_message",
  payloadVersion: 1,
  payload: {
    conversationId: "507f1f77bcf86cd799439011",
    messageId: "507f1f77bcf86cd799439012",
    recipientUserId: "507f1f77bcf86cd799439014",
    sequence: 4,
    occurredAt: "2026-09-13T12:00:00.000Z",
  },
} as ClaimedNotificationOutbox);

const MESSAGE = Object.freeze({
  id: EVENT.payload.messageId,
  conversationId: EVENT.payload.conversationId,
  sequence: 4,
  sender: Object.freeze({
    id: "507f1f77bcf86cd799439013",
    displayName: "Sender",
    avatar: null,
  }),
  clientMessageId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f6",
  kind: "text" as const,
  content: "private chat text",
  safeLink: null,
  createdAt: "2026-09-13T12:00:00.000Z",
});

function context() {
  return {
    signal: new AbortController().signal,
    renewLease: vi.fn(),
  };
}

describe("WebPushChatMessageDeliveryHandler", () => {
  it("validates the envelope in assertCanDeliver without duplicating recipient reads", async () => {
    const loadRetainedMessageForDelivery = vi.fn().mockResolvedValue(MESSAGE);
    const isActiveRetainedMemberForDelivery = vi.fn().mockResolvedValue(true);
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery,
        isActiveRetainedMemberForDelivery,
      },
      router: { deliverChat: vi.fn() },
    });

    await handler.assertCanDeliver(EVENT, context());

    expect(loadRetainedMessageForDelivery).not.toHaveBeenCalled();
    expect(isActiveRetainedMemberForDelivery).not.toHaveBeenCalled();
  });

  it("delivers only the recipient-scoped event using no private message content", async () => {
    const deliverChat = vi.fn().mockResolvedValue({
      route: "skipped",
      push: {
        route: "muted",
        attempted: 0,
        succeeded: 0,
        permanentFailures: 0,
        transientFailures: 0,
      },
    });
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
        isActiveRetainedMemberForDelivery: vi.fn().mockResolvedValue(true),
      },
      router: { deliverChat },
    });
    await handler.deliver(EVENT, context());
    expect(deliverChat).toHaveBeenCalledTimes(1);
    expect(deliverChat).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: EVENT.payload.recipientUserId }),
    );
    expect(JSON.stringify(deliverChat.mock.calls[0]?.[0])).not.toContain(
      MESSAGE.content,
    );
  });

  it("rechecks the recipient set and routes Program announcement copy", async () => {
    const announcement = Object.freeze({
      ...MESSAGE,
      kind: "announcement" as const,
      content: "Program schedule update",
    });
    const deliverChat = vi.fn().mockImplementation(async (input) => {
      expect(await input.authorizeRecipient()).toBe(true);
      return {
        route: "skipped",
        push: {
          route: "muted",
          attempted: 0,
          succeeded: 0,
          permanentFailures: 0,
          transientFailures: 0,
        },
      };
    });
    const isActiveRetainedMemberForDelivery = vi.fn().mockResolvedValue(true);
    const rooms = {
      loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(announcement),
      isActiveRetainedMemberForDelivery,
    };
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms,
      router: { deliverChat },
    });

    await handler.deliver(EVENT, context());

    expect(isActiveRetainedMemberForDelivery).toHaveBeenCalledWith(
      EVENT.payload.conversationId,
      EVENT.payload.recipientUserId,
      EVENT.payload.sequence,
    );
    expect(deliverChat).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: EVENT.payload.recipientUserId,
        kind: "announcement",
      }),
    );
  });

  it("lets the provider boundary drop a recipient revoked after message resolution", async () => {
    let authorized = true;
    let continueDelivery!: () => void;
    const deliveryPaused = new Promise<void>((resolve) => {
      continueDelivery = resolve;
    });
    let routerEntered!: () => void;
    const routerStarted = new Promise<void>((resolve) => {
      routerEntered = resolve;
    });
    const deliverChat = vi.fn().mockImplementation(async (input) => {
      routerEntered();
      await deliveryPaused;
      const allowed = await input.authorizeRecipient();
      return {
        route: allowed ? "push" : "skipped",
        push: {
          route: allowed ? "delivered" : "recipient_unavailable",
          attempted: allowed ? 1 : 0,
          succeeded: allowed ? 1 : 0,
          permanentFailures: 0,
          transientFailures: 0,
        },
      };
    });
    const isActiveRetainedMemberForDelivery = vi.fn(async () => authorized);
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
        isActiveRetainedMemberForDelivery,
      },
      router: { deliverChat },
    });

    const delivery = handler.deliver(EVENT, context());
    await routerStarted;
    expect(isActiveRetainedMemberForDelivery).not.toHaveBeenCalled();
    authorized = false;
    continueDelivery();
    await expect(delivery).resolves.toBeUndefined();
    expect(isActiveRetainedMemberForDelivery).toHaveBeenCalledTimes(1);
  });

  it("retries when the final recipient authorization read fails", async () => {
    const deliverChat = vi.fn().mockImplementation(async (input) => {
      await input.authorizeRecipient();
      throw new Error("authorization unexpectedly returned");
    });
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
        isActiveRetainedMemberForDelivery: vi
          .fn()
          .mockRejectedValue(new Error("canonical database unavailable")),
      },
      router: { deliverChat },
    });

    await expect(handler.deliver(EVENT, context())).rejects.toMatchObject({
      code: "WEB_PUSH_STATE_READ_FAILED",
    });
    expect(deliverChat).toHaveBeenCalledTimes(1);
  });

  it("turns any transient endpoint result into an outbox retry", async () => {
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
        isActiveRetainedMemberForDelivery: vi.fn().mockResolvedValue(true),
      },
      router: {
        deliverChat: vi.fn().mockResolvedValue({
          route: "retry",
          push: {
            route: "transient_failure",
            attempted: 1,
            succeeded: 0,
            permanentFailures: 0,
            transientFailures: 1,
          },
        }),
      },
    });
    await expect(handler.deliver(EVENT, context())).rejects.toBeInstanceOf(
      RetryableNotificationOutboxDeliveryError,
    );
  });

  it("turns an SMTP/provider exception into a sanitized outbox retry", async () => {
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
        isActiveRetainedMemberForDelivery: vi.fn().mockResolvedValue(true),
      },
      router: {
        deliverChat: vi
          .fn()
          .mockRejectedValue(new Error("smtp://private-provider-detail")),
      },
    });
    await expect(handler.deliver(EVENT, context())).rejects.toMatchObject({
      code: "WEB_PUSH_RECIPIENT_DELIVERY_FAILED",
      message: "WEB_PUSH_RECIPIENT_DELIVERY_FAILED",
    });
  });

  it("does not convert worker cancellation into a delivery retry", async () => {
    const abort = new AbortController();
    const stopReason = new Error("worker stopping");
    const handler = new WebPushChatMessageDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      rooms: {
        loadRetainedMessageForDelivery: vi.fn().mockResolvedValue(MESSAGE),
        isActiveRetainedMemberForDelivery: vi.fn().mockResolvedValue(true),
      },
      router: {
        deliverChat: vi.fn().mockImplementation(async () => {
          abort.abort(stopReason);
          throw stopReason;
        }),
      },
    });
    await expect(
      handler.deliver(EVENT, { signal: abort.signal, renewLease: vi.fn() }),
    ).rejects.toBe(stopReason);
  });
});
