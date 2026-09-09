import { describe, expect, it } from "vitest";
import { serializeSystemMessageForRecipient } from "../../../src/serializers/systemMessageRealtimeSerializer";

const FORBIDDEN_KEYS = new Set([
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
  if (value === null || typeof value !== "object") return keys;

  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectKeys(entry, keys);
  }
  return keys;
}

describe("serializeSystemMessageForRecipient", () => {
  it("emits only the explicit recipient-safe contract", () => {
    const payload = serializeSystemMessageForRecipient(
      {
        _id: { toString: () => "message-1" },
        title: "Welcome",
        content: "Hello",
        type: "announcement",
        priority: "high",
        createdAt: new Date("2026-09-09T12:00:00.000Z"),
        creator: {
          id: "creator-1",
          firstName: "Ada",
          lastName: "Lovelace",
          username: "ada",
          avatar: "/ada.png",
          gender: "female",
          authLevel: "Administrator",
          roleInAtCloud: "Mentor",
          email: "private@example.com",
        },
        targetUserId: "recipient-1",
        metadata: {
          eventId: "event-1",
          nested: {
            userStates: { "recipient-2": { isReadInBell: false } },
            createdBy: "private-creator-id",
            safe: true,
          },
        },
        userStates: {
          "recipient-1": { isReadInBell: false },
          "recipient-2": { isReadInBell: false },
        },
        targetRoles: ["Participant"],
        createdBy: "private-creator-id",
        __v: 3,
        toJSON: () => ({ userStates: { "recipient-2": {} } }),
      } as never,
      "recipient-1",
    );

    expect(payload).toEqual({
      id: "message-1",
      title: "Welcome",
      content: "Hello",
      type: "announcement",
      priority: "high",
      createdAt: "2026-09-09T12:00:00.000Z",
      creator: {
        id: "creator-1",
        firstName: "Ada",
        lastName: "Lovelace",
        username: "ada",
        avatar: "/ada.png",
        gender: "female",
        authLevel: "Administrator",
        roleInAtCloud: "Mentor",
      },
      targetUserId: "recipient-1",
      metadata: {
        eventId: "event-1",
        nested: { safe: true },
      },
    });

    const keys = collectKeys(payload);
    for (const forbiddenKey of FORBIDDEN_KEYS) {
      expect(keys.has(forbiddenKey), forbiddenKey).toBe(false);
    }
  });

  it("honors hideCreator and does not expose another user's target id", () => {
    const payload = serializeSystemMessageForRecipient(
      {
        _id: "message-2",
        title: "Private update",
        content: "Content",
        type: "auth_level_change",
        priority: "medium",
        createdAt: "2026-09-09T12:00:00.000Z",
        hideCreator: true,
        creator: {
          id: "creator-1",
          firstName: "Hidden",
          lastName: "Creator",
          username: "hidden",
          gender: "male",
          authLevel: "Super Admin",
        },
        targetUserId: "another-recipient",
      },
      "recipient-1",
    );

    expect(payload).not.toHaveProperty("creator");
    expect(payload).not.toHaveProperty("targetUserId");
  });
});
