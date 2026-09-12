import { describe, expect, it, vi } from "vitest";
import {
  MAX_PUSH_BADGE_COUNT,
  NotificationBadgeCountService,
} from "../../../../src/services/notifications/NotificationBadgeCountService";

const USER_ID = "507f1f77bcf86cd799439011";

function service(input: {
  active?: boolean;
  verified?: boolean;
  chat?: number;
  system?: number;
}) {
  return new NotificationBadgeCountService({
    users: {
      load: vi.fn().mockResolvedValue({
        id: USER_ID,
        role: "Participant",
        isActive: input.active ?? true,
        isVerified: input.verified ?? true,
      }),
    },
    chat: {
      unreadTotal: vi
        .fn()
        .mockResolvedValue({ chatUnreadTotal: input.chat ?? 0 }),
    },
    systemMessages: {
      getUnreadCountsForUser: vi
        .fn()
        .mockResolvedValue({ systemMessages: input.system ?? 0 }),
    },
  });
}

describe("NotificationBadgeCountService", () => {
  it("combines chat and System Message unread counts", async () => {
    await expect(
      service({ chat: 12, system: 4 }).totalForUser(USER_ID),
    ).resolves.toBe(16);
  });

  it("caps the operating-system badge at the approved 99+ boundary", async () => {
    await expect(
      service({ chat: 80, system: 25 }).totalForUser(USER_ID),
    ).resolves.toBe(MAX_PUSH_BADGE_COUNT);
  });

  it("does not expose a count for an inactive or unverified account", async () => {
    await expect(
      service({ active: false }).totalForUser(USER_ID),
    ).resolves.toBeNull();
    await expect(
      service({ verified: false }).totalForUser(USER_ID),
    ).resolves.toBeNull();
  });

  it("treats malformed downstream counts as zero", async () => {
    await expect(
      service({ chat: -1, system: Number.NaN }).totalForUser(USER_ID),
    ).resolves.toBe(0);
  });
});
