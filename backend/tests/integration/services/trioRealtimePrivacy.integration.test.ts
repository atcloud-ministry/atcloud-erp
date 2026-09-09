import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Message from "../../../src/models/Message";
import User from "../../../src/models/User";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { TrioNotificationService } from "../../../src/services/notifications/TrioNotificationService";

const FORBIDDEN_REALTIME_KEYS = new Set([
  "_id",
  "__v",
  "createdBy",
  "userStates",
  "targetRoles",
  "recipients",
  "recipientIds",
  "targetUserIds",
]);

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  Object.entries(value).forEach(([key, entry]) => {
    keys.add(key);
    collectKeys(entry, keys);
  });
  return keys;
}

describe("Trio recipient-safe realtime delivery", () => {
  const emitSpy = vi.spyOn(socketService, "emitSystemMessageUpdate");

  beforeEach(() => {
    emitSpy.mockClear();
    TrioNotificationService.resetMetrics();
  });

  afterEach(() => {
    emitSpy.mockClear();
  });

  it("emits once only to each persisted role-filtered recipient", async () => {
    const [allowed, filteredOut] = await User.create([
      {
        email: "trio-allowed@example.com",
        username: "trio_allowed",
        firstName: "Allowed",
        lastName: "Admin",
        password: "Password123!",
        role: "Administrator",
        isActive: true,
        isVerified: true,
        gender: "female",
      },
      {
        email: "trio-filtered@example.com",
        username: "trio_filtered",
        firstName: "Filtered",
        lastName: "Participant",
        password: "Password123!",
        role: "Participant",
        isActive: true,
        isVerified: true,
        gender: "male",
      },
    ]);
    const allowedId = allowed._id.toString();
    const filteredOutId = filteredOut._id.toString();

    const result = await TrioNotificationService.createTrio({
      systemMessage: {
        title: "Administrators only",
        content: "Recipient-safe content",
        type: "announcement",
        priority: "high",
        hideCreator: true,
        targetRoles: ["Administrator"],
        metadata: {
          eventId: "event-1",
          nested: {
            userStates: { [filteredOutId]: { isReadInBell: false } },
          },
        },
      },
      recipients: [allowedId, filteredOutId, allowedId],
    });

    expect(result.success).toBe(true);
    expect(result.notificationsSent).toBe(1);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      allowedId,
      "message_created",
      expect.any(Object),
    );
    expect(emitSpy).not.toHaveBeenCalledWith(
      filteredOutId,
      "message_created",
      expect.any(Object),
    );

    const payload = emitSpy.mock.calls[0][2];
    expect(payload.message).not.toHaveProperty("creator");
    const keys = collectKeys(payload);
    FORBIDDEN_REALTIME_KEYS.forEach((key) =>
      expect(keys.has(key), key).toBe(false),
    );

    const persistedMessage = await Message.findById(result.messageId);
    expect(Array.from(persistedMessage?.userStates.keys() ?? [])).toEqual([
      allowedId,
    ]);
  });
});
