import type { ClientSession } from "mongoose";
import AlumniHelpRequest from "../../models/AlumniHelpRequest";
import Message, { type IMessage } from "../../models/Message";
import User from "../../models/User";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import { readAlumniNetworkReleaseAvailable } from "../../config/alumniNetworkFeature";
import { serializeSystemMessageForRecipient } from "../../serializers/systemMessageRealtimeSerializer";
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
  alumniHelpActionCountService,
  type AlumniHelpActionCountReader,
} from "./AlumniHelpActionCountService";

export const ALUMNI_HELP_WORKFLOW_TOPIC = "alumni.help.workflow" as const;
export const ALUMNI_HELP_WORKFLOW_PAYLOAD_VERSION = 1 as const;

export const ALUMNI_HELP_WORKFLOW_EVENT_TYPES = [
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
] as const;

export type AlumniHelpWorkflowEventType =
  (typeof ALUMNI_HELP_WORKFLOW_EVENT_TYPES)[number];

export type AlumniHelpWorkflowPresentation =
  | "system_message"
  | "counter_only";

export interface AlumniHelpWorkflowPayloadV1 {
  readonly recipientUserId: string;
  readonly requestId: string;
  readonly requestRevision: number;
  readonly timelineEventId: string;
  readonly eventType: AlumniHelpWorkflowEventType;
  readonly occurredAt: string;
  readonly presentation: AlumniHelpWorkflowPresentation;
  readonly outcomeSubmissionId?: string;
  readonly outcomeRevision?: number;
}

export interface EnqueueAlumniHelpWorkflowNotificationsInput {
  readonly requestId: string;
  readonly requestRevision: number;
  readonly timelineEventId: string;
  readonly eventType: AlumniHelpWorkflowEventType;
  /** Null represents the automatic-confirmation worker. */
  readonly actorUserId: string | null;
  readonly requesterId: string;
  readonly providerId: string;
  readonly outcomeSubmissionId?: string;
  readonly outcomeRevision?: number;
  readonly occurredAt: Date;
  readonly session: ClientSession;
  readonly correlationId?: string;
}

interface WorkflowRequestState {
  readonly id: string;
  readonly requesterId: string;
  readonly providerId: string;
  readonly revision: number;
}

interface WorkflowRecipientState {
  readonly id: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly isVerified: boolean;
}

interface WorkflowRecipientMongoState {
  readonly _id: unknown;
  readonly role: string;
  readonly isActive: boolean;
  readonly isVerified: boolean;
}

interface WorkflowRuntimeReader {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

interface WorkflowSocketPort {
  emitSystemMessageUpdate<T>(userId: string, event: string, data: T): void;
  emitUnreadCountUpdate(
    userId: string,
    counts: {
      bellNotifications: number;
      systemMessages: number;
      total: number;
    },
  ): void;
  emitAlumniHelpUpdate(
    userId: string,
    update: {
      requestId: string;
      requestRevision: number;
      helpActionRequiredCount: number;
    },
  ): void;
}

interface WorkflowUnreadCountReader {
  getUnreadCountsForUser(
    userId: string,
    userRole: string,
  ): Promise<{
    bellNotifications: number;
    systemMessages: number;
    total: number;
  }>;
}

export interface AlumniHelpWorkflowDeliveryDependencies {
  readonly releaseAvailable?: () => boolean;
  readonly runtimeReader?: WorkflowRuntimeReader;
  readonly loadRequest?: (
    requestId: string,
    signal: AbortSignal,
  ) => Promise<WorkflowRequestState | null>;
  readonly loadRecipient?: (
    userId: string,
    signal: AbortSignal,
  ) => Promise<WorkflowRecipientState | null>;
  readonly ensureMessage?: (
    eventId: string,
    payload: AlumniHelpWorkflowPayloadV1,
  ) => Promise<IMessage>;
  readonly actionCounts?: AlumniHelpActionCountReader;
  readonly unreadCounts?: WorkflowUnreadCountReader;
  readonly socket?: WorkflowSocketPort;
}

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE_SET = new Set<string>(ALUMNI_HELP_WORKFLOW_EVENT_TYPES);
const OUTCOME_EVENT_TYPES = new Set<AlumniHelpWorkflowEventType>([
  "outcome_submit",
  "outcome_resubmit",
  "outcome_confirm",
  "outcome_deny",
  "outcome_auto_confirm",
]);
const PAYLOAD_KEYS = new Set([
  "recipientUserId",
  "requestId",
  "requestRevision",
  "timelineEventId",
  "eventType",
  "occurredAt",
  "presentation",
  "outcomeSubmissionId",
  "outcomeRevision",
]);

function permanent(code: string): never {
  throw new PermanentNotificationOutboxDeliveryError(code);
}

function canonicalObjectId(value: unknown, code: string): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    permanent(code);
  }
  return value.toLowerCase();
}

function requireRevision(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) permanent(code);
  return Number(value);
}

function requireOccurredAt(value: unknown): string {
  if (typeof value !== "string") permanent("ALUMNI_HELP_EVENT_INVALID");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    permanent("ALUMNI_HELP_EVENT_INVALID");
  }
  return value;
}

export function parseAlumniHelpWorkflowPayload(
  value: unknown,
): AlumniHelpWorkflowPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    permanent("ALUMNI_HELP_EVENT_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    permanent("ALUMNI_HELP_EVENT_INVALID");
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some((key) => !PAYLOAD_KEYS.has(key))) {
    permanent("ALUMNI_HELP_EVENT_INVALID");
  }
  const eventType = source.eventType;
  const presentation = source.presentation;
  if (
    typeof eventType !== "string" ||
    !EVENT_TYPE_SET.has(eventType) ||
    (presentation !== "system_message" && presentation !== "counter_only")
  ) {
    permanent("ALUMNI_HELP_EVENT_INVALID");
  }

  const hasOutcomeId = Object.prototype.hasOwnProperty.call(
    source,
    "outcomeSubmissionId",
  );
  const hasOutcomeRevision = Object.prototype.hasOwnProperty.call(
    source,
    "outcomeRevision",
  );
  const isOutcomeEvent = OUTCOME_EVENT_TYPES.has(
    eventType as AlumniHelpWorkflowEventType,
  );
  if (
    hasOutcomeId !== hasOutcomeRevision ||
    isOutcomeEvent !== hasOutcomeId
  ) {
    permanent("ALUMNI_HELP_EVENT_INVALID");
  }

  return Object.freeze({
    recipientUserId: canonicalObjectId(
      source.recipientUserId,
      "ALUMNI_HELP_EVENT_INVALID",
    ),
    requestId: canonicalObjectId(
      source.requestId,
      "ALUMNI_HELP_EVENT_INVALID",
    ),
    requestRevision: requireRevision(
      source.requestRevision,
      "ALUMNI_HELP_EVENT_INVALID",
    ),
    timelineEventId: canonicalObjectId(
      source.timelineEventId,
      "ALUMNI_HELP_EVENT_INVALID",
    ),
    eventType: eventType as AlumniHelpWorkflowEventType,
    occurredAt: requireOccurredAt(source.occurredAt),
    presentation,
    ...(hasOutcomeId
      ? {
          outcomeSubmissionId: canonicalObjectId(
            source.outcomeSubmissionId,
            "ALUMNI_HELP_EVENT_INVALID",
          ),
          outcomeRevision: requireRevision(
            source.outcomeRevision,
            "ALUMNI_HELP_EVENT_INVALID",
            1,
          ),
        }
      : {}),
  });
}

function requireInputObjectId(value: string, name: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a valid ObjectId.`);
  }
  return value.toLowerCase();
}

function requireInputRevision(
  value: number,
  name: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function requireEventType(value: string): AlumniHelpWorkflowEventType {
  if (!EVENT_TYPE_SET.has(value)) {
    throw new TypeError("Alumni Help workflow event type is invalid.");
  }
  return value as AlumniHelpWorkflowEventType;
}

/** Enqueues one privacy-scoped delivery per participant in the domain transaction. */
export async function enqueueAlumniHelpWorkflowNotifications(
  input: EnqueueAlumniHelpWorkflowNotificationsInput,
  outbox: Pick<NotificationOutboxService, "enqueueInTransaction"> =
    notificationOutboxService,
): Promise<readonly NotificationOutboxRecord[]> {
  const requestId = requireInputObjectId(input.requestId, "requestId");
  const timelineEventId = requireInputObjectId(
    input.timelineEventId,
    "timelineEventId",
  );
  const requesterId = requireInputObjectId(input.requesterId, "requesterId");
  const providerId = requireInputObjectId(input.providerId, "providerId");
  if (requesterId === providerId) {
    throw new TypeError("Alumni Help participants must be distinct.");
  }
  const eventType = requireEventType(input.eventType);
  const requestRevision = requireInputRevision(
    input.requestRevision,
    "requestRevision",
  );
  if (
    !(input.occurredAt instanceof Date) ||
    Number.isNaN(input.occurredAt.getTime())
  ) {
    throw new TypeError("occurredAt must be a valid Date.");
  }

  const isAutomatic = eventType === "outcome_auto_confirm";
  const actorUserId = input.actorUserId
    ? requireInputObjectId(input.actorUserId, "actorUserId")
    : null;
  if (
    (isAutomatic && actorUserId !== null) ||
    (!isAutomatic &&
      actorUserId !== requesterId &&
      actorUserId !== providerId)
  ) {
    throw new TypeError("Alumni Help workflow actor is invalid.");
  }

  const isOutcomeEvent = OUTCOME_EVENT_TYPES.has(eventType);
  const hasOutcomeId = input.outcomeSubmissionId !== undefined;
  const hasOutcomeRevision = input.outcomeRevision !== undefined;
  if (
    hasOutcomeId !== hasOutcomeRevision ||
    isOutcomeEvent !== hasOutcomeId
  ) {
    throw new TypeError("Alumni Help outcome event metadata is invalid.");
  }
  const outcomeSubmissionId = hasOutcomeId
    ? requireInputObjectId(
        input.outcomeSubmissionId as string,
        "outcomeSubmissionId",
      )
    : undefined;
  const outcomeRevision = hasOutcomeRevision
    ? requireInputRevision(
        input.outcomeRevision as number,
        "outcomeRevision",
        1,
      )
    : undefined;

  const occurredAt = new Date(input.occurredAt).toISOString();
  const records: NotificationOutboxRecord[] = [];
  for (const recipientUserId of [requesterId, providerId]) {
    const presentation: AlumniHelpWorkflowPresentation = isAutomatic
      ? recipientUserId === requesterId
        ? "system_message"
        : "counter_only"
      : recipientUserId === actorUserId
        ? "counter_only"
        : "system_message";
    const payload: AlumniHelpWorkflowPayloadV1 = {
      recipientUserId,
      requestId,
      requestRevision,
      timelineEventId,
      eventType,
      occurredAt,
      presentation,
      ...(outcomeSubmissionId && outcomeRevision
        ? { outcomeSubmissionId, outcomeRevision }
        : {}),
    };
    records.push(
      await outbox.enqueueInTransaction({
        topic: ALUMNI_HELP_WORKFLOW_TOPIC,
        dedupeKey: `alumni-help:${timelineEventId}:${recipientUserId}`,
        payloadVersion: ALUMNI_HELP_WORKFLOW_PAYLOAD_VERSION,
        payload,
        correlationId: input.correlationId,
        session: input.session,
      }),
    );
  }
  return Object.freeze(records);
}

const MESSAGE_COPY: Readonly<
  Record<AlumniHelpWorkflowEventType, Readonly<{ title: string; content: string }>>
> = Object.freeze({
  create: Object.freeze({
    title: "New alumni help request",
    content: "A community member sent you an alumni help request.",
  }),
  request_information: Object.freeze({
    title: "More information requested",
    content: "The alumni helping you requested more information.",
  }),
  provide_information: Object.freeze({
    title: "Help request information received",
    content: "The requester provided the requested information.",
  }),
  propose_alternative: Object.freeze({
    title: "Alternative help proposed",
    content: "The alumni helping you proposed another type of help.",
  }),
  confirm_alternative: Object.freeze({
    title: "Alternative help accepted",
    content: "The requester accepted the proposed type of help.",
  }),
  reject_alternative: Object.freeze({
    title: "Alternative help declined",
    content: "The requester declined the proposed type of help.",
  }),
  accept: Object.freeze({
    title: "Alumni help request accepted",
    content: "Your alumni help request was accepted.",
  }),
  decline: Object.freeze({
    title: "Alumni help request declined",
    content: "Your alumni help request was declined.",
  }),
  withdraw: Object.freeze({
    title: "Alumni help request withdrawn",
    content: "The requester withdrew the alumni help request.",
  }),
  start: Object.freeze({
    title: "Alumni help started",
    content: "Work on your alumni help request has started.",
  }),
  complete: Object.freeze({
    title: "Alumni help completed",
    content: "The alumni helping you marked the request complete.",
  }),
  close: Object.freeze({
    title: "Alumni help request closed",
    content: "The alumni help request was closed.",
  }),
  outcome_submit: Object.freeze({
    title: "Help outcome confirmation needed",
    content: "The requester submitted an outcome for your confirmation.",
  }),
  outcome_resubmit: Object.freeze({
    title: "Help outcome resubmitted",
    content: "The requester resubmitted an outcome for your confirmation.",
  }),
  outcome_confirm: Object.freeze({
    title: "Help outcome confirmed",
    content: "The alumni helping you confirmed the submitted outcome.",
  }),
  outcome_deny: Object.freeze({
    title: "Help outcome needs revision",
    content: "The alumni helping you denied the submitted outcome. Please review it.",
  }),
  outcome_auto_confirm: Object.freeze({
    title: "Help outcome automatically confirmed",
    content: "The confirmation window ended, so the submitted outcome was confirmed.",
  }),
});

export function buildRetainedWorkflowRequestFilter(
  requestId: string,
  now: Date = new Date(),
): Readonly<Record<string, unknown>> {
  const canonicalRequestId = requireInputObjectId(requestId, "requestId");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("Workflow request retention timestamp is invalid.");
  }
  const cutoff = new Date(now);
  return Object.freeze({
    _id: canonicalRequestId,
    $or: Object.freeze([
      Object.freeze({ purgeAt: Object.freeze({ $exists: false }) }),
      Object.freeze({ purgeAt: null }),
      Object.freeze({ purgeAt: Object.freeze({ $gt: cutoff }) }),
    ]),
  });
}

async function loadRequestFromMongo(
  requestId: string,
  signal: AbortSignal,
): Promise<WorkflowRequestState | null> {
  // MongoDB TTL deletion is asynchronous. Enforce the product retention
  // boundary in the read predicate so a delayed outbox delivery cannot revive
  // an already-expired request or notify either former participant about it.
  const document = await AlumniHelpRequest.findOne(
    buildRetainedWorkflowRequestFilter(requestId),
  )
    .select({ requesterId: 1, providerId: 1, revision: 1 })
    .setOptions({ signal })
    .lean()
    .exec();
  if (!document) return null;
  return Object.freeze({
    id: String(document._id),
    requesterId: String(document.requesterId),
    providerId: String(document.providerId),
    revision: document.revision,
  });
}

async function loadRecipientFromMongo(
  userId: string,
  signal: AbortSignal,
): Promise<WorkflowRecipientState | null> {
  const document = await User.findById(userId)
    .select({ role: 1, isActive: 1, isVerified: 1 })
    .setOptions({ signal })
    .lean<WorkflowRecipientMongoState>()
    .exec();
  if (!document) return null;
  return Object.freeze({
    id: String(document._id),
    role: document.role,
    isActive: document.isActive === true,
    isVerified: document.isVerified === true,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000,
  );
}

async function ensureWorkflowMessage(
  eventId: string,
  payload: AlumniHelpWorkflowPayloadV1,
): Promise<IMessage> {
  const copy = MESSAGE_COPY[payload.eventType];
  if (!UUID_PATTERN.test(eventId)) permanent("ALUMNI_HELP_EVENT_INVALID");
  const workflowDeliveryId = eventId.toLowerCase();
  const userState = {
    isReadInSystem: false,
    isReadInBell: false,
    isRemovedFromBell: false,
    isDeletedFromSystem: false,
  };
  try {
    const message = await Message.findOneAndUpdate(
      { "metadata.workflowDeliveryId": workflowDeliveryId },
      {
        $setOnInsert: {
          title: copy.title,
          content: copy.content,
          type: "update",
          priority: "medium",
          hideCreator: true,
          creator: {
            id: "system",
            firstName: "System",
            lastName: "Administrator",
            username: "system",
            avatar: "/default-avatar-male.jpg",
            gender: "male",
            authLevel: "Super Admin",
            roleInAtCloud: "System",
          },
          isActive: true,
          targetUserId: payload.recipientUserId,
          userStates: { [payload.recipientUserId]: userState },
          metadata: {
            workflowDeliveryId,
            kind: "alumni_help_workflow",
            requestId: payload.requestId,
          },
          createdAt: new Date(payload.occurredAt),
          updatedAt: new Date(payload.occurredAt),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).exec();
    if (!message) throw new Error("Workflow System Message was not persisted.");
    return message;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await Message.findOne({
      "metadata.workflowDeliveryId": workflowDeliveryId,
    }).exec();
    if (!existing) throw error;
    return existing;
  }
}

const DEFAULT_UNREAD_COUNTS = Message as unknown as WorkflowUnreadCountReader;

export class AlumniHelpWorkflowDeliveryHandler
  implements NotificationOutboxDeliveryHandler
{
  readonly topic = ALUMNI_HELP_WORKFLOW_TOPIC;
  readonly payloadVersion = ALUMNI_HELP_WORKFLOW_PAYLOAD_VERSION;

  private readonly releaseAvailable: () => boolean;
  private readonly runtimeReader: WorkflowRuntimeReader;
  private readonly loadRequest: NonNullable<
    AlumniHelpWorkflowDeliveryDependencies["loadRequest"]
  >;
  private readonly loadRecipient: NonNullable<
    AlumniHelpWorkflowDeliveryDependencies["loadRecipient"]
  >;
  private readonly ensureMessage: NonNullable<
    AlumniHelpWorkflowDeliveryDependencies["ensureMessage"]
  >;
  private readonly actionCounts: AlumniHelpActionCountReader;
  private readonly unreadCounts: WorkflowUnreadCountReader;
  private readonly socket?: WorkflowSocketPort;

  constructor(dependencies: AlumniHelpWorkflowDeliveryDependencies = {}) {
    this.releaseAvailable =
      dependencies.releaseAvailable ?? readAlumniNetworkReleaseAvailable;
    this.runtimeReader = dependencies.runtimeReader ?? featureControlService;
    this.loadRequest = dependencies.loadRequest ?? loadRequestFromMongo;
    this.loadRecipient = dependencies.loadRecipient ?? loadRecipientFromMongo;
    this.ensureMessage = dependencies.ensureMessage ?? ensureWorkflowMessage;
    this.actionCounts = dependencies.actionCounts ?? alumniHelpActionCountService;
    this.unreadCounts = dependencies.unreadCounts ?? DEFAULT_UNREAD_COUNTS;
    this.socket = dependencies.socket;
  }

  async canClaim(signal: AbortSignal): Promise<boolean> {
    return this.isRuntimeReadable(signal);
  }

  async assertCanDeliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    await this.resolveDelivery(event, context.signal);
  }

  async deliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeReadable(context.signal);
    const delivery = await this.resolveDelivery(event, context.signal);
    context.signal.throwIfAborted();

    let message: IMessage | null = null;
    if (delivery.payload.presentation === "system_message") {
      try {
        message = await this.ensureMessage(event.eventId, delivery.payload);
      } catch (error) {
        if (error instanceof PermanentNotificationOutboxDeliveryError) {
          throw error;
        }
        throw new RetryableNotificationOutboxDeliveryError(
          "ALUMNI_HELP_MESSAGE_PERSIST_FAILED",
        );
      }
    }

    context.signal.throwIfAborted();
    let unreadCounts: Awaited<
      ReturnType<WorkflowUnreadCountReader["getUnreadCountsForUser"]>
    >;
    let helpActionRequiredCount: number;
    try {
      [unreadCounts, helpActionRequiredCount] = await Promise.all([
        this.unreadCounts.getUnreadCountsForUser(
          delivery.recipient.id,
          delivery.recipient.role,
        ),
        this.actionCounts.countForUser(
          delivery.recipient.id,
          context.signal,
        ),
      ]);
    } catch {
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_HELP_COUNTER_READ_FAILED",
      );
    }
    context.signal.throwIfAborted();

    const socket = await this.resolveSocket();
    context.signal.throwIfAborted();

    if (message) {
      socket.emitSystemMessageUpdate(
        delivery.recipient.id,
        "message_created",
        {
          message: serializeSystemMessageForRecipient(
            message,
            delivery.recipient.id,
          ),
        },
      );
    }
    socket.emitUnreadCountUpdate(delivery.recipient.id, unreadCounts);
    socket.emitAlumniHelpUpdate(delivery.recipient.id, {
      requestId: delivery.request.id,
      requestRevision: delivery.request.revision,
      helpActionRequiredCount,
    });
  }

  private async resolveSocket(): Promise<WorkflowSocketPort> {
    if (this.socket) return this.socket;
    // Keep the process-wide SocketService singleton lazy: merely registering
    // this outbox handler must not initialize realtime infrastructure.
    const { socketService } = await import("../infrastructure/SocketService");
    return socketService;
  }

  private async isRuntimeReadable(signal: AbortSignal): Promise<boolean> {
    try {
      signal.throwIfAborted();
      if (!this.releaseAvailable()) return false;
      const config = await this.runtimeReader.getOperationalRuntimeConfig({
        signal,
      });
      signal.throwIfAborted();
      return config.data.alumniNetwork.readable === true;
    } catch {
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

  private async resolveDelivery(
    event: ClaimedNotificationOutbox,
    signal: AbortSignal,
  ): Promise<{
    payload: AlumniHelpWorkflowPayloadV1;
    request: WorkflowRequestState;
    recipient: WorkflowRecipientState;
  }> {
    signal.throwIfAborted();
    const payload = parseAlumniHelpWorkflowPayload(event.payload);
    const [request, recipient] = await Promise.all([
      this.loadRequest(payload.requestId, signal),
      this.loadRecipient(payload.recipientUserId, signal),
    ]);
    signal.throwIfAborted();
    if (
      !request ||
      request.id.toLowerCase() !== payload.requestId ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < payload.requestRevision
    ) {
      permanent("ALUMNI_HELP_EVENT_STALE");
    }
    if (
      !recipient ||
      recipient.id.toLowerCase() !== payload.recipientUserId ||
      typeof recipient.role !== "string" ||
      recipient.role.length === 0 ||
      !recipient.isActive ||
      !recipient.isVerified ||
      (payload.recipientUserId !== request.requesterId.toLowerCase() &&
        payload.recipientUserId !== request.providerId.toLowerCase())
    ) {
      permanent("ALUMNI_HELP_RECIPIENT_UNAVAILABLE");
    }
    return Object.freeze({ payload, request, recipient });
  }
}

export const alumniHelpWorkflowDeliveryHandler =
  new AlumniHelpWorkflowDeliveryHandler();
