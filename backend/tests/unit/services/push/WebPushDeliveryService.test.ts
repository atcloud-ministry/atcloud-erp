import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebPushDeliveryService } from "../../../../src/services/push/WebPushDeliveryService";

const CONFIG = Object.freeze({
  enabled: true as const,
  subject: "mailto:security@example.org",
  publicKey: `B${"a".repeat(86)}`,
  privateKey: "b".repeat(43),
});
const PAYLOAD = Object.freeze({
  title: "@Cloud",
  body: "You have an update.",
  tag: "system-update",
  deepLink: "/#/dashboard/notifications",
  badgeCount: 2,
});

function expectedTopic(tag: string): string {
  return `atc-${createHash("sha256").update(tag, "utf8").digest("base64url").slice(0, 28)}`;
}

function target() {
  return Object.freeze({
    id: "507f1f77bcf86cd799439011",
    endpoint: "https://fcm.googleapis.com/fcm/send/private-endpoint",
    keys: Object.freeze({ p256dh: "private-p256dh", auth: "private-auth" }),
    deliveredEventIds: Object.freeze([] as string[]),
  });
}

describe("WebPushDeliveryService recipient sender", () => {
  it("records success and never places endpoint/key material in the payload", async () => {
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
    const subscriptions = {
      getPreferences: vi.fn().mockResolvedValue({
        pushEnabled: true,
        emailEnabled: true,
        updatedAt: null,
      }),
      listDeliveryTargets: vi.fn().mockResolvedValue([target()]),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordTransientFailure: vi.fn(),
      invalidate: vi.fn(),
    };
    const service = new WebPushDeliveryService({
      config: () => CONFIG,
      subscriptions,
      transport: { sendNotification },
    });

    await expect(
      service.deliverUserNotification({
        eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
        recipientUserId: "507f1f77bcf86cd799439012",
        payload: PAYLOAD,
      }),
    ).resolves.toMatchObject({ route: "delivered", succeeded: 1 });
    const serialized = sendNotification.mock.calls[0]?.[1] as string;
    expect(serialized).toBe(JSON.stringify(PAYLOAD));
    expect(serialized).not.toContain("private-endpoint");
    expect(serialized).not.toContain("private-p256dh");
    expect(sendNotification.mock.calls[0]?.[2]).toMatchObject({
      topic: expectedTopic(PAYLOAD.tag),
      timeout: 10_000,
    });
    expect(subscriptions.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([404, 410])(
    "deletes a %i endpoint and reports permanent-only delivery",
    async (providerStatus) => {
      const subscriptions = {
        getPreferences: vi.fn().mockResolvedValue({
          pushEnabled: true,
          emailEnabled: true,
          updatedAt: null,
        }),
        listDeliveryTargets: vi.fn().mockResolvedValue([target()]),
        recordSuccess: vi.fn(),
        recordTransientFailure: vi.fn(),
        invalidate: vi.fn().mockResolvedValue(undefined),
      };
      const service = new WebPushDeliveryService({
        config: () => CONFIG,
        subscriptions,
        transport: {
          sendNotification: vi.fn().mockRejectedValue({ statusCode: providerStatus }),
        },
      });
      await expect(
        service.deliverUserNotification({
          eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
          recipientUserId: "507f1f77bcf86cd799439012",
          payload: PAYLOAD,
        }),
      ).resolves.toMatchObject({
        route: "permanent_failure",
        permanentFailures: 1,
        transientFailures: 0,
      });
      expect(subscriptions.invalidate).toHaveBeenCalledWith(
        target().id,
        "PUSH_ENDPOINT_GONE",
      );
    },
  );

  it.each([300, 400, 401, 403, 413])(
    "reports deterministic HTTP %i failures as permanent without deleting the endpoint",
    async (providerStatus) => {
      const subscriptions = {
        getPreferences: vi.fn().mockResolvedValue({
          pushEnabled: true,
          emailEnabled: true,
          updatedAt: null,
        }),
        listDeliveryTargets: vi.fn().mockResolvedValue([target()]),
        recordSuccess: vi.fn(),
        recordTransientFailure: vi.fn(),
        invalidate: vi.fn(),
      };
      const service = new WebPushDeliveryService({
        config: () => CONFIG,
        subscriptions,
        transport: {
          sendNotification: vi.fn().mockRejectedValue({ statusCode: providerStatus }),
        },
      });

      await expect(
        service.deliverUserNotification({
          eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
          recipientUserId: "507f1f77bcf86cd799439012",
          payload: PAYLOAD,
        }),
      ).resolves.toMatchObject({
        route: "permanent_failure",
        permanentFailures: 1,
        transientFailures: 0,
      });
      expect(subscriptions.invalidate).not.toHaveBeenCalled();
      expect(subscriptions.recordTransientFailure).not.toHaveBeenCalled();
    },
  );

  it.each([408, 425, 429, 500, 503])(
    "reports transient HTTP %i failures for outbox retry without invalidating",
    async (providerStatus) => {
      const subscriptions = {
        getPreferences: vi.fn().mockResolvedValue({
          pushEnabled: true,
          emailEnabled: true,
          updatedAt: null,
        }),
        listDeliveryTargets: vi.fn().mockResolvedValue([target()]),
        recordSuccess: vi.fn(),
        recordTransientFailure: vi.fn().mockResolvedValue(undefined),
        invalidate: vi.fn(),
      };
      const service = new WebPushDeliveryService({
        config: () => CONFIG,
        subscriptions,
        transport: {
          sendNotification: vi.fn().mockRejectedValue({ statusCode: providerStatus }),
        },
      });
      await expect(
        service.deliverUserNotification({
          eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
          recipientUserId: "507f1f77bcf86cd799439012",
          payload: PAYLOAD,
        }),
      ).resolves.toMatchObject({
        route: "transient_failure",
        transientFailures: 1,
      });
      expect(subscriptions.invalidate).not.toHaveBeenCalled();
      expect(subscriptions.recordTransientFailure).toHaveBeenCalledWith(
        target().id,
        "PUSH_PROVIDER_TRANSIENT",
      );
    },
  );

  it("reports network failures for retry without exposing provider details", async () => {
    const subscriptions = {
      getPreferences: vi.fn().mockResolvedValue({
        pushEnabled: true,
        emailEnabled: true,
        updatedAt: null,
      }),
      listDeliveryTargets: vi.fn().mockResolvedValue([target()]),
      recordSuccess: vi.fn(),
      recordTransientFailure: vi.fn().mockResolvedValue(undefined),
      invalidate: vi.fn(),
    };
    const service = new WebPushDeliveryService({
      config: () => CONFIG,
      subscriptions,
      transport: {
        sendNotification: vi.fn().mockRejectedValue(new Error("private provider detail")),
      },
    });

    await expect(
      service.deliverUserNotification({
        eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
        recipientUserId: "507f1f77bcf86cd799439012",
        payload: PAYLOAD,
      }),
    ).resolves.toMatchObject({
      route: "transient_failure",
      transientFailures: 1,
    });
    expect(subscriptions.recordTransientFailure).toHaveBeenCalledWith(
      target().id,
      "PUSH_DELIVERY_FAILED",
    );
  });

  it("uses stable, resource-scoped hashed topics for all tags, including chat and help", async () => {
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
    const subscriptions = {
      getPreferences: vi.fn().mockResolvedValue({
        pushEnabled: true,
        emailEnabled: true,
        updatedAt: null,
      }),
      listDeliveryTargets: vi.fn().mockResolvedValue([target()]),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordTransientFailure: vi.fn(),
      invalidate: vi.fn(),
    };
    const service = new WebPushDeliveryService({
      config: () => CONFIG,
      subscriptions,
      transport: { sendNotification },
    });
    const chatTag = "chat-507f1f77bcf86cd799439011";
    const helpTag = "help-507f1f77bcf86cd799439013";
    const unsafeTag = `chat room ${"x".repeat(48)}`;
    expect(chatTag).toHaveLength(29);

    for (const [index, tag] of [chatTag, helpTag, unsafeTag, unsafeTag].entries()) {
      await service.deliverUserNotification({
        eventId: `event-${index}`,
        recipientUserId: "507f1f77bcf86cd799439012",
        payload: { ...PAYLOAD, tag },
      });
    }

    const topics = sendNotification.mock.calls.map(
      (call) => (call[2] as { topic?: string }).topic,
    );
    expect(topics.slice(0, 2)).toEqual([
      expectedTopic(chatTag),
      expectedTopic(helpTag),
    ]);
    expect(topics[0]).not.toBe(chatTag);
    expect(topics[1]).not.toBe(helpTag);
    expect(topics[0]).not.toBe(topics[1]);
    expect(topics[2]).toBe(topics[3]);
    expect(topics[2]).toBe(expectedTopic(unsafeTag));
    for (const topic of topics) {
      expect(topic).toMatch(/^atc-[A-Za-z0-9_-]{28}$/);
    }
  });

  it("skips a subscription already marked for the same event", async () => {
    const eventId = "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5";
    const subscriptions = {
      getPreferences: vi.fn().mockResolvedValue({
        pushEnabled: true,
        emailEnabled: true,
        updatedAt: null,
      }),
      listDeliveryTargets: vi.fn().mockResolvedValue([
        { ...target(), deliveredEventIds: [eventId] },
      ]),
      recordSuccess: vi.fn(),
      recordTransientFailure: vi.fn(),
      invalidate: vi.fn(),
    };
    const sendNotification = vi.fn();
    const service = new WebPushDeliveryService({
      config: () => CONFIG,
      subscriptions,
      transport: { sendNotification },
    });
    await expect(
      service.deliverUserNotification({
        eventId,
        recipientUserId: "507f1f77bcf86cd799439012",
        payload: PAYLOAD,
      }),
    ).resolves.toMatchObject({ route: "delivered", attempted: 0, succeeded: 1 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
