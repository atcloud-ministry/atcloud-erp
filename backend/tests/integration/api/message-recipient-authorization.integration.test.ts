import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { ensureIntegrationDB } from "../setup/connect";
import { TokenService } from "../../../src/middleware/auth";

vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    emitSystemMessageUpdate: vi.fn(),
    emitBellNotificationUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
  },
}));

import app from "../../../src/app";
import User from "../../../src/models/User";
import Message from "../../../src/models/Message";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../src/services/infrastructure/CacheService";

type Endpoint = {
  method: "patch" | "delete";
  path: (messageId: string) => string;
};

const endpoints: Endpoint[] = [
  {
    method: "patch",
    path: (messageId) => `/api/notifications/system/${messageId}/read`,
  },
  {
    method: "delete",
    path: (messageId) => `/api/notifications/system/${messageId}`,
  },
  {
    method: "patch",
    path: (messageId) => `/api/notifications/bell/${messageId}/read`,
  },
  {
    method: "delete",
    path: (messageId) => `/api/notifications/bell/${messageId}`,
  },
];

const creator = {
  id: "system",
  firstName: "System",
  lastName: "Administrator",
  username: "system",
  gender: "male" as const,
  authLevel: "Super Admin",
};

async function createParticipant(suffix: string) {
  const usernameSuffix = suffix.replace(/-/g, "_");
  return User.create({
    username: `msg_${usernameSuffix}`,
    email: `recipient-auth-${suffix}@example.com`,
    password: "Password123",
    role: "Participant",
    isActive: true,
    isVerified: true,
  });
}

async function createMessageFor(
  recipientIds: string[],
  targetRoles?: string[]
) {
  const userStates = Object.fromEntries(
    recipientIds.map((recipientId) => [
      recipientId,
      {
        isReadInBell: false,
        isReadInSystem: false,
        isRemovedFromBell: false,
        isDeletedFromSystem: false,
      },
    ])
  );

  return Message.create({
    type: "announcement",
    title: "Recipient authorization test",
    content: "Only persisted, currently authorized recipients may mutate this.",
    priority: "medium",
    creator,
    userStates,
    targetRoles,
    isActive: true,
  });
}

describe("message recipient authorization integration", () => {
  beforeEach(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});
    await Message.deleteMany({});
    vi.clearAllMocks();
  });

  it("returns the same 404 as an unknown ID and creates no state for a non-recipient", async () => {
    const caller = await createParticipant("caller");
    const originalRecipient = await createParticipant("original");
    const callerId = caller._id.toString();
    const originalRecipientId = originalRecipient._id.toString();
    const token = TokenService.generateTokenPair(caller).accessToken;
    const message = await createMessageFor([originalRecipientId]);
    const messageId = message._id.toString();
    const invalidateSpy = vi
      .spyOn(CachePatterns, "invalidateUserCache")
      .mockResolvedValue(undefined);

    for (const endpoint of endpoints) {
      const unauthorizedResponse = await request(app)
        [endpoint.method](endpoint.path(messageId))
        .set("Authorization", `Bearer ${token}`);
      const unknownResponse = await request(app)
        [endpoint.method](
          endpoint.path(new mongoose.Types.ObjectId().toString())
        )
        .set("Authorization", `Bearer ${token}`);

      expect(unauthorizedResponse.status).toBe(404);
      expect(unauthorizedResponse.body).toEqual(unknownResponse.body);
    }

    const unchangedMessage = await Message.findById(messageId);
    expect(unchangedMessage?.userStates.has(callerId)).toBe(false);
    expect(unchangedMessage?.userStates.get(originalRecipientId)).toMatchObject({
      isReadInBell: false,
      isReadInSystem: false,
      isRemovedFromBell: false,
      isDeletedFromSystem: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
    expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
    expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it("returns the same 404 as an unknown ID for every inactive-message mutation", async () => {
    const caller = await createParticipant("inactive");
    const callerId = caller._id.toString();
    const token = TokenService.generateTokenPair(caller).accessToken;
    const message = await createMessageFor([callerId]);
    const messageId = message._id.toString();
    await Message.updateOne({ _id: message._id }, { $set: { isActive: false } });
    const invalidateSpy = vi
      .spyOn(CachePatterns, "invalidateUserCache")
      .mockResolvedValue(undefined);

    for (const endpoint of endpoints) {
      const inactiveResponse = await request(app)
        [endpoint.method](endpoint.path(messageId))
        .set("Authorization", `Bearer ${token}`);
      const unknownResponse = await request(app)
        [endpoint.method](
          endpoint.path(new mongoose.Types.ObjectId().toString()),
        )
        .set("Authorization", `Bearer ${token}`);

      expect(inactiveResponse.status).toBe(404);
      expect(inactiveResponse.body).toEqual(unknownResponse.body);
    }

    const unchangedMessage = await Message.findById(messageId);
    expect(unchangedMessage?.userStates.get(callerId)).toMatchObject({
      isReadInBell: false,
      isReadInSystem: false,
      isRemovedFromBell: false,
      isDeletedFromSystem: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
    expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
    expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it("fails closed for legacy null role restrictions", async () => {
    const caller = await createParticipant("legacy-null-role");
    const callerId = caller._id.toString();
    const token = TokenService.generateTokenPair(caller).accessToken;
    const nullRoleMessage = await createMessageFor([callerId]);
    const nullElementMessage = await createMessageFor([callerId]);
    await Message.collection.updateOne(
      { _id: nullRoleMessage._id },
      { $set: { targetRoles: null } },
    );
    await Message.collection.updateOne(
      { _id: nullElementMessage._id },
      { $set: { targetRoles: [null, "Administrator"] } },
    );
    const invalidateSpy = vi
      .spyOn(CachePatterns, "invalidateUserCache")
      .mockResolvedValue(undefined);

    for (const message of [nullRoleMessage, nullElementMessage]) {
      for (const endpoint of endpoints) {
        const response = await request(app)
          [endpoint.method](endpoint.path(message._id.toString()))
          .set("Authorization", `Bearer ${token}`);

        expect(response.status).toBe(404);
      }
    }

    const systemResponse = await request(app)
      .get("/api/notifications/system")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const bellResponse = await request(app)
      .get("/api/notifications/bell")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(systemResponse.body.data.messages).toEqual([]);
    expect(bellResponse.body.data.notifications).toEqual([]);

    const unchangedMessages = await Message.find({
      _id: { $in: [nullRoleMessage._id, nullElementMessage._id] },
    });
    unchangedMessages.forEach((unchangedMessage) => {
      expect(unchangedMessage.userStates.get(callerId)).toMatchObject({
        isReadInBell: false,
        isReadInSystem: false,
        isRemovedFromBell: false,
        isDeletedFromSystem: false,
      });
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
    expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
    expect(socketService.emitUnreadCountUpdate).not.toHaveBeenCalled();
    invalidateSpy.mockRestore();
  });

  it("rejects every mutation after the recipient no longer matches targetRoles", async () => {
    const caller = await createParticipant("role-mismatch");
    const callerId = caller._id.toString();
    const token = TokenService.generateTokenPair(caller).accessToken;
    const message = await createMessageFor([callerId], ["Administrator"]);
    const messageId = message._id.toString();
    const invalidateSpy = vi
      .spyOn(CachePatterns, "invalidateUserCache")
      .mockResolvedValue(undefined);

    for (const endpoint of endpoints) {
      const response = await request(app)
        [endpoint.method](endpoint.path(messageId))
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(404);
    }

    const countsResponse = await request(app)
      .get("/api/notifications/unread-counts")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(countsResponse.body.data).toEqual({
      bellNotifications: 0,
      systemMessages: 0,
      total: 0,
    });

    const bulkResponse = await request(app)
      .patch("/api/notifications/bell/read-all")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(bulkResponse.body.data.markedCount).toBe(0);

    const unchangedMessage = await Message.findById(messageId);
    expect(unchangedMessage?.userStates.get(callerId)).toMatchObject({
      isReadInBell: false,
      isReadInSystem: false,
      isRemovedFromBell: false,
      isDeletedFromSystem: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(socketService.emitSystemMessageUpdate).not.toHaveBeenCalled();
    expect(socketService.emitBellNotificationUpdate).not.toHaveBeenCalled();
    expect(socketService.emitUnreadCountUpdate).toHaveBeenCalledWith(callerId, {
      bellNotifications: 0,
      systemMessages: 0,
      total: 0,
    });
    invalidateSpy.mockRestore();
  });

  it("keeps all four mutation contracts available to a matching recipient", async () => {
    const caller = await createParticipant("matching-role");
    const callerId = caller._id.toString();
    const token = TokenService.generateTokenPair(caller).accessToken;

    for (const endpoint of endpoints) {
      const message = await createMessageFor([callerId], ["Participant"]);
      const response = await request(app)
        [endpoint.method](endpoint.path(message._id.toString()))
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    }
  });
});
