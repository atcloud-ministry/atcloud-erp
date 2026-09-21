import { createHash } from "node:crypto";
import mongoose from "mongoose";
import webPush from "web-push";
import { PUSH_SUBSCRIPTION_INACTIVITY_DAYS } from "../../contracts/pushNotifications";
import {
  readWebPushConfiguration,
  webPushPublicKeyId,
} from "../../config/webPush";
import AlumniHelpRequest from "../../models/AlumniHelpRequest";
import ChatMessage from "../../models/ChatMessage";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";
import NotificationPreference from "../../models/NotificationPreference";
import PushSubscription from "../../models/PushSubscription";
import User from "../../models/User";
import {
  pushSubscriptionService,
  type PushSubscriptionDeliveryTarget,
  type PushSubscriptionService,
} from "./PushSubscriptionService";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const WEB_PUSH_TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const WEB_PUSH_TRANSPORT_TIMEOUT_MS = 10_000;
const INACTIVITY_MS =
  PUSH_SUBSCRIPTION_INACTIVITY_DAYS * 24 * 60 * 60 * 1_000;

export interface WebPushNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly deepLink: string;
  readonly badgeCount: number;
}

export type PushRecipientRoute =
  | "delivered"
  | "muted"
  | "recipient_unavailable"
  | "push_disabled"
  | "no_subscription"
  | "permanent_failure"
  | "transient_failure";

export interface PushRecipientDeliveryResult {
  readonly route: PushRecipientRoute;
  readonly attempted: number;
  readonly succeeded: number;
  readonly permanentFailures: number;
  readonly transientFailures: number;
}

export interface WebPushTransport {
  sendNotification(
    subscription: webPush.PushSubscription,
    payload: string,
    options: webPush.RequestOptions,
  ): Promise<webPush.SendResult>;
}

interface WebPushDeliveryServiceDependencies {
  readonly now?: () => Date;
  readonly config?: typeof readWebPushConfiguration;
  readonly subscriptions?: Pick<
    PushSubscriptionService,
    | "getPreferences"
    | "listDeliveryTargets"
    | "recordSuccess"
    | "recordTransientFailure"
    | "invalidate"
  >;
  readonly transport?: WebPushTransport;
}

interface AuthorizedChatTargetRow {
  _id: mongoose.Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deliveredEventIds?: string[];
  memberMuted?: boolean;
  preferenceDisabled?: boolean;
}

function objectId(value: string): mongoose.Types.ObjectId | null {
  return OBJECT_ID_PATTERN.test(value) ? new mongoose.Types.ObjectId(value) : null;
}

function boundedPayload(payload: WebPushNotificationPayload): string {
  const fields = [payload.title, payload.body, payload.tag, payload.deepLink];
  if (
    fields.some((field) => typeof field !== "string" || field.length === 0) ||
    payload.title.length > 120 ||
    payload.body.length > 240 ||
    payload.tag.length > 160 ||
    payload.deepLink.length > 2_048 ||
    !Number.isSafeInteger(payload.badgeCount) ||
    payload.badgeCount < 0
  ) {
    throw new Error("Invalid Web Push notification payload.");
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > 3_072) {
    throw new Error("Web Push notification payload is too large.");
  }
  return serialized;
}

function statusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function isTransientStatus(code: number | null): boolean {
  return (
    code === null ||
    code === 408 ||
    code === 425 ||
    code === 429 ||
    code >= 500
  );
}

function webPushTopic(tag: string): string {
  if (WEB_PUSH_TOPIC_PATTERN.test(tag)) return tag;
  const digest = createHash("sha256").update(tag, "utf8").digest("base64url");
  return `atc-${digest.slice(0, 28)}`;
}

function result(
  route: PushRecipientRoute,
  attempted = 0,
  succeeded = 0,
  permanentFailures = 0,
  transientFailures = 0,
): PushRecipientDeliveryResult {
  return Object.freeze({ route, attempted, succeeded, permanentFailures, transientFailures });
}

/**
 * Owns the only conversion from private database subscription material to the
 * web-push library. Errors and return values contain counts/codes only.
 */
export class WebPushDeliveryService {
  private readonly now: () => Date;
  private readonly config: typeof readWebPushConfiguration;
  private readonly subscriptions: Pick<
    PushSubscriptionService,
    | "getPreferences"
    | "listDeliveryTargets"
    | "recordSuccess"
    | "recordTransientFailure"
    | "invalidate"
  >;
  private readonly transport: WebPushTransport;

  constructor(dependencies: WebPushDeliveryServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.config = dependencies.config ?? readWebPushConfiguration;
    this.subscriptions = dependencies.subscriptions ?? pushSubscriptionService;
    this.transport = dependencies.transport ?? webPush;
  }

  /**
   * Performs a final aggregate authorization check over account, preference,
   * membership, access window, room status/mute, retention, and installation.
   */
  async deliverChatMessage(input: {
    readonly eventId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly recipientUserId: string;
    readonly sequence: number;
    readonly payload: WebPushNotificationPayload;
    readonly authorizeRecipient: () => Promise<boolean>;
    readonly signal?: AbortSignal;
  }): Promise<PushRecipientDeliveryResult> {
    const config = this.config();
    if (!config.enabled) return result("push_disabled");
    const userId = objectId(input.recipientUserId);
    const conversationId = objectId(input.conversationId);
    const messageId = objectId(input.messageId);
    if (
      !userId ||
      !conversationId ||
      !messageId ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1
    ) {
      return result("no_subscription");
    }
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Web Push delivery clock is invalid.");
    }
    const staleAt = new Date(now.getTime() - INACTIVITY_MS);
    const rows = await PushSubscription.aggregate<AuthorizedChatTargetRow>([
      {
        $match: {
          userId,
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
          let: { targetUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$targetUserId"] },
                isActive: true,
                isVerified: true,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedUser",
        },
      },
      { $match: { "authorizedUser.0": { $exists: true } } },
      {
        $lookup: {
          from: NotificationPreference.collection.name,
          let: { targetUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$targetUserId"] },
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
      {
        $lookup: {
          from: ConversationMember.collection.name,
          let: { targetUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$targetUserId"] },
                conversationId,
                status: "active",
                muted: false,
                accessWindows: {
                  $elemMatch: {
                    visibleFromSequence: { $lte: input.sequence },
                    $or: [
                      { visibleThroughSequence: null },
                      { visibleThroughSequence: { $gte: input.sequence } },
                    ],
                  },
                },
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedMember",
        },
      },
      { $match: { "authorizedMember.0": { $exists: true } } },
      {
        $lookup: {
          from: Conversation.collection.name,
          pipeline: [
            {
              $match: {
                _id: conversationId,
                status: "current",
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedConversation",
        },
      },
      { $match: { "authorizedConversation.0": { $exists: true } } },
      {
        $lookup: {
          from: ChatMessage.collection.name,
          pipeline: [
            {
              $match: {
                _id: messageId,
                conversationId,
                sequence: input.sequence,
                purgeAt: { $gt: now },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "retainedMessage",
        },
      },
      { $match: { "retainedMessage.0": { $exists: true } } },
      { $project: { endpoint: 1, keys: 1, deliveredEventIds: 1 } },
    ]).exec();
    input.signal?.throwIfAborted();
    if (rows.length === 0) {
      return this.classifyNoChatTargets(userId, conversationId, input.sequence, now);
    }
    return this.deliverTargets(
      rows.map((row) => ({
        id: row._id.toString(),
        endpoint: row.endpoint,
        keys: row.keys,
        deliveredEventIds: row.deliveredEventIds ?? [],
      })),
      input.eventId,
      input.payload,
      config,
      input.signal,
      input.authorizeRecipient,
    );
  }

  /** Recipient-scoped sender used by Help/System routing in M5-04. */
  async deliverUserNotification(input: {
    readonly eventId: string;
    readonly recipientUserId: string;
    readonly payload: WebPushNotificationPayload;
    readonly signal?: AbortSignal;
  }): Promise<PushRecipientDeliveryResult> {
    const config = this.config();
    if (!config.enabled) return result("push_disabled");
    const preferences = await this.subscriptions.getPreferences(
      input.recipientUserId,
    );
    input.signal?.throwIfAborted();
    if (!preferences.pushEnabled) return result("push_disabled");
    const targets = await this.subscriptions.listDeliveryTargets(
      input.recipientUserId,
    );
    input.signal?.throwIfAborted();
    if (targets.length === 0) return result("no_subscription");
    return this.deliverTargets(
      targets,
      input.eventId,
      input.payload,
      config,
      input.signal,
    );
  }

  /** Final authorization for a recipient-scoped Alumni Help notification. */
  async deliverHelpNotification(input: {
    readonly eventId: string;
    readonly requestId: string;
    readonly minimumRevision: number;
    readonly recipientUserId: string;
    readonly payload: WebPushNotificationPayload;
    readonly signal?: AbortSignal;
  }): Promise<PushRecipientDeliveryResult> {
    const config = this.config();
    if (!config.enabled) return result("push_disabled");
    const userId = objectId(input.recipientUserId);
    const requestId = objectId(input.requestId);
    if (
      !userId ||
      !requestId ||
      !Number.isSafeInteger(input.minimumRevision) ||
      input.minimumRevision < 0
    ) {
      return result("no_subscription");
    }
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Web Push delivery clock is invalid.");
    }
    const staleAt = new Date(now.getTime() - INACTIVITY_MS);
    const rows = await PushSubscription.aggregate<AuthorizedChatTargetRow>([
      {
        $match: {
          userId,
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
          let: { targetUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$targetUserId"] },
                isActive: true,
                isVerified: true,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedUser",
        },
      },
      { $match: { "authorizedUser.0": { $exists: true } } },
      {
        $lookup: {
          from: NotificationPreference.collection.name,
          let: { targetUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$targetUserId"] },
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
      {
        $lookup: {
          from: AlumniHelpRequest.collection.name,
          let: { targetUserId: "$userId" },
          pipeline: [
            {
              $match: {
                _id: requestId,
                revision: { $gte: input.minimumRevision },
                $expr: {
                  $or: [
                    { $eq: ["$requesterId", "$$targetUserId"] },
                    { $eq: ["$providerId", "$$targetUserId"] },
                  ],
                },
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedHelpRequest",
        },
      },
      { $match: { "authorizedHelpRequest.0": { $exists: true } } },
      { $project: { endpoint: 1, keys: 1, deliveredEventIds: 1 } },
    ]).exec();
    input.signal?.throwIfAborted();
    if (rows.length === 0) {
      const disabled = await NotificationPreference.exists({
        userId,
        pushEnabled: false,
        $or: [
          { purgeAt: null },
          { purgeAt: { $exists: false } },
          { purgeAt: { $gt: now } },
        ],
      });
      return result(disabled ? "push_disabled" : "no_subscription");
    }
    return this.deliverTargets(
      rows.map((row) => ({
        id: row._id.toString(),
        endpoint: row.endpoint,
        keys: row.keys,
        deliveredEventIds: row.deliveredEventIds ?? [],
      })),
      input.eventId,
      input.payload,
      config,
      input.signal,
    );
  }

  private async classifyNoChatTargets(
    userId: mongoose.Types.ObjectId,
    conversationId: mongoose.Types.ObjectId,
    sequence: number,
    now: Date,
  ): Promise<PushRecipientDeliveryResult> {
    const member = await ConversationMember.findOne({
      userId,
      conversationId,
      status: "active",
      accessWindows: {
        $elemMatch: {
          visibleFromSequence: { $lte: sequence },
          $or: [
            { visibleThroughSequence: null },
            { visibleThroughSequence: { $gte: sequence } },
          ],
        },
      },
      $or: [{ purgeAt: null }, { purgeAt: { $exists: false } }, { purgeAt: { $gt: now } }],
    }).select("muted").lean<{ muted?: boolean }>();
    if (member?.muted) return result("muted");
    const disabled = await NotificationPreference.exists({
      userId,
      pushEnabled: false,
      $or: [{ purgeAt: null }, { purgeAt: { $exists: false } }, { purgeAt: { $gt: now } }],
    });
    return result(disabled ? "push_disabled" : "no_subscription");
  }

  private async deliverTargets(
    targets: readonly PushSubscriptionDeliveryTarget[],
    eventId: string,
    payload: WebPushNotificationPayload,
    config: Extract<ReturnType<typeof readWebPushConfiguration>, { enabled: true }>,
    signal?: AbortSignal,
    authorizeRecipient?: () => Promise<boolean>,
  ): Promise<PushRecipientDeliveryResult> {
    const serializedPayload = boundedPayload(payload);
    const topic = webPushTopic(payload.tag);
    let attempted = 0;
    let succeeded = 0;
    let permanentFailures = 0;
    let transientFailures = 0;
    for (const target of targets) {
      signal?.throwIfAborted();
      if (target.deliveredEventIds.includes(eventId)) {
        succeeded += 1;
        continue;
      }
      if (authorizeRecipient) {
        // This is deliberately the last asynchronous authorization read before
        // each provider request. Idempotent replay targets that require no
        // request skip the read, but a revocation after one installation was
        // notified still prevents delivery to later installations.
        const recipientAuthorized = await authorizeRecipient();
        signal?.throwIfAborted();
        if (!recipientAuthorized) {
          return result(
            "recipient_unavailable",
            attempted,
            succeeded,
            permanentFailures,
            transientFailures,
          );
        }
      }
      attempted += 1;
      try {
        // web-push uses one direct HTTPS request and does not follow arbitrary
        // redirects. Endpoints have already passed the vendor-host allowlist.
        await this.transport.sendNotification(
          { endpoint: target.endpoint, keys: target.keys },
          serializedPayload,
          {
            TTL: 60 * 60,
            urgency: "normal",
            topic,
            timeout: WEB_PUSH_TRANSPORT_TIMEOUT_MS,
            vapidDetails: {
              subject: config.subject,
              publicKey: config.publicKey,
              privateKey: config.privateKey,
            },
          },
        );
        await this.subscriptions.recordSuccess(target.id, eventId);
        succeeded += 1;
      } catch (error) {
        const code = statusCode(error);
        if (code === 404 || code === 410) {
          await this.subscriptions.invalidate(target.id, "PUSH_ENDPOINT_GONE");
          permanentFailures += 1;
        } else if (isTransientStatus(code)) {
          await this.subscriptions.recordTransientFailure(
            target.id,
            code !== null
              ? "PUSH_PROVIDER_TRANSIENT"
              : "PUSH_DELIVERY_FAILED",
          );
          transientFailures += 1;
        } else {
          permanentFailures += 1;
        }
      }
    }
    const route: PushRecipientRoute =
      transientFailures > 0
        ? "transient_failure"
        : succeeded > 0
          ? "delivered"
          : permanentFailures > 0
            ? "permanent_failure"
            : "no_subscription";
    return result(route, attempted, succeeded, permanentFailures, transientFailures);
  }
}

export const webPushDeliveryService = new WebPushDeliveryService();
