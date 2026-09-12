import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AuditLog from "../../../src/models/AuditLog";
import AlumniHelpRequest from "../../../src/models/AlumniHelpRequest";
import ChatMessage from "../../../src/models/ChatMessage";
import Conversation from "../../../src/models/Conversation";
import ConversationMember from "../../../src/models/ConversationMember";
import NotificationPreference from "../../../src/models/NotificationPreference";
import PushSubscription from "../../../src/models/PushSubscription";
import User from "../../../src/models/User";
import { initializeAlumniDataModels } from "../../../src/models/initializeAlumniDataModels";
import { webPushPublicKeyId } from "../../../src/config/webPush";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { PushSubscriptionService } from "../../../src/services/push/PushSubscriptionService";
import { ExternalNotificationEmailService } from "../../../src/services/push/ExternalNotificationEmailService";
import { WebPushDeliveryService } from "../../../src/services/push/WebPushDeliveryService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2033-09-13T12:00:00.000Z");
const CONFIG = Object.freeze({
  enabled: true as const,
  subject: "mailto:security@example.org",
  publicKey: `B${"a".repeat(86)}`,
  privateKey: "b".repeat(43),
});
const models = [
  AuditLog,
  AlumniHelpRequest,
  ChatMessage,
  ConversationMember,
  Conversation,
  NotificationPreference,
  PushSubscription,
  User,
] as const;

async function insertUser(label: string): Promise<mongoose.Types.ObjectId> {
  const _id = new mongoose.Types.ObjectId();
  const username = `push-${label}-${_id.toString().slice(-8)}`.toLowerCase();
  await User.collection.insertOne({
    _id,
    username,
    usernameLower: username,
    email: `${username}@private.example.org`,
    password: "integration-test-only",
    firstName: label,
    lastName: "Member",
    role: "Participant",
    isActive: true,
    isVerified: true,
    emailNotifications: true,
    loginAttempts: 0,
    hasReceivedWelcomeMessage: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return _id;
}

function input(endpointId: string, installationId = "ios-home-screen") {
  return Object.freeze({
    installationId,
    endpoint: `https://web.push.apple.com/Q/${endpointId}`,
    expirationTime: null,
    keys: Object.freeze({ p256dh: "abc_DEF-123", auth: "auth_123" }),
  });
}

describe("M5 PushSubscription and notification preference integration", () => {
  let transactions: MongoTransactionService;
  let service: PushSubscriptionService;

  beforeAll(async () => {
    await ensureIntegrationDB();
    await initializeAlumniDataModels();
    transactions = new MongoTransactionService(mongoose.connection);
    expect((await transactions.assertTopologyCapability(true)).supported).toBe(true);
  });

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
    service = new PushSubscriptionService({
      now: () => new Date(NOW),
      transactions,
      config: () => CONFIG,
    });
  });

  afterAll(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
  });

  it("creates required unique/TTL indexes and never serializes private material", async () => {
    const [pushIndexes, preferenceIndexes] = await Promise.all([
      PushSubscription.collection.indexes(),
      NotificationPreference.collection.indexes(),
    ]);
    expect(pushIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_push_user_installation",
          unique: true,
        }),
        expect.objectContaining({ name: "uniq_push_endpoint_hash", unique: true }),
        expect.objectContaining({
          name: "ttl_push_subscription_stale_at",
          expireAfterSeconds: 0,
        }),
        expect.objectContaining({ name: "idx_push_vapid_key_user" }),
      ]),
    );
    expect(preferenceIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "uniq_notification_preference_user",
          unique: true,
        }),
      ]),
    );

    const userId = await insertUser("Owner");
    const response = await service.upsert({
      actor: { id: userId.toString(), role: "Participant" },
      subscription: input("private-endpoint"),
    });
    expect(response.installationId).toBe("ios-home-screen");
    expect(JSON.stringify(response)).not.toContain("private-endpoint");
    expect(JSON.stringify(response)).not.toContain("abc_DEF-123");
    expect(JSON.stringify(response)).not.toContain("auth_123");
    const stored = await PushSubscription.findOne({ userId }).lean().orFail();
    expect(stored.staleAt.toISOString()).toBe("2033-12-12T12:00:00.000Z");
    const audit = await AuditLog.findOne({ action: "push.subscription_upserted" })
      .lean()
      .orFail();
    expect(JSON.stringify(audit)).not.toContain("private-endpoint");
    expect(JSON.stringify(audit)).not.toContain("abc_DEF-123");
  });

  it("upserts per installation, rejects endpoint reuse, and physically unsubscribes", async () => {
    const first = await insertUser("First");
    const second = await insertUser("Second");
    const endpoint = input("same-endpoint");
    await service.upsert({
      actor: { id: first.toString(), role: "Participant" },
      subscription: endpoint,
    });
    await service.upsert({
      actor: { id: first.toString(), role: "Participant" },
      subscription: { ...endpoint, keys: { p256dh: "new_key", auth: "new_auth" } },
    });
    expect(await PushSubscription.countDocuments({ userId: first })).toBe(1);
    await expect(
      service.upsert({
        actor: { id: second.toString(), role: "Participant" },
        subscription: endpoint,
      }),
    ).rejects.toMatchObject({ code: "PUSH_SUBSCRIPTION_CONFLICT" });
    await service.unsubscribe({
      actor: { id: first.toString(), role: "Participant" },
      installationId: endpoint.installationId,
    });
    expect(await PushSubscription.countDocuments({ userId: first })).toBe(0);
  });

  it("persists global preferences and removes permanent/stale endpoints", async () => {
    const userId = await insertUser("Cleanup");
    const created = await service.upsert({
      actor: { id: userId.toString(), role: "Participant" },
      subscription: input("cleanup-endpoint"),
    });
    await expect(
      service.setPreferences({
        actor: { id: userId.toString(), role: "Participant" },
        changes: { pushEnabled: false },
      }),
    ).resolves.toMatchObject({ pushEnabled: false, emailEnabled: true });
    await service.invalidate(created.id, "PUSH_ENDPOINT_GONE");
    expect(await PushSubscription.findById(created.id)).toBeNull();

    const stale = await PushSubscription.create({
      userId,
      installationId: "stale-installation",
      endpoint: "https://fcm.googleapis.com/fcm/send/stale",
      endpointHash: "a".repeat(64),
      vapidKeyId: webPushPublicKeyId(CONFIG.publicKey),
      keys: { p256dh: "abc", auth: "def" },
      staleAt: new Date("2033-09-12T12:00:00.000Z"),
      createdAt: new Date("2033-06-01T12:00:00.000Z"),
      updatedAt: new Date("2033-06-01T12:00:00.000Z"),
    });
    expect(await service.cleanupStale()).toBe(1);
    expect(await PushSubscription.findById(stale._id)).toBeNull();
  });

  it("re-checks authoritative room mute and global preference before Web Push I/O", async () => {
    const senderId = await insertUser("Sender");
    const recipientId = await insertUser("Recipient");
    await service.upsert({
      actor: { id: recipientId.toString(), role: "Participant" },
      subscription: input("recipient-endpoint"),
    });
    const room = await Conversation.create({
      kind: "alumni_help",
      helpRequestId: new mongoose.Types.ObjectId(),
    });
    const member = await ConversationMember.create({
      conversationId: room._id,
      userId: recipientId,
      role: "provider",
      status: "active",
      joinedAt: NOW,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
      muted: true,
      mutedAt: NOW,
    });
    const messageId = new mongoose.Types.ObjectId();
    await ChatMessage.create({
      _id: messageId,
      conversationId: room._id,
      sequence: 1,
      senderId,
      senderSnapshot: { displayName: "Sender Member", avatar: null },
      clientMessageId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f4",
      kind: "text",
      content: "private integration message",
      safeLink: null,
      createdAt: NOW,
      purgeAt: new Date("2034-09-13T12:00:00.000Z"),
    });
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
    const delivery = new WebPushDeliveryService({
      now: () => new Date(NOW),
      config: () => CONFIG,
      subscriptions: service,
      transport: { sendNotification },
    });
    const request = {
      eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
      conversationId: room._id.toString(),
      messageId: messageId.toString(),
      recipientUserId: recipientId.toString(),
      sequence: 1,
      payload: {
        title: "@Cloud Chat Rooms",
        body: "You have a new chat message.",
        tag: `chat-${room._id.toString()}`,
        deepLink: `/#/dashboard/chat-rooms/${room._id.toString()}`,
        badgeCount: 1,
      },
    };
    await expect(delivery.deliverChatMessage(request)).resolves.toMatchObject({
      route: "muted",
    });
    expect(sendNotification).not.toHaveBeenCalled();

    await ConversationMember.updateOne(
      { _id: member._id },
      { $set: { muted: false, mutedAt: null } },
    );
    await expect(delivery.deliverChatMessage(request)).resolves.toMatchObject({
      route: "delivered",
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await service.setPreferences({
      actor: { id: recipientId.toString(), role: "Participant" },
      changes: { pushEnabled: false },
    });
    await expect(
      delivery.deliverChatMessage({
        ...request,
        eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f6",
      }),
    ).resolves.toMatchObject({ route: "push_disabled" });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(senderId).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it("does not send with a rotated VAPID identity until that installation re-subscribes", async () => {
    const userId = await insertUser("Rotation");
    await service.upsert({
      actor: { id: userId.toString(), role: "Participant" },
      subscription: input("rotation-endpoint"),
    });
    const rotatedConfig = Object.freeze({
      ...CONFIG,
      publicKey: `B${"c".repeat(86)}`,
    });
    const rotatedService = new PushSubscriptionService({
      now: () => new Date(NOW),
      transactions,
      config: () => rotatedConfig,
    });
    await expect(
      rotatedService.listDeliveryTargets(userId.toString()),
    ).resolves.toEqual([]);

    await rotatedService.upsert({
      actor: { id: userId.toString(), role: "Participant" },
      subscription: input("rotation-endpoint"),
    });
    await expect(
      rotatedService.listDeliveryTargets(userId.toString()),
    ).resolves.toHaveLength(1);
    const stored = await PushSubscription.findOne({ userId }).lean().orFail();
    expect(stored.vapidKeyId).toBe(webPushPublicKeyId(rotatedConfig.publicKey));
    expect(JSON.stringify(await rotatedService.list(userId.toString()))).not.toContain(
      stored.vapidKeyId,
    );
  });

  it("re-authorizes chat email fallback and applies Room mute, global preference, and retention", async () => {
    const recipientId = await insertUser("EmailRecipient");
    const helpRequestId = new mongoose.Types.ObjectId();
    const room = await Conversation.create({
      kind: "alumni_help",
      helpRequestId,
    });
    const member = await ConversationMember.create({
      conversationId: room._id,
      userId: recipientId,
      role: "requester",
      status: "active",
      joinedAt: NOW,
      accessWindows: [
        {
          visibleFromSequence: 1,
          visibleThroughSequence: null,
          openedAt: NOW,
          closedAt: null,
        },
      ],
      muted: false,
    });
    const messageId = new mongoose.Types.ObjectId();
    await ChatMessage.collection.insertOne({
      _id: messageId,
      conversationId: room._id,
      sequence: 1,
      senderId: new mongoose.Types.ObjectId(),
      purgeAt: new Date("2034-09-13T12:00:00.000Z"),
      createdAt: NOW,
      updatedAt: NOW,
    });
    const send = vi.fn().mockResolvedValue({ accepted: 1 });
    const emails = new ExternalNotificationEmailService({
      now: () => new Date(NOW),
      sender: { send },
      frontendBaseUrl: () => "https://erp.example.org/untrusted/base",
    });
    const input = {
      conversationId: room._id.toString(),
      messageId: messageId.toString(),
      recipientUserId: recipientId.toString(),
      sequence: 1,
    };

    await expect(emails.sendChatFallback(input)).resolves.toBe("sent");
    const options = send.mock.calls[0]?.[0];
    expect(options.text).toContain(
      `https://erp.example.org/#/dashboard/chat-rooms/${room._id.toString()}`,
    );
    expect(JSON.stringify(options)).not.toContain("untrusted/base");
    expect(JSON.stringify(options)).not.toContain("private chat text");

    await ConversationMember.updateOne(
      { _id: member._id },
      { $set: { muted: true, mutedAt: NOW } },
    );
    await expect(emails.sendChatFallback(input)).resolves.toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);

    await ConversationMember.updateOne(
      { _id: member._id },
      { $set: { muted: false, mutedAt: null } },
    );
    await NotificationPreference.create({
      userId: recipientId,
      pushEnabled: true,
      emailEnabled: false,
    });
    await expect(emails.sendChatFallback(input)).resolves.toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);

    await NotificationPreference.deleteOne({ userId: recipientId });
    await ChatMessage.collection.updateOne(
      { _id: messageId },
      { $set: { purgeAt: new Date(NOW.getTime() - 1) } },
    );
    await expect(emails.sendChatFallback(input)).resolves.toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
    await ChatMessage.collection.updateOne(
      { _id: messageId },
      { $set: { purgeAt: new Date("2034-09-13T12:00:00.000Z") } },
    );
    await Conversation.collection.updateOne(
      { _id: room._id },
      { $set: { purgeAt: new Date(NOW.getTime() - 1) } },
    );
    await expect(emails.sendChatFallback(input)).resolves.toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends generic Help fallback only to a retained active participant", async () => {
    const requesterId = await insertUser("HelpRequester");
    const providerId = await insertUser("HelpProvider");
    const requestId = new mongoose.Types.ObjectId();
    await AlumniHelpRequest.collection.insertOne({
      _id: requestId,
      requesterId,
      providerId,
      revision: 4,
      purgeAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const send = vi.fn().mockResolvedValue({ accepted: 1 });
    const emails = new ExternalNotificationEmailService({
      now: () => new Date(NOW),
      sender: { send },
      frontendBaseUrl: () => "https://erp.example.org",
    });
    const input = {
      requestId: requestId.toString(),
      recipientUserId: requesterId.toString(),
      minimumRevision: 4,
    };

    await expect(emails.sendHelpFallback(input)).resolves.toBe("sent");
    const options = send.mock.calls[0]?.[0];
    expect(options.text).toContain(
      `https://erp.example.org/#/dashboard/community/help-requests/${requestId.toString()}`,
    );
    expect(JSON.stringify(options)).not.toContain("outcome");
    expect(JSON.stringify(options)).not.toContain("Career Advice");

    await AlumniHelpRequest.collection.updateOne(
      { _id: requestId },
      { $set: { purgeAt: new Date(NOW.getTime() - 1) } },
    );
    await expect(emails.sendHelpFallback(input)).resolves.toBe("skipped");
    await AlumniHelpRequest.collection.updateOne(
      { _id: requestId },
      { $set: { purgeAt: null } },
    );
    await User.collection.updateOne(
      { _id: requesterId },
      { $set: { isActive: false } },
    );
    await expect(emails.sendHelpFallback(input)).resolves.toBe("skipped");
    await expect(
      emails.sendHelpFallback({ ...input, recipientUserId: new mongoose.Types.ObjectId().toString() }),
    ).resolves.toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-authorizes a retained Help participant immediately before Push I/O", async () => {
    const requesterId = await insertUser("PushHelpRequester");
    const providerId = await insertUser("PushHelpProvider");
    await service.upsert({
      actor: { id: requesterId.toString(), role: "Participant" },
      subscription: input("help-recipient-endpoint"),
    });
    const requestId = new mongoose.Types.ObjectId();
    await AlumniHelpRequest.collection.insertOne({
      _id: requestId,
      requesterId,
      providerId,
      revision: 5,
      purgeAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
    const delivery = new WebPushDeliveryService({
      now: () => new Date(NOW),
      config: () => CONFIG,
      subscriptions: service,
      transport: { sendNotification },
    });
    const deliveryInput = {
      eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e570",
      requestId: requestId.toString(),
      minimumRevision: 5,
      recipientUserId: requesterId.toString(),
      payload: {
        title: "@Cloud Alumni Help",
        body: "There is an update to your Alumni Help request.",
        tag: `help-${requestId.toString()}`,
        deepLink: `/#/dashboard/community/help-requests/${requestId.toString()}`,
        badgeCount: 2,
      },
    };
    await expect(
      delivery.deliverHelpNotification(deliveryInput),
    ).resolves.toMatchObject({ route: "delivered" });
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await AlumniHelpRequest.collection.updateOne(
      { _id: requestId },
      { $set: { purgeAt: new Date(NOW.getTime() - 1) } },
    );
    await expect(
      delivery.deliverHelpNotification({
        ...deliveryInput,
        eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e580",
      }),
    ).resolves.toMatchObject({ route: "no_subscription" });
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await AlumniHelpRequest.collection.updateOne(
      { _id: requestId },
      { $set: { purgeAt: null } },
    );
    await User.collection.updateOne(
      { _id: requesterId },
      { $set: { isVerified: false } },
    );
    await expect(
      delivery.deliverHelpNotification({
        ...deliveryInput,
        eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e590",
      }),
    ).resolves.toMatchObject({ route: "no_subscription" });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
