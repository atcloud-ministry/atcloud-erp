import type { ClientSession } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueWebPushChatMessage,
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
});
