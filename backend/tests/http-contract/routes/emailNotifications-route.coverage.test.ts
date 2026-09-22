import { beforeEach, describe, expect, it, vi } from "vitest";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";

const authMocks = vi.hoisted(() => ({
  permissionCheck: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get("Authorization");
    if (!authorization) {
      res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
      return;
    }

    req.userId = authorization.endsWith("admin") ? "admin-user" : "member-user";
    next();
  },
  authorizePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      authMocks.permissionCheck(permission);
      const authorization = req.get("Authorization");
      if (
        authorization !== "Bearer admin" &&
        authorization !== "Bearer super-admin"
      ) {
        res.status(403).json({
          success: false,
          message: `Access denied. Required permission: ${permission}`,
        });
        return;
      }
      next();
    },
}));

const controllerMocks = vi.hoisted(() => ({
  sendEventCreatedNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendSystemAuthorizationChangeNotification: vi.fn(
    (_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendAtCloudRoleChangeNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendNewLeaderSignupNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendCoOrganizerAssignedNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendEventReminderNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
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

const routes = [
  {
    path: "/event-created",
    expectedStatus: 200,
    handler: controllerMocks.sendEventCreatedNotification,
  },
  {
    path: "/system-authorization-change",
    expectedStatus: 200,
    handler: controllerMocks.sendSystemAuthorizationChangeNotification,
  },
  {
    path: "/atcloud-role-change",
    expectedStatus: 200,
    handler: controllerMocks.sendAtCloudRoleChangeNotification,
  },
  {
    path: "/new-leader-signup",
    expectedStatus: 200,
    handler: controllerMocks.sendNewLeaderSignupNotification,
  },
  {
    path: "/co-organizer-assigned",
    expectedStatus: 200,
    handler: controllerMocks.sendCoOrganizerAssignedNotification,
  },
  {
    path: "/event-reminder",
    expectedStatus: 200,
    handler: controllerMocks.sendEventReminderNotification,
  },
  { path: "/password-reset", expectedStatus: 501 },
  { path: "/email-verification", expectedStatus: 501 },
  { path: "/security-alert", expectedStatus: 501 },
  { path: "/schedule-reminder", expectedStatus: 200, scheduler: true },
  { path: "/event-role-removal", expectedStatus: 501 },
  { path: "/event-role-move", expectedStatus: 501 },
] as const;

const controllerHandlers = Object.values(controllerMocks);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", emailNotificationRouter);
  return app;
}

function expectNoDeliverySideEffects() {
  controllerHandlers.forEach((handler) => expect(handler).not.toHaveBeenCalled());
  expect(schedulerMocks.triggerManualCheck).not.toHaveBeenCalled();
}

describe("emailNotifications routes authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(routes)("returns 401 for anonymous POST $path", async ({ path }) => {
    const response = await request(makeApp()).post(path).send({});

    expect(response.status).toBe(401);
    expect(authMocks.permissionCheck).not.toHaveBeenCalled();
    expectNoDeliverySideEffects();
  });

  it.each(routes)(
    "returns 403 before handler work for low-permission POST $path",
    async ({ path }) => {
      const response = await request(makeApp())
        .post(path)
        .set("Authorization", "Bearer participant")
        .send({});

      expect(response.status).toBe(403);
      expect(authMocks.permissionCheck).toHaveBeenCalledWith(
        "manage_notifications",
      );
      expectNoDeliverySideEffects();
    },
  );

  it.each(routes)(
    "allows an administrator to reach POST $path",
    async ({ path, expectedStatus, ...route }) => {
      const response = await request(makeApp())
        .post(path)
        .set("Authorization", "Bearer admin")
        .send({});

      expect(response.status).toBe(expectedStatus);
      expect(authMocks.permissionCheck).toHaveBeenCalledWith(
        "manage_notifications",
      );

      if ("handler" in route && route.handler) {
        expect(route.handler).toHaveBeenCalledTimes(1);
      }
      if ("scheduler" in route && route.scheduler) {
        expect(schedulerMocks.triggerManualCheck).toHaveBeenCalledWith(
          "admin-user",
        );
      }
    },
  );

  it("does not expose the former test reminder route to an administrator", async () => {
    const response = await request(makeApp())
      .post("/test-event-reminder")
      .set("Authorization", "Bearer admin");

    expect(response.status).toBe(404);
    expectNoDeliverySideEffects();
  });

  it("returns 500 when the authorized schedule-reminder handler fails", async () => {
    schedulerMocks.triggerManualCheck.mockRejectedValueOnce(new Error("boom"));

    const response = await request(makeApp())
      .post("/schedule-reminder")
      .set("Authorization", "Bearer admin");

    expect(response.status).toBe(500);
    expect(authMocks.permissionCheck).toHaveBeenCalledWith(
      "manage_notifications",
    );
  });
});
