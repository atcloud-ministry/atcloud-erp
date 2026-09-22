import { describe, expect, it } from "vitest";
import { ChatSendRateLimiter } from "../../../../src/services/chat/ChatSendRateLimiter";

const USER = "507f1f77bcf86cd799439011";
const ROOM_A = "507f1f77bcf86cd799439012";
const ROOM_B = "507f1f77bcf86cd799439013";

function input(index: number, conversationId = ROOM_A) {
  return {
    userId: USER,
    conversationId,
    clientMessageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  };
}

describe("ChatSendRateLimiter", () => {
  it("allows five sends per room in ten seconds and returns Retry-After", () => {
    let now = 10_000;
    const limiter = new ChatSendRateLimiter({ now: () => now });
    for (let index = 1; index <= 5; index += 1) {
      expect(() => limiter.assertAllowed(input(index))).not.toThrow();
    }
    expect(() => limiter.assertAllowed(input(6))).toThrowError(
      expect.objectContaining({
        code: "CHAT_SEND_RATE_LIMITED",
        retryAfterSeconds: 10,
      }),
    );
    now += 10_000;
    expect(() => limiter.assertAllowed(input(7))).not.toThrow();
  });

  it("enforces twenty per user-room per minute", () => {
    let now = 0;
    const limiter = new ChatSendRateLimiter({ now: () => now });
    for (let index = 1; index <= 20; index += 1) {
      if (index > 1 && (index - 1) % 5 === 0) now += 10_000;
      limiter.assertAllowed(input(index));
    }
    now = 50_000;
    expect(() => limiter.assertAllowed(input(21))).toThrowError(
      expect.objectContaining({ code: "CHAT_SEND_RATE_LIMITED" }),
    );
    now = 60_001;
    expect(() => limiter.assertAllowed(input(22))).not.toThrow();
  });

  it("enforces sixty per account across rooms", () => {
    let now = 0;
    const limiter = new ChatSendRateLimiter({ now: () => now });
    for (let index = 1; index <= 60; index += 1) {
      const room = `507f1f77bcf86cd799${String(index).padStart(6, "0")}`;
      limiter.assertAllowed(input(index, room));
    }
    expect(() => limiter.assertAllowed(input(61, ROOM_B))).toThrowError(
      expect.objectContaining({ code: "CHAT_SEND_RATE_LIMITED" }),
    );
  });

  it("does not charge a retry with the same client message identity", () => {
    const limiter = new ChatSendRateLimiter({ now: () => 1_000 });
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(() => limiter.assertAllowed(input(1))).not.toThrow();
    }
    for (let index = 2; index <= 5; index += 1) {
      limiter.assertAllowed(input(index));
    }
    expect(() => limiter.assertAllowed(input(6))).toThrowError(
      expect.objectContaining({ code: "CHAT_SEND_RATE_LIMITED" }),
    );
  });

  it("sweeps expired one-off room buckets", () => {
    let now = 1_000;
    const limiter = new ChatSendRateLimiter({ now: () => now });
    for (let index = 1; index <= 100; index += 1) {
      const room = `507f1f77bcf86cd799${String(index).padStart(6, "0")}`;
      limiter.assertAllowed({
        ...input(index, room),
        userId: `one-off-user-${index}`,
      });
    }
    expect(limiter.snapshot().trackedBuckets).toBeGreaterThan(100);
    now += 60_001;
    limiter.assertAllowed(input(101, ROOM_A));
    expect(limiter.snapshot().trackedBuckets).toBeLessThanOrEqual(3);
  });
});
