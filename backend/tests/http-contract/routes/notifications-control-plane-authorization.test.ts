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

    const isAdmin =
      authorization === "Bearer admin" ||
      authorization === "Bearer super-admin";
    req.user = {
      id: isAdmin ? "admin-user" : "low-permission-user",
      role: isAdmin ? "Administrator" : "Participant",
    };
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
  getSystemMessages: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true, data: { messages: [] } }),
  ),
  markSystemMessageAsRead: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  createSystemMessage: vi.fn((_req: Request, res: Response) =>
    res.status(201).json({ success: true }),
  ),
  deleteSystemMessage: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  getBellNotifications: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true, data: { notifications: [] } }),
  ),
  markBellNotificationAsRead: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  markAllBellNotificationsAsRead: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  removeBellNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  getUnreadCounts: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  cleanupExpiredMessages: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  checkWelcomeMessageStatus: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendWelcomeNotification: vi.fn((_req: Request, res: Response) =>
    res.status(201).json({ success: true }),
  ),
  sendEventCreatedNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendSystemAuthorizationChangeNotification: vi.fn(
    (_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
  sendCoOrganizerAssignedNotification: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ success: true }),
  ),
}));

vi.mock(
  "../../../src/controllers/message/SystemMessagesRetrievalController",
  () => ({
    default: { getSystemMessages: controllerMocks.getSystemMessages },
  }),
);
vi.mock("../../../src/controllers/message/SystemMessagesReadController", () => ({
  default: {
    markSystemMessageAsRead: controllerMocks.markSystemMessageAsRead,
  },
}));
vi.mock(
  "../../../src/controllers/message/SystemMessagesCreationController",
  () => ({
    default: { createSystemMessage: controllerMocks.createSystemMessage },
  }),
);
vi.mock(
  "../../../src/controllers/message/SystemMessagesDeletionController",
  () => ({
    default: { deleteSystemMessage: controllerMocks.deleteSystemMessage },
  }),
);
vi.mock(
  "../../../src/controllers/message/BellNotificationsRetrievalController",
  () => ({
    default: { getBellNotifications: controllerMocks.getBellNotifications },
  }),
);
vi.mock("../../../src/controllers/message/BellNotificationsReadController", () => ({
  default: {
    markBellNotificationAsRead: controllerMocks.markBellNotificationAsRead,
  },
}));
vi.mock(
  "../../../src/controllers/message/BellNotificationsBulkReadController",
  () => ({
    default: {
      markAllBellNotificationsAsRead:
        controllerMocks.markAllBellNotificationsAsRead,
    },
  }),
);
vi.mock(
  "../../../src/controllers/message/BellNotificationsRemovalController",
  () => ({
    default: {
      removeBellNotification: controllerMocks.removeBellNotification,
    },
  }),
);
vi.mock("../../../src/controllers/message/UnreadCountsController", () => ({
  default: { getUnreadCounts: controllerMocks.getUnreadCounts },
}));
vi.mock("../../../src/controllers/message/MessageCleanupController", () => ({
  default: { cleanupExpiredMessages: controllerMocks.cleanupExpiredMessages },
}));
vi.mock(
  "../../../src/controllers/message/WelcomeMessageStatusController",
  () => ({
    default: {
      checkWelcomeMessageStatus: controllerMocks.checkWelcomeMessageStatus,
    },
  }),
);
vi.mock("../../../src/controllers/message/WelcomeNotificationController", () => ({
  default: {
    sendWelcomeNotification: controllerMocks.sendWelcomeNotification,
  },
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
  "../../../src/controllers/emailNotifications/CoOrganizerAssignedController",
  () => ({
    default: {
      sendCoOrganizerAssignedNotification:
        controllerMocks.sendCoOrganizerAssignedNotification,
    },
  }),
);

import notificationRoutes from "../../../src/routes/notifications";

const validSystemMessage = {
  title: "Admin notice",
  content: "Authorized control-plane message.",
  type: "announcement",
  priority: "medium",
};

const controlPlaneRoutes = [
  {
    path: "/system",
    body: validSystemMessage,
    expectedStatus: 201,
    handler: controllerMocks.createSystemMessage,
  },
  {
    path: "/email/event-created",
    body: {},
    expectedStatus: 200,
    handler: controllerMocks.sendEventCreatedNotification,
  },
  {
    path: "/email/role-change",
    body: {},
    expectedStatus: 200,
    handler: controllerMocks.sendSystemAuthorizationChangeNotification,
  },
  {
    path: "/email/co-organizer-assigned",
    body: {},
    expectedStatus: 200,
    handler: controllerMocks.sendCoOrganizerAssignedNotification,
  },
  {
    path: "/cleanup",
    body: {},
    expectedStatus: 200,
    handler: controllerMocks.cleanupExpiredMessages,
  },
] as const;

const controlPlaneHandlers = controlPlaneRoutes.map(({ handler }) => handler);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", notificationRoutes);
  return app;
}

function expectNoControlPlaneHandlerCalls() {
  controlPlaneHandlers.forEach((handler) =>
    expect(handler).not.toHaveBeenCalled(),
  );
}

describe("notifications control-plane route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(controlPlaneRoutes)(
    "returns 401 for anonymous POST $path",
    async ({ path, body }) => {
      const response = await request(makeApp()).post(path).send(body);

      expect(response.status).toBe(401);
      expect(authMocks.permissionCheck).not.toHaveBeenCalled();
      expectNoControlPlaneHandlerCalls();
    },
  );

  it.each(controlPlaneRoutes)(
    "returns 403 before handler work for low-permission POST $path",
    async ({ path, body }) => {
      const response = await request(makeApp())
        .post(path)
        .set("Authorization", "Bearer participant")
        .send(body);

      expect(response.status).toBe(403);
      expect(authMocks.permissionCheck).toHaveBeenCalledWith(
        "manage_notifications",
      );
      expectNoControlPlaneHandlerCalls();
    },
  );

  it.each(controlPlaneRoutes)(
    "allows an administrator to reach POST $path",
    async ({ path, body, expectedStatus, handler }) => {
      const response = await request(makeApp())
        .post(path)
        .set("Authorization", "Bearer admin")
        .send(body);

      expect(response.status).toBe(expectedStatus);
      expect(authMocks.permissionCheck).toHaveBeenCalledWith(
        "manage_notifications",
      );
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it("checks /system permission before validating its request body", async () => {
    const deniedResponse = await request(makeApp())
      .post("/system")
      .set("Authorization", "Bearer participant")
      .send({});

    expect(deniedResponse.status).toBe(403);
    expect(controllerMocks.createSystemMessage).not.toHaveBeenCalled();

    vi.clearAllMocks();

    const authorizedResponse = await request(makeApp())
      .post("/system")
      .set("Authorization", "Bearer admin")
      .send({});

    expect(authorizedResponse.status).toBe(400);
    expect(authMocks.permissionCheck).toHaveBeenCalledWith(
      "manage_notifications",
    );
    expect(controllerMocks.createSystemMessage).not.toHaveBeenCalled();
  });

  it("does not apply control-plane permission to an ordinary authenticated GET", async () => {
    const response = await request(makeApp())
      .get("/system")
      .set("Authorization", "Bearer participant");

    expect(response.status).toBe(200);
    expect(controllerMocks.getSystemMessages).toHaveBeenCalledTimes(1);
    expect(authMocks.permissionCheck).not.toHaveBeenCalled();
  });
});
