import { describe, expect, it } from "vitest";
import {
  decodeNotificationPreference,
  decodePushPublicConfig,
  decodePushSubscriptionList,
  normalizeNotificationPreferenceChanges,
  normalizePushSubscriptionInput,
} from "../../services/api/pushNotifications.contracts";

const timestamp = "2026-09-13T12:00:00.000Z";
const subscription = {
  id: "64b000000000000000000001",
  installationId: "web-550e8400-e29b-41d4-a716-446655440000",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
  lastSuccessfulPushAt: null,
};

describe("Push Notifications API response contracts", () => {
  it("decodes exact public configuration, subscription, and preference DTOs", () => {
    expect(
      decodePushPublicConfig({ enabled: true, publicKey: "BA_valid-key" }),
    ).toEqual({ enabled: true, publicKey: "BA_valid-key" });
    expect(
      decodePushSubscriptionList({ subscriptions: [subscription] }),
    ).toEqual({ subscriptions: [subscription] });
    expect(
      decodeNotificationPreference({
        pushEnabled: true,
        emailEnabled: false,
        updatedAt: timestamp,
      }),
    ).toEqual({
      pushEnabled: true,
      emailEnabled: false,
      updatedAt: timestamp,
    });
  });

  it("rejects extra fields and internally inconsistent configuration", () => {
    expect(() =>
      decodePushPublicConfig({ enabled: false, publicKey: "BA_valid-key" }),
    ).toThrow(/null while Push is disabled/);
    expect(() =>
      decodePushSubscriptionList({
        subscriptions: [{ ...subscription, endpoint: "private" }],
      }),
    ).toThrow(/exact keys/);
    expect(() =>
      decodeNotificationPreference({
        pushEnabled: true,
        emailEnabled: true,
        updatedAt: timestamp,
        email: "private@example.com",
      }),
    ).toThrow(/exact keys/);
  });

  it("rejects duplicate installations and non-canonical timestamps", () => {
    expect(() =>
      decodePushSubscriptionList({
        subscriptions: [subscription, { ...subscription, id: "64b000000000000000000002" }],
      }),
    ).toThrow(/unique installation IDs/);
    expect(() =>
      decodePushSubscriptionList({
        subscriptions: [{ ...subscription, updatedAt: "2026-09-13" }],
      }),
    ).toThrow(/canonical ISO/);
  });

  it("normalizes only valid request bodies", () => {
    const input = {
      installationId: subscription.installationId,
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/example",
        expirationTime: null,
        keys: { p256dh: "abc_DEF", auth: "xyz-123" },
      },
    };
    expect(normalizePushSubscriptionInput(input)).toEqual(input);
    expect(normalizeNotificationPreferenceChanges({ emailEnabled: false })).toEqual({
      emailEnabled: false,
    });
    expect(() => normalizeNotificationPreferenceChanges({})).toThrow(
      /invalid/,
    );
    expect(() =>
      normalizePushSubscriptionInput({
        ...input,
        subscription: { ...input.subscription, endpoint: "http://example.com" },
      }),
    ).toThrow(/endpoint/);
  });
});
