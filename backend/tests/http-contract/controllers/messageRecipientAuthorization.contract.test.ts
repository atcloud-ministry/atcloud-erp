import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../src/models/Message", () => ({
  default: {
    findOne: vi.fn(),
    getUnreadCountsForUser: vi.fn(),
  },
}));

vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitBellNotificationUpdate: vi.fn(),
    emitSystemMessageUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

vi.mock("../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: {
    invalidateUserCache: vi.fn(),
  },
}));

import Message from "../../../src/models/Message";
import BellNotificationsReadController from "../../../src/controllers/message/BellNotificationsReadController";
import BellNotificationsRemovalController from "../../../src/controllers/message/BellNotificationsRemovalController";
import SystemMessagesReadController from "../../../src/controllers/message/SystemMessagesReadController";
import SystemMessagesDeletionController from "../../../src/controllers/message/SystemMessagesDeletionController";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../src/services/infrastructure/CacheService";

const MESSAGE_ID = "507f1f77bcf86cd799439011";
const ORIGINAL_RECIPIENT_ID = "original-recipient";
const NON_RECIPIENT_ID = "non-recipient";

type Endpoint = {
  method: "patch" | "delete";
  path: string;
};

const endpoints: Endpoint[] = [
  { method: "patch", path: `/system/${MESSAGE_ID}/read` },
  { method: "delete", path: `/system/${MESSAGE_ID}` },
  { method: "patch", path: `/bell/${MESSAGE_ID}/read` },
  { method: "delete", path: `/bell/${MESSAGE_ID}` },
];

function createMessageDocument() {
  return {
    _id: MESSAGE_ID,
    markAsReadEverywhere: vi.fn(),
    deleteFromSystem: vi.fn(),
    removeFromBell: vi.fn(),
    getUserState: vi.fn().mockReturnValue({
      isReadInSystem: true,
      isReadInBell: true,
    }),
    save: vi.fn().mockResolvedValue(true),
  };
}

describe("message recipient authorization HTTP contract", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(Message.getUnreadCountsForUser).mockResolvedValue({
      bellNotifications: 0,
      systemMessages: 0,
      total: 0,
    });
    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
    vi.mocked(Message.findOne).mockImplementation((filter) => {
      const recipientKey = `userStates.${ORIGINAL_RECIPIENT_ID}`;
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(filter, recipientKey)
          ? createMessageDocument()
          : null
      ) as never;
    });

    app = express();
    app.use(express.json());

    const router = express.Router();
    router.use((req, _res, next) => {
      req.user = {
        id: req.header("x-test-user-id") || NON_RECIPIENT_ID,
        role: "Participant",
      } as typeof req.user;
      next();
    });
    router.patch(
      "/system/:messageId/read",
      SystemMessagesReadController.markSystemMessageAsRead
    );
    router.delete(
      "/system/:messageId",
      SystemMessagesDeletionController.deleteSystemMessage
    );
    router.patch(
      "/bell/:messageId/read",
      BellNotificationsReadController.markBellNotificationAsRead
    );
    router.delete(
      "/bell/:messageId",
      BellNotificationsRemovalController.removeBellNotification
    );
    app.use("/api/notifications", router);
  });

  it.each(endpoints)(
    "$method $path conceals the message and performs no side effects for a non-recipient",
    async ({ method, path }) => {
      const response = await request(app)
        [method](`/api/notifications${path}`)
        .set("x-test-user-id", NON_RECIPIENT_ID);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(Message.findOne).toHaveBeenLastCalledWith({
        _id: MESSAGE_ID,
        isActive: true,
        [`userStates.${NON_RECIPIENT_ID}`]: { $exists: true },
        $or: [
          { targetRoles: { $exists: false } },
          { targetRoles: { $size: 0 } },
          { targetRoles: "Participant" },
        ],
      });
      expect(CachePatterns.invalidateUserCache).not.toHaveBeenCalled();
      expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
      expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
      expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
    }
  );

  it.each(endpoints)(
    "$method $path preserves the success contract for an original recipient",
    async ({ method, path }) => {
      const response = await request(app)
        [method](`/api/notifications${path}`)
        .set("x-test-user-id", ORIGINAL_RECIPIENT_ID);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Message.findOne).toHaveBeenLastCalledWith({
        _id: MESSAGE_ID,
        isActive: true,
        [`userStates.${ORIGINAL_RECIPIENT_ID}`]: { $exists: true },
        $or: [
          { targetRoles: { $exists: false } },
          { targetRoles: { $size: 0 } },
          { targetRoles: "Participant" },
        ],
      });
    }
  );
});
