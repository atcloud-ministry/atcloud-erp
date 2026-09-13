import type { ClientSession } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { ChatRoomError } from "../../../../src/services/chat/ChatRoomErrors";
import {
  PROGRAM_ANNOUNCEMENT_RATE_LIMIT,
  ProgramAnnouncementRateLimiter,
} from "../../../../src/services/chat/ProgramAnnouncementRateLimiter";

const CONVERSATION_ID = "64f100000000000000000001";
const OCCURRED_AT = new Date("2026-09-12T12:00:00.000Z");
const SESSION = {} as ClientSession;

describe("ProgramAnnouncementRateLimiter", () => {
  it("reads the persisted rolling window with the transaction session", async () => {
    const loadOldestCreatedAtWithinWindow = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 9 }, (_, index) =>
          new Date(OCCURRED_AT.getTime() - (index + 1) * 1_000),
        ),
      );
    const limiter = new ProgramAnnouncementRateLimiter({
      dataSource: { loadOldestCreatedAtWithinWindow },
    });

    await expect(
      limiter.assertAllowed({
        conversationId: CONVERSATION_ID,
        occurredAt: OCCURRED_AT,
        session: SESSION,
      }),
    ).resolves.toBeUndefined();
    expect(loadOldestCreatedAtWithinWindow).toHaveBeenCalledWith({
      conversationId: expect.objectContaining({
        toString: expect.any(Function),
      }),
      windowStartExclusive: new Date("2026-09-12T11:00:00.000Z"),
      occurredAt: OCCURRED_AT,
      limit: 10,
      session: SESSION,
    });
  });

  it("returns retryAfter from the oldest of ten persisted announcements", async () => {
    const oldest = new Date(OCCURRED_AT.getTime() - 3_500_250);
    const limiter = new ProgramAnnouncementRateLimiter({
      dataSource: {
        loadOldestCreatedAtWithinWindow: vi.fn().mockResolvedValue([
          oldest,
          ...Array.from({ length: 9 }, (_, index) =>
            new Date(oldest.getTime() + index + 1),
          ),
        ]),
      },
    });

    await expect(
      limiter.assertAllowed({
        conversationId: CONVERSATION_ID,
        occurredAt: OCCURRED_AT,
        session: SESSION,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ChatRoomError>>({
        code: "CHAT_ANNOUNCEMENT_RATE_LIMITED",
        httpStatus: 429,
        retryAfterSeconds: 100,
      }),
    );
  });

  it("does not retain process-local charges between persisted reads", async () => {
    const loadOldestCreatedAtWithinWindow = vi.fn().mockResolvedValue([]);
    const limiter = new ProgramAnnouncementRateLimiter({
      dataSource: { loadOldestCreatedAtWithinWindow },
    });
    const input = {
      conversationId: CONVERSATION_ID,
      occurredAt: OCCURRED_AT,
      session: SESSION,
    } as const;

    for (let index = 0; index < PROGRAM_ANNOUNCEMENT_RATE_LIMIT.limit + 1; index += 1) {
      await expect(limiter.assertAllowed(input)).resolves.toBeUndefined();
    }
    expect(loadOldestCreatedAtWithinWindow).toHaveBeenCalledTimes(11);
  });

  it("rejects invalid identity and clock inputs before database access", async () => {
    const loadOldestCreatedAtWithinWindow = vi.fn();
    const limiter = new ProgramAnnouncementRateLimiter({
      dataSource: { loadOldestCreatedAtWithinWindow },
    });
    await expect(
      limiter.assertAllowed({
        conversationId: "invalid",
        occurredAt: OCCURRED_AT,
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      limiter.assertAllowed({
        conversationId: CONVERSATION_ID,
        occurredAt: new Date(Number.NaN),
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(loadOldestCreatedAtWithinWindow).not.toHaveBeenCalled();
  });
});
