import type { ClientSession } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueWebPushChatMessage,
  enqueueWebPushChatMessagesBatch,
  parseWebPushChatMessagePayload,
} from "../../../../src/services/push/WebPushChatMessageOutbox";
import { PermanentNotificationOutboxDeliveryError } from "../../../../src/services/reliability/NotificationOutboxWorker";

const BASE = Object.freeze({
  conversationId: "507f1f77bcf86cd799439011",
  messageId: "507f1f77bcf86cd799439012",
  recipientUserId: "507f1f77bcf86cd799439013",
  sequence: 2,
  occurredAt: "2033-09-13T12:00:00.000Z",
});

describe("WebPushChatMessageOutbox", () => {
  it("requires a strict recipient-scoped payload with no chat content", () => {
    expect(parseWebPushChatMessagePayload(BASE)).toEqual(BASE);
    expect(() =>
      parseWebPushChatMessagePayload({
        ...BASE,
        content: "private message",
      }),
    ).toThrow(PermanentNotificationOutboxDeliveryError);
    expect(() =>
      parseWebPushChatMessagePayload({
        ...BASE,
        recipientUserId: undefined,
      }),
    ).toThrow(PermanentNotificationOutboxDeliveryError);
  });

  it("uses a distinct durable dedupe key for every message recipient", async () => {
    const enqueueInTransaction = vi
      .fn()
      .mockResolvedValue({ eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5" });
    const session = {} as ClientSession;
    const first = BASE.recipientUserId;
    const second = "507f1f77bcf86cd799439014";
    await enqueueWebPushChatMessage(
      { ...BASE, session },
      { enqueueInTransaction } as never,
    );
    await enqueueWebPushChatMessage(
      { ...BASE, recipientUserId: second, session },
      { enqueueInTransaction } as never,
    );
    expect(enqueueInTransaction.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      `web-push-chat-message:${BASE.messageId}:${first}`,
      `web-push-chat-message:${BASE.messageId}:${second}`,
    ]);
    expect(
      enqueueInTransaction.mock.calls.map(([input]) => input.payload.recipientUserId),
    ).toEqual([first, second]);
  });

  it("maps up to 100 recipients into one safe outbox batch", async () => {
    const enqueueManyInTransaction = vi.fn().mockResolvedValue([]);
    const session = {} as ClientSession;
    const inputs = Array.from({ length: 100 }, (_, index) => ({
      ...BASE,
      recipientUserId: `507f1f77bcf86cd79943${index.toString(16).padStart(4, "0")}`,
      session,
    }));

    await enqueueWebPushChatMessagesBatch(inputs, {
      enqueueManyInTransaction,
    } as never);

    const events = enqueueManyInTransaction.mock.calls[0]?.[0];
    expect(events).toHaveLength(100);
    expect(new Set(events.map((event: { dedupeKey: string }) => event.dedupeKey)).size)
      .toBe(100);
    expect(events[0]).toMatchObject({
      topic: "web_push.chat_message",
      payloadVersion: 1,
      session,
    });
    await expect(
      enqueueWebPushChatMessagesBatch([...inputs, inputs[0]!], {
        enqueueManyInTransaction,
      } as never),
    ).rejects.toThrow("must contain 1-100 recipients");
  });
});
