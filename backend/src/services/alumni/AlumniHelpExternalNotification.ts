import type { ClientSession } from "mongoose";
import AlumniHelpRequest from "../../models/AlumniHelpRequest";
import Message from "../../models/Message";
import User from "../../models/User";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import { readAlumniNetworkReleaseAvailable } from "../../config/alumniNetworkFeature";
import { featureControlService } from "../runtime/FeatureControlService";
import type {
  NotificationOutboxDeliveryContext,
  NotificationOutboxDeliveryHandler,
} from "../reliability/NotificationOutboxDeliveryRegistry";
import {
  notificationOutboxService,
  type ClaimedNotificationOutbox,
  type NotificationOutboxRecord,
  type NotificationOutboxService,
} from "../reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
  RetryableNotificationOutboxDeliveryError,
} from "../reliability/NotificationOutboxWorker";
import {
  externalNotificationRouter,
  type ExternalNotificationRouter,
} from "../push/ExternalNotificationRouter";
import type { AlumniHelpWorkflowEventType } from "./AlumniHelpWorkflowDeliveryHandler";

export const ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC =
  "alumni.help.external_notification" as const;
export const ALUMNI_HELP_EXTERNAL_NOTIFICATION_PAYLOAD_VERSION = 1 as const;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set<string>([
  "create",
  "request_information",
  "provide_information",
  "propose_alternative",
  "confirm_alternative",
  "reject_alternative",
  "accept",
  "decline",
  "withdraw",
  "start",
  "complete",
  "close",
  "outcome_submit",
  "outcome_resubmit",
  "outcome_confirm",
  "outcome_deny",
  "outcome_auto_confirm",
]);
const PAYLOAD_KEYS = new Set([
  "workflowEventId",
  "recipientUserId",
  "requestId",
  "requestRevision",
  "timelineEventId",
  "eventType",
  "occurredAt",
]);

export interface AlumniHelpExternalNotificationPayloadV1 {
  readonly workflowEventId: string;
  readonly recipientUserId: string;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly timelineEventId: string;
  readonly eventType: AlumniHelpWorkflowEventType;
  readonly occurredAt: string;
}

export interface EnqueueAlumniHelpExternalNotificationInput
  extends AlumniHelpExternalNotificationPayloadV1 {
  readonly session: ClientSession;
  readonly correlationId?: string;
}

interface ExternalHelpRuntimeReader {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

interface ExternalHelpRequestState {
  readonly id: string;
  readonly requesterId: string;
  readonly providerId: string;
  readonly revision: number;
}

interface ExternalHelpRecipientState {
  readonly id: string;
  readonly isActive: boolean;
  readonly isVerified: boolean;
}

interface ExternalHelpRecipientMongoState {
  readonly _id: unknown;
  readonly isActive?: boolean;
  readonly isVerified?: boolean;
}

interface AlumniHelpExternalNotificationDependencies {
  readonly releaseAvailable?: () => boolean;
  readonly runtimeReader?: ExternalHelpRuntimeReader;
  readonly loadRequest?: (
    requestId: string,
    signal: AbortSignal,
  ) => Promise<ExternalHelpRequestState | null>;
  readonly loadRecipient?: (
    userId: string,
    signal: AbortSignal,
  ) => Promise<ExternalHelpRecipientState | null>;
  readonly hasWorkflowMessage?: (
    workflowEventId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly router?: Pick<ExternalNotificationRouter, "deliverHelp">;
}

function permanent(code: string): never {
  throw new PermanentNotificationOutboxDeliveryError(code);
}

function canonicalObjectId(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return permanent("ALUMNI_HELP_EXTERNAL_EVENT_INVALID");
  }
  return value.toLowerCase();
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return permanent("ALUMNI_HELP_EXTERNAL_EVENT_INVALID");
  }
  return value.toLowerCase();
}

export function parseAlumniHelpExternalNotificationPayload(
  value: unknown,
): AlumniHelpExternalNotificationPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return permanent("ALUMNI_HELP_EXTERNAL_EVENT_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return permanent("ALUMNI_HELP_EXTERNAL_EVENT_INVALID");
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !PAYLOAD_KEYS.has(key)) ||
    typeof source.eventType !== "string" ||
    !EVENT_TYPES.has(source.eventType) ||
    !Number.isSafeInteger(source.requestRevision) ||
    Number(source.requestRevision) < 0 ||
    typeof source.occurredAt !== "string"
  ) {
    return permanent("ALUMNI_HELP_EXTERNAL_EVENT_INVALID");
  }
  const occurredAt = new Date(source.occurredAt);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== source.occurredAt
  ) {
    return permanent("ALUMNI_HELP_EXTERNAL_EVENT_INVALID");
  }
  return Object.freeze({
    workflowEventId: canonicalUuid(source.workflowEventId),
    recipientUserId: canonicalObjectId(source.recipientUserId),
    requestId: canonicalObjectId(source.requestId),
    requestRevision: Number(source.requestRevision),
    timelineEventId: canonicalObjectId(source.timelineEventId),
    eventType: source.eventType as AlumniHelpWorkflowEventType,
    occurredAt: source.occurredAt,
  });
}

export async function enqueueAlumniHelpExternalNotification(
  input: EnqueueAlumniHelpExternalNotificationInput,
  outbox: Pick<NotificationOutboxService, "enqueueInTransaction"> =
    notificationOutboxService,
): Promise<NotificationOutboxRecord> {
  const payload = parseAlumniHelpExternalNotificationPayload({
    workflowEventId: input.workflowEventId,
    recipientUserId: input.recipientUserId,
    requestId: input.requestId,
    requestRevision: input.requestRevision,
    timelineEventId: input.timelineEventId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
  });
  return outbox.enqueueInTransaction({
    topic: ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC,
    dedupeKey: `alumni-help-external:${payload.timelineEventId}:${payload.recipientUserId}`,
    payloadVersion: ALUMNI_HELP_EXTERNAL_NOTIFICATION_PAYLOAD_VERSION,
    payload,
    correlationId: input.correlationId,
    session: input.session,
  });
}

async function loadRequest(
  requestId: string,
  signal: AbortSignal,
): Promise<ExternalHelpRequestState | null> {
  const now = new Date();
  const request = await AlumniHelpRequest.findOne({
    _id: requestId,
    $or: [
      { purgeAt: null },
      { purgeAt: { $exists: false } },
      { purgeAt: { $gt: now } },
    ],
  })
    .select("requesterId providerId revision")
    .setOptions({ signal })
    .lean()
    .exec();
  return request
    ? Object.freeze({
        id: String(request._id),
        requesterId: String(request.requesterId),
        providerId: String(request.providerId),
        revision: request.revision,
      })
    : null;
}

async function loadRecipient(
  userId: string,
  signal: AbortSignal,
): Promise<ExternalHelpRecipientState | null> {
  const user = await User.findById(userId)
    .select("isActive isVerified")
    .setOptions({ signal })
    .lean<ExternalHelpRecipientMongoState>()
    .exec();
  return user
    ? Object.freeze({
        id: String(user._id),
        isActive: user.isActive === true,
        isVerified: user.isVerified === true,
      })
    : null;
}

async function hasWorkflowMessage(
  workflowEventId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const document = await Message.exists({
    "metadata.workflowDeliveryId": workflowEventId,
  }).setOptions({ signal });
  return document !== null;
}

export class AlumniHelpExternalNotificationDeliveryHandler
  implements NotificationOutboxDeliveryHandler
{
  readonly topic = ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC;
  readonly payloadVersion = ALUMNI_HELP_EXTERNAL_NOTIFICATION_PAYLOAD_VERSION;

  private readonly releaseAvailable: () => boolean;
  private readonly runtimeReader: ExternalHelpRuntimeReader;
  private readonly loadRequest: NonNullable<
    AlumniHelpExternalNotificationDependencies["loadRequest"]
  >;
  private readonly loadRecipient: NonNullable<
    AlumniHelpExternalNotificationDependencies["loadRecipient"]
  >;
  private readonly hasWorkflowMessage: NonNullable<
    AlumniHelpExternalNotificationDependencies["hasWorkflowMessage"]
  >;
  private readonly router: Pick<ExternalNotificationRouter, "deliverHelp">;

  constructor(dependencies: AlumniHelpExternalNotificationDependencies = {}) {
    this.releaseAvailable =
      dependencies.releaseAvailable ?? readAlumniNetworkReleaseAvailable;
    this.runtimeReader = dependencies.runtimeReader ?? featureControlService;
    this.loadRequest = dependencies.loadRequest ?? loadRequest;
    this.loadRecipient = dependencies.loadRecipient ?? loadRecipient;
    this.hasWorkflowMessage =
      dependencies.hasWorkflowMessage ?? hasWorkflowMessage;
    this.router = dependencies.router ?? externalNotificationRouter;
  }

  async canClaim(signal: AbortSignal): Promise<boolean> {
    return this.isRuntimeReadable(signal);
  }

  async assertCanDeliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    await this.resolve(event, context.signal);
  }

  async deliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    const payload = await this.resolve(event, context.signal);
    let delivery;
    try {
      delivery = await this.router.deliverHelp({
        eventId: event.eventId,
        requestId: payload.requestId,
        requestRevision: payload.requestRevision,
        recipientUserId: payload.recipientUserId,
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? error;
      }
      if (error instanceof RetryableNotificationOutboxDeliveryError) {
        throw error;
      }
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_HELP_EXTERNAL_DELIVERY_FAILED",
      );
    }
    if (delivery.route === "retry") {
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_HELP_EXTERNAL_PROVIDER_TRANSIENT",
      );
    }
  }

  private async isRuntimeReadable(signal: AbortSignal): Promise<boolean> {
    try {
      signal.throwIfAborted();
      if (!this.releaseAvailable()) return false;
      const config = await this.runtimeReader.getOperationalRuntimeConfig({ signal });
      signal.throwIfAborted();
      return config.data.alumniNetwork.readable === true;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return false;
    }
  }

  private async assertRuntimeReadable(signal: AbortSignal): Promise<void> {
    if (!(await this.isRuntimeReadable(signal))) {
      throw new DeferredNotificationOutboxDeliveryError(
        "ALUMNI_NETWORK_NOT_READABLE",
      );
    }
  }

  private async resolve(
    event: ClaimedNotificationOutbox,
    signal: AbortSignal,
  ): Promise<AlumniHelpExternalNotificationPayloadV1> {
    signal.throwIfAborted();
    const payload = parseAlumniHelpExternalNotificationPayload(event.payload);
    const [request, recipient, workflowMessageExists] = await Promise.all([
      this.loadRequest(payload.requestId, signal),
      this.loadRecipient(payload.recipientUserId, signal),
      this.hasWorkflowMessage(payload.workflowEventId, signal),
    ]);
    signal.throwIfAborted();
    if (
      !request ||
      request.id.toLowerCase() !== payload.requestId ||
      request.revision < payload.requestRevision
    ) {
      permanent("ALUMNI_HELP_EXTERNAL_EVENT_STALE");
    }
    if (
      !recipient ||
      recipient.id.toLowerCase() !== payload.recipientUserId ||
      !recipient.isActive ||
      !recipient.isVerified ||
      (payload.recipientUserId !== request.requesterId.toLowerCase() &&
        payload.recipientUserId !== request.providerId.toLowerCase())
    ) {
      permanent("ALUMNI_HELP_EXTERNAL_RECIPIENT_UNAVAILABLE");
    }
    // The workflow System Message owns the system unread count. Retry until it
    // exists so the badge calculated immediately afterward cannot be short by
    // one under concurrent outbox workers.
    if (!workflowMessageExists) {
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_HELP_WORKFLOW_MESSAGE_PENDING",
      );
    }
    return payload;
  }
}

export const alumniHelpExternalNotificationDeliveryHandler =
  new AlumniHelpExternalNotificationDeliveryHandler();
