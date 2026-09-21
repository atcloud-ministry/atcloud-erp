import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middlewareMocks = vi.hoisted(() => ({
  permission: vi.fn(),
  action: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    if (!req.get("Authorization")) {
      res.status(401).json({ success: false });
      return;
    }
    req.userId = "507f1f77bcf86cd799439011";
    req.userRole = "Participant";
    req.correlationId = "request-correlation";
    next();
  },
  authorizePermission:
    (permission: string) =>
    (_req: Request, _res: Response, next: NextFunction) => {
      middlewareMocks.permission(permission);
      next();
    },
}));

vi.mock("../../../src/middleware/authorization", () => ({
  authorizeHttp:
    (options: { action: string; resource?: (req: Request) => unknown }) =>
    (req: Request, _res: Response, next: NextFunction) => {
      middlewareMocks.action(options.action, options.resource?.(req));
      next();
    },
}));

import pushRoutes from "../../../src/routes/push";
import { pushSubscriptionService } from "../../../src/services/push/PushSubscriptionService";
import { AUTHORIZATION_ACTIONS } from "../../../src/services/authorization/types";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 3)]).toString(
  "base64url",
);
const AUTH = Buffer.alloc(16, 4).toString("base64url");

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/push", pushRoutes);
  return server;
}

function member(builder: request.Test): request.Test {
  return builder.set("Authorization", "Bearer member");
}

describe("push notification HTTP contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    middlewareMocks.permission.mockClear();
    middlewareMocks.action.mockClear();
  });

  it("requires authentication, permission, self authorization, and no-store", async () => {
    vi.spyOn(pushSubscriptionService, "publicConfig").mockReturnValue({
      enabled: false,
      publicKey: null,
    });
    await request(app()).get("/api/push/config").expect(401);
    const response = await member(request(app()).get("/api/push/config")).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(middlewareMocks.permission).toHaveBeenCalledWith(
      PERMISSIONS.VIEW_USER_PROFILES,
    );
    expect(middlewareMocks.action).toHaveBeenCalledWith(
      AUTHORIZATION_ACTIONS.NOTIFICATION_SETTINGS_MANAGE,
      { type: "notification_settings", id: "507f1f77bcf86cd799439011" },
    );
  });

  it("maps exact subscription input but returns no endpoint or encryption keys", async () => {
    const upsert = vi.spyOn(pushSubscriptionService, "upsert").mockResolvedValue({
      id: "507f1f77bcf86cd799439012",
      installationId: "ios-home-screen-1",
      status: "active",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
      lastSuccessfulPushAt: null,
    });
    const response = await member(
      request(app())
        .post("/api/push/subscriptions")
        .send({
          installationId: "ios-home-screen-1",
          subscription: {
            endpoint: "https://web.push.apple.com/Q/private",
            expirationTime: null,
            keys: { p256dh: P256DH, auth: AUTH },
          },
        }),
    ).expect(201);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          id: "507f1f77bcf86cd799439011",
          role: "Participant",
        },
        correlationId: "request-correlation",
      }),
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("web.push.apple.com");
    expect(serialized).not.toContain(P256DH);
    expect(serialized).not.toContain(AUTH);
  });

  it("validates exact payloads and maps preference/unsubscribe operations", async () => {
    const setPreferences = vi
      .spyOn(pushSubscriptionService, "setPreferences")
      .mockResolvedValue({
        pushEnabled: false,
        emailEnabled: true,
        updatedAt: "2026-09-13T12:00:00.000Z",
      });
    const unsubscribe = vi
      .spyOn(pushSubscriptionService, "unsubscribe")
      .mockResolvedValue(undefined);

    await member(
      request(app()).post("/api/push/subscriptions").send({
        installationId: "x",
        subscription: {
          endpoint: "https://127.0.0.1/push",
          expirationTime: null,
          keys: { p256dh: P256DH, auth: AUTH },
        },
      }),
    ).expect(400);
    await member(
      request(app()).patch("/api/push/preferences").send({ pushEnabled: false }),
    ).expect(200);
    await member(
      request(app()).delete("/api/push/subscriptions/ios-home-screen-1"),
    ).expect(204);
    expect(setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { pushEnabled: false } }),
    );
    expect(unsubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "ios-home-screen-1" }),
    );
  });
});
