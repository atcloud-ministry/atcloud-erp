import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const authMocks = vi.hoisted(() => ({
  permissionCheck: vi.fn(),
}));

// Mock authentication/authorization adapters to no-op for route wiring tests.
vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: any, res: any, next: any) => next(),
  authorizePermission:
    (permission: string) => (req: any, res: any, next: any) => {
      authMocks.permissionCheck(permission);
      next();
    },
}));

// Hoisted controller mocks so they can be referenced inside vi.mock factory
const controllerMocks = vi.hoisted(() => ({
  sendEventCreatedNotification: vi.fn((req: any, res: any) =>
    res.status(200).json({ success: true })
  ),
  sendSystemAuthorizationChangeNotification: vi.fn((req: any, res: any) =>
    res.status(200).json({ success: true })
  ),
  sendAtCloudRoleChangeNotification: vi.fn((req: any, res: any) =>
    res.status(200).json({ success: true })
  ),
  sendNewLeaderSignupNotification: vi.fn((req: any, res: any) =>
    res.status(200).json({ success: true })
  ),
  sendCoOrganizerAssignedNotification: vi.fn((req: any, res: any) =>
    res.status(200).json({ success: true })
  ),
  sendEventReminderNotification: vi.fn((req: any, res: any) =>
    res.status(200).json({ success: true })
  ),
}));

vi.mock(
  "../../../src/controllers/emailNotifications/EventCreatedController",
  () => ({
    default: {
      sendEventCreatedNotification:
        controllerMocks.sendEventCreatedNotification,
    },
  }),
);
vi.mock(
  "../../../src/controllers/emailNotifications/SystemAuthorizationChangeController",
  () => ({
    default: {
      sendSystemAuthorizationChangeNotification:
        controllerMocks.sendSystemAuthorizationChangeNotification,
    },
  }),
);
vi.mock(
  "../../../src/controllers/emailNotifications/AtCloudRoleChangeController",
  () => ({
    default: {
      sendAtCloudRoleChangeNotification:
        controllerMocks.sendAtCloudRoleChangeNotification,
    },
  }),
);
vi.mock(
  "../../../src/controllers/emailNotifications/NewLeaderSignupController",
  () => ({
    default: {
      sendNewLeaderSignupNotification:
        controllerMocks.sendNewLeaderSignupNotification,
    },
  }),
);
vi.mock(
  "../../../src/controllers/emailNotifications/CoOrganizerAssignedController",
  () => ({
    default: {
      sendCoOrganizerAssignedNotification:
        controllerMocks.sendCoOrganizerAssignedNotification,
    },
  }),
);
vi.mock(
  "../../../src/controllers/emailNotifications/EventReminderController",
  () => ({
    default: {
      sendEventReminderNotification:
        controllerMocks.sendEventReminderNotification,
    },
  }),
);

// Mock scheduler used by schedule-reminder endpoint
const schedulerMocks = vi.hoisted(() => ({
  triggerManualCheck: vi.fn(async () => {}),
}));
vi.mock("../../../src/services/EventReminderScheduler", () => ({
  default: {
    getInstance: () => ({
      triggerManualCheck: schedulerMocks.triggerManualCheck,
    }),
  },
}));

import { emailNotificationRouter } from "../../../src/routes/emailNotifications";

const makeApp = () => {
  const app = express();
  app.use("/", emailNotificationRouter);
  return app;
};

describe("emailNotifications routes coverage", () => {
  // Ensure return type is void to satisfy Vitest's Hook typings
  beforeEach(() => {
    vi.clearAllMocks();
    return undefined;
  });

  it("does not expose the former public test reminder route", async () => {
    const res = await request(makeApp()).post("/test-event-reminder");
    expect(res.status).toBe(404);
    expect(controllerMocks.sendEventReminderNotification).not.toHaveBeenCalled();
  });

  it.each(["/event-reminder", "/schedule-reminder"])(
    "protects %s with notification-management permission",
    async (path) => {
      const res = await request(makeApp()).post(path);

      expect(res.status).toBe(200);
      expect(authMocks.permissionCheck).toHaveBeenCalledWith(
        "manage_notifications",
      );
    },
  );

  it("All implemented endpoints return expected codes with mocks", async () => {
    const app = makeApp();
    const endpoints = [
      "/event-created",
      "/system-authorization-change",
      "/atcloud-role-change",
      "/new-leader-signup",
      "/co-organizer-assigned",
      "/event-reminder",
      "/schedule-reminder",
      // Not implemented yet endpoints
      "/password-reset",
      "/email-verification",
      "/security-alert",
      "/event-role-removal",
      "/event-role-move",
    ];

    for (const ep of endpoints) {
      const res = await request(app).post(ep);
      // /schedule-reminder returns 200 on success; others via controller
      expect([200, 501]).toContain(res.status);
    }

    expect(schedulerMocks.triggerManualCheck).toHaveBeenCalled();
  });

  it("POST /schedule-reminder returns 500 when scheduler throws", async () => {
    schedulerMocks.triggerManualCheck.mockRejectedValueOnce(new Error("boom"));
    const res = await request(makeApp()).post("/schedule-reminder");
    expect(res.status).toBe(500);
  });
});
