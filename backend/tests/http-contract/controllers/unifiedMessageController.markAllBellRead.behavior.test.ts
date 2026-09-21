import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock dependencies used by the controller
vi.mock("../../../src/models/Message", () => {
  class FakeMessage {
    static find = vi.fn();
    static getUnreadCountsForUser = vi
      .fn()
      .mockResolvedValue({ systemMessages: 0, bellNotifications: 0 });
    _id: string;
    userStates = new Map();
    constructor(id: string) {
      this._id = id;
    }
    markAsReadInBell = vi.fn();
    save = vi.fn().mockResolvedValue({});
  }
  return { default: FakeMessage };
});

// Controller imports named export `socketService`
vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
    emitSystemMessageUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

// CachePatterns is imported via `../services` in controller; not strictly needed here.

import BellNotificationsBulkReadController from "../../../src/controllers/message/BellNotificationsBulkReadController";

describe("markAllBellNotificationsAsRead behavior", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Auth mock
    const mockAuth = (req: any, _res: any, next: any) => {
      req.user = { id: "user-1", role: "Participant" };
      next();
    };

    const router = express.Router();
    router.patch("/bell/read-all", mockAuth, (req, res) =>
      BellNotificationsBulkReadController.markAllBellNotificationsAsRead(
        req as any,
        res as any
      )
    );

    app.use("/api/notifications", router);
  });

  it("marks only bell notifications and does not touch system message read state", async () => {
    const FakeMessage: any = (await import("../../../src/models/Message"))
      .default;
    const m1 = new FakeMessage("m1");
    const m2 = new FakeMessage("m2");
    FakeMessage.find.mockResolvedValue([m1, m2]);

    const res = await request(app)
      .patch("/api/notifications/bell/read-all")
      .timeout(2000);

    expect(res.status).toBe(200);
    // Ensure bell read method used, not the everywhere variant
    expect(m1.markAsReadInBell).toHaveBeenCalled();
    expect(m2.markAsReadInBell).toHaveBeenCalled();
  });
});
