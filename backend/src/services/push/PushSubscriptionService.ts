import { createHash } from "node:crypto";
import mongoose from "mongoose";
import type {
  NotificationPreferenceDTO,
  PushPublicConfigDTO,
  PushSubscriptionDTO,
  PushSubscriptionInput,
  PushSubscriptionListDTO,
} from "../../contracts/pushNotifications";
import { PUSH_SUBSCRIPTION_INACTIVITY_DAYS } from "../../contracts/pushNotifications";
import {
  readWebPushConfiguration,
  webPushPublicKeyId,
} from "../../config/webPush";
import NotificationPreference from "../../models/NotificationPreference";
import PushSubscription, {
  type IPushSubscription,
} from "../../models/PushSubscription";
import User from "../../models/User";
import { AuditLogService } from "../AuditLogService";
import {
  mongoTransactionService,
  type MongoTransactionService,
} from "../reliability/MongoTransactionService";
import {
  pushNotAvailable,
  pushSubscriptionConflict,
  pushSubscriptionNotFound,
} from "./PushNotificationErrors";

const INACTIVITY_MS =
  PUSH_SUBSCRIPTION_INACTIVITY_DAYS * 24 * 60 * 60 * 1_000;

export interface PushSettingsActor {
  readonly id: string;
  readonly role: string;
}

export interface PushSubscriptionDeliveryTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly deliveredEventIds: readonly string[];
}

interface PushSubscriptionServiceDependencies {
  readonly now?: () => Date;
  readonly transactions?: Pick<MongoTransactionService, "run">;
  readonly config?: typeof readWebPushConfiguration;
}

function objectId(value: string): mongoose.Types.ObjectId {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new Error("Invalid authenticated user id.");
  return new mongoose.Types.ObjectId(value);
}

function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000,
  );
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Push notification clock is invalid.");
  }
  return new Date(value);
}

function dto(document: IPushSubscription): PushSubscriptionDTO {
  return Object.freeze({
    id: document._id.toString(),
    installationId: document.installationId,
    status: "active" as const,
    createdAt: new Date(document.createdAt).toISOString(),
    updatedAt: new Date(document.updatedAt).toISOString(),
    lastSuccessfulPushAt: document.lastSuccessfulPushAt
      ? new Date(document.lastSuccessfulPushAt).toISOString()
      : null,
  });
}

export class PushSubscriptionService {
  private readonly now: () => Date;
  private readonly transactions: Pick<MongoTransactionService, "run">;
  private readonly config: typeof readWebPushConfiguration;

  constructor(dependencies: PushSubscriptionServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.config = dependencies.config ?? readWebPushConfiguration;
  }

  publicConfig(): PushPublicConfigDTO {
    const config = this.config();
    return Object.freeze({
      enabled: config.enabled,
      publicKey: config.enabled ? config.publicKey : null,
    });
  }

  async list(userId: string): Promise<PushSubscriptionListDTO> {
    const config = this.config();
    if (!config.enabled) {
      return Object.freeze({ subscriptions: Object.freeze([]) });
    }
    const now = validNow(this.now());
    const subscriptions = await PushSubscription.find({
      userId: objectId(userId),
      vapidKeyId: webPushPublicKeyId(config.publicKey),
      staleAt: { $gt: now },
      $or: [
        { expirationTime: null },
        { expirationTime: { $exists: false } },
        { expirationTime: { $gt: now } },
      ],
    })
      .sort({ updatedAt: -1, _id: -1 })
      .exec();
    return Object.freeze({ subscriptions: Object.freeze(subscriptions.map(dto)) });
  }

  async upsert(input: {
    readonly actor: PushSettingsActor;
    readonly subscription: PushSubscriptionInput;
    readonly correlationId?: string;
  }): Promise<PushSubscriptionDTO> {
    const config = this.config();
    if (!config.enabled) throw pushNotAvailable();
    const userId = objectId(input.actor.id);
    const now = validNow(this.now());
    const hash = endpointHash(input.subscription.endpoint);
    const vapidKeyId = webPushPublicKeyId(config.publicKey);
    const retentionAt = new Date(now.getTime() + INACTIVITY_MS);
    const staleAt =
      input.subscription.expirationTime !== null &&
      input.subscription.expirationTime < retentionAt.getTime()
        ? new Date(input.subscription.expirationTime)
        : retentionAt;
    try {
      return await this.transactions.run(async (session) => {
        const activeUser = await User.exists({
          _id: userId,
          isActive: true,
          isVerified: true,
        }).session(session);
        if (!activeUser) throw pushSubscriptionNotFound();
        let document = await PushSubscription.findOne({
          userId,
          installationId: input.subscription.installationId,
        }).session(session);
        if (document) {
          const endpointChanged = document.endpointHash !== hash;
          const vapidKeyChanged = document.vapidKeyId !== vapidKeyId;
          document.endpoint = input.subscription.endpoint;
          document.endpointHash = hash;
          document.vapidKeyId = vapidKeyId;
          document.expirationTime =
            input.subscription.expirationTime === null
              ? null
              : new Date(input.subscription.expirationTime);
          document.keys = { ...input.subscription.keys };
          // Re-posting the same failing endpoint must not extend its 90-day
          // no-success retention. A genuinely rotated endpoint starts a new
          // installation-delivery clock.
          if (endpointChanged || vapidKeyChanged) {
            document.staleAt = staleAt;
            document.lastSuccessfulPushAt = null;
            document.deliveredEventIds = [];
          }
          document.lastFailureCode = null;
          document.consecutiveFailureCount = 0;
          document.updatedAt = now;
          document.revision += 1;
          await document.save({ session, timestamps: false });
        } else {
          [document] = await PushSubscription.create(
            [
              {
                userId,
                installationId: input.subscription.installationId,
                endpoint: input.subscription.endpoint,
                endpointHash: hash,
                vapidKeyId,
                expirationTime:
                  input.subscription.expirationTime === null
                    ? null
                    : new Date(input.subscription.expirationTime),
                keys: input.subscription.keys,
                staleAt,
                createdAt: now,
                updatedAt: now,
              },
            ],
            { session },
          );
        }
        if (!document) throw new Error("Push subscription upsert failed.");
        await AuditLogService.recordRequiredInTransaction(
          {
            action: "push.subscription_upserted",
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: { model: "PushSubscription", id: document._id.toString() },
            correlationId: input.correlationId,
            details: { installationId: input.subscription.installationId },
          },
          session,
        );
        return dto(document);
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw pushSubscriptionConflict();
      throw error;
    }
  }

  async unsubscribe(input: {
    readonly actor: PushSettingsActor;
    readonly installationId: string;
    readonly correlationId?: string;
  }): Promise<void> {
    const userId = objectId(input.actor.id);
    await this.transactions.run(async (session) => {
      const document = await PushSubscription.findOneAndDelete({
        userId,
        installationId: input.installationId,
      }).session(session);
      if (!document) throw pushSubscriptionNotFound();
      await AuditLogService.recordRequiredInTransaction(
        {
          action: "push.subscription_removed",
          actor: { type: "user", id: input.actor.id, role: input.actor.role },
          source: "http",
          outcome: "success",
          target: { model: "PushSubscription", id: document._id.toString() },
          correlationId: input.correlationId,
          details: { installationId: input.installationId },
        },
        session,
      );
    });
  }

  async getPreferences(userId: string): Promise<NotificationPreferenceDTO> {
    const preference = await NotificationPreference.findOne({
      userId: objectId(userId),
      $or: [
        { purgeAt: null },
        { purgeAt: { $exists: false } },
        { purgeAt: { $gt: validNow(this.now()) } },
      ],
    }).lean();
    return Object.freeze({
      pushEnabled: preference?.pushEnabled ?? true,
      emailEnabled: preference?.emailEnabled ?? true,
      updatedAt: preference?.updatedAt
        ? new Date(preference.updatedAt).toISOString()
        : null,
    });
  }

  async setPreferences(input: {
    readonly actor: PushSettingsActor;
    readonly changes: {
      readonly pushEnabled?: boolean;
      readonly emailEnabled?: boolean;
    };
    readonly correlationId?: string;
  }): Promise<NotificationPreferenceDTO> {
    const now = validNow(this.now());
    const userId = objectId(input.actor.id);
    return this.transactions.run(async (session) => {
      const preference = await NotificationPreference.findOneAndUpdate(
        { userId },
        {
          $set: { ...input.changes, purgeAt: null, updatedAt: now },
          $setOnInsert: {
            createdAt: now,
          },
          $inc: { revision: 1 },
        },
        {
          upsert: true,
          new: true,
          session,
          runValidators: true,
          setDefaultsOnInsert: true,
          timestamps: false,
        },
      );
      if (!preference) throw new Error("Notification preference update failed.");
      await AuditLogService.recordRequiredInTransaction(
        {
          action: "notification.preference_updated",
          actor: { type: "user", id: input.actor.id, role: input.actor.role },
          source: "http",
          outcome: "success",
          target: { model: "NotificationPreference", id: preference._id.toString() },
          correlationId: input.correlationId,
          details: input.changes,
        },
        session,
      );
      return Object.freeze({
        pushEnabled: preference.pushEnabled,
        emailEnabled: preference.emailEnabled,
        updatedAt: new Date(preference.updatedAt).toISOString(),
      });
    });
  }

  async listDeliveryTargets(userId: string): Promise<readonly PushSubscriptionDeliveryTarget[]> {
    const config = this.config();
    if (!config.enabled) return Object.freeze([]);
    const now = validNow(this.now());
    const staleAt = new Date(now.getTime() - INACTIVITY_MS);
    const targetUserId = objectId(userId);
    const documents = await PushSubscription.aggregate<IPushSubscription>([
      {
        $match: {
          userId: targetUserId,
          vapidKeyId: webPushPublicKeyId(config.publicKey),
          staleAt: { $gt: now },
          $and: [
            {
              $or: [
                { expirationTime: null },
                { expirationTime: { $exists: false } },
                { expirationTime: { $gt: now } },
              ],
            },
            {
              $or: [
                { lastSuccessfulPushAt: { $gt: staleAt } },
                { lastSuccessfulPushAt: null, createdAt: { $gt: staleAt } },
                {
                  lastSuccessfulPushAt: { $exists: false },
                  createdAt: { $gt: staleAt },
                },
              ],
            },
          ],
        },
      },
      {
        $lookup: {
          from: User.collection.name,
          let: { ownerId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$ownerId"] },
                isActive: true,
                isVerified: true,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "activeOwner",
        },
      },
      { $match: { "activeOwner.0": { $exists: true } } },
      {
        $lookup: {
          from: NotificationPreference.collection.name,
          let: { ownerId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$ownerId"] },
                pushEnabled: false,
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "disabledPreference",
        },
      },
      { $match: { "disabledPreference.0": { $exists: false } } },
      { $project: { endpoint: 1, keys: 1, deliveredEventIds: 1 } },
    ]).exec();
    return Object.freeze(
      documents.map((document) =>
        Object.freeze({
          id: document._id.toString(),
          endpoint: document.endpoint,
          keys: Object.freeze({ ...document.keys }),
          deliveredEventIds: Object.freeze([...(document.deliveredEventIds ?? [])]),
        }),
      ),
    );
  }

  async recordSuccess(subscriptionId: string, eventId: string): Promise<void> {
    const now = validNow(this.now());
    const staleAt = new Date(now.getTime() + INACTIVITY_MS);
    await PushSubscription.updateOne(
      { _id: objectId(subscriptionId), staleAt: { $gt: now } },
      [
        {
          $set: {
            lastSuccessfulPushAt: now,
            lastAttemptAt: now,
            lastFailureCode: null,
            consecutiveFailureCount: 0,
            staleAt: {
              $cond: [
                {
                  $and: [
                    { $ne: [{ $ifNull: ["$expirationTime", null] }, null] },
                    { $lt: ["$expirationTime", staleAt] },
                  ],
                },
                "$expirationTime",
                staleAt,
              ],
            },
            updatedAt: now,
            revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
            deliveredEventIds: {
              $slice: [
                {
                  $setUnion: [
                    { $ifNull: ["$deliveredEventIds", []] },
                    [eventId],
                  ],
                },
                -50,
              ],
            },
          },
        },
      ],
      { runValidators: false },
    );
  }

  async recordTransientFailure(subscriptionId: string, code: string): Promise<void> {
    const now = validNow(this.now());
    await PushSubscription.updateOne(
      { _id: objectId(subscriptionId), staleAt: { $gt: now } },
      {
        $set: { lastAttemptAt: now, lastFailureCode: code, updatedAt: now },
        $inc: { consecutiveFailureCount: 1, revision: 1 },
      },
      { runValidators: false },
    );
  }

  async invalidate(subscriptionId: string, code: string): Promise<void> {
    // 404/410 endpoints are deleted immediately. Deliberately do not audit or
    // log endpoint material; the owning outbox event already has worker audit.
    void code;
    await PushSubscription.deleteOne({ _id: objectId(subscriptionId) });
  }

  async cleanupStale(limit = 500): Promise<number> {
    const now = validNow(this.now());
    const staleAt = new Date(now.getTime() - INACTIVITY_MS);
    const candidates = await PushSubscription.find({
      $or: [
        { staleAt: { $lte: now } },
        { expirationTime: { $lte: now } },
        { lastSuccessfulPushAt: { $lte: staleAt } },
        {
          lastSuccessfulPushAt: null,
          createdAt: { $lte: staleAt },
        },
        {
          lastSuccessfulPushAt: { $exists: false },
          createdAt: { $lte: staleAt },
        },
      ],
    })
      .select("_id")
      .sort({ updatedAt: 1, _id: 1 })
      .limit(Math.max(1, Math.min(2_000, Math.floor(limit))))
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
    if (candidates.length === 0) return 0;
    const result = await PushSubscription.deleteMany({
      _id: { $in: candidates.map(({ _id }) => _id) },
    });
    return result.deletedCount;
  }
}

export const pushSubscriptionService = new PushSubscriptionService();
