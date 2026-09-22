import { afterEach, describe, expect, it, vi } from "vitest";
import { pushNotificationsService } from "../../services/api/pushNotifications.api";

const timestamp = "2026-09-13T12:00:00.000Z";
const dto = {
  id: "64b000000000000000000001",
  installationId: "web-550e8400-e29b-41d4-a716-446655440000",
  status: "active",
  createdAt: timestamp,
  updatedAt: timestamp,
  lastSuccessfulPushAt: null,
};

function response(data: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Push Notifications API client", () => {
  it("uses canonical settings and per-installation endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url, options) => {
        const path = String(url);
        if (path.endsWith("/push/config")) {
          return response({ enabled: true, publicKey: "BA_valid-key" });
        }
        if (path.endsWith("/push/preferences") && options?.method === "PATCH") {
          return response({
            pushEnabled: false,
            emailEnabled: true,
            updatedAt: timestamp,
          });
        }
        if (path.endsWith("/push/preferences")) {
          return response({
            pushEnabled: true,
            emailEnabled: true,
            updatedAt: null,
          });
        }
        if (path.includes(`/push/subscriptions/${dto.installationId}`)) {
          return response(null, 204);
        }
        if (path.endsWith("/push/subscriptions") && options?.method === "POST") {
          return response(dto, 201);
        }
        return response({ subscriptions: [dto] });
      },
    );

    await pushNotificationsService.getConfig();
    await pushNotificationsService.listSubscriptions();
    await pushNotificationsService.getPreferences();
    await pushNotificationsService.updatePreferences({ pushEnabled: false });
    await pushNotificationsService.upsertSubscription({
      installationId: dto.installationId,
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/example",
        expirationTime: null,
        keys: { p256dh: "abc_DEF", auth: "xyz-123" },
      },
    });
    await pushNotificationsService.removeSubscription(dto.installationId);

    const calls = fetchMock.mock.calls.map(([url, options]) => ({
      url: String(url),
      method: options?.method ?? "GET",
    }));
    expect(calls).toEqual([
      expect.objectContaining({ url: expect.stringContaining("/api/push/config") }),
      expect.objectContaining({ url: expect.stringContaining("/api/push/subscriptions") }),
      expect.objectContaining({ url: expect.stringContaining("/api/push/preferences") }),
      expect.objectContaining({ method: "PATCH" }),
      expect.objectContaining({ method: "POST" }),
      expect.objectContaining({
        url: expect.stringContaining(`/api/push/subscriptions/${dto.installationId}`),
        method: "DELETE",
      }),
    ]);
  });

  it("validates mutations before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      pushNotificationsService.updatePreferences({}),
    ).rejects.toThrow(/invalid/);
    await expect(
      pushNotificationsService.removeSubscription("bad/id"),
    ).rejects.toThrow(/installationId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
