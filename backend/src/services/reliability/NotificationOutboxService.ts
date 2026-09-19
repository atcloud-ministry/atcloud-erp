import { randomUUID } from "crypto";
import type { ClientSession } from "mongoose";
import NotificationOutbox, {
  notificationOutboxTerminalPurgeAt,
  type INotificationOutbox,
  type NotificationOutboxStatus,
} from "../../models/NotificationOutbox";
import {
  hashOutboxDedupeKey,
  hashOutboxError,
  hashOutboxPayload,
  normalizeOutboxPayload,
  type OutboxJsonObject,
} from "./OutboxPayload";
import {
  NotificationOutboxMetrics,
  notificationOutboxMetrics,
} from "./NotificationOutboxMetrics";
import { awaitWithAbort } from "../../utils/abortablePromise";

const TOPIC_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SupportedOutboxDelivery {
  readonly topic: string;
  readonly payloadVersion: number;
}

export interface EnqueueNotificationOutboxInput {
  readonly topic: string;
  readonly dedupeKey: string;
  readonly payloadVersion: number;
  readonly payload: unknown;
  readonly maxAttempts?: number;
  readonly nextAttemptAt?: Date;
  readonly correlationId?: string;
}

export interface EnqueueNotificationOutboxInTransactionInput
  extends EnqueueNotificationOutboxInput {
  readonly session: ClientSession;
}

export const NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM = 100;

export interface EnqueueNotificationOutboxStandaloneInput
  extends EnqueueNotificationOutboxInput {
  readonly session?: never;
}

export interface NotificationOutboxRecord {
  readonly eventId: string;
  readonly topic: string;
  readonly dedupeKeyHash: string;
  readonly payloadVersion: number;
  readonly payload: OutboxJsonObject;
  readonly payloadHash: string;
  readonly status: NotificationOutboxStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: Date | null;
  readonly leaseToken?: string | null;
  readonly leaseOwner?: string | null;
  readonly leaseExpiresAt?: Date | null;
  readonly lastHeartbeatAt?: Date | null;
  readonly unsupportedSince?: Date | null;
  readonly lastAttemptAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly deadAt?: Date | null;
  readonly purgeAt?: Date | null;
  readonly lastErrorCode?: string | null;
  readonly lastErrorDigest?: string | null;
  readonly lastErrorAt?: Date | null;
  readonly correlationId?: string | null;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimedNotificationOutbox extends NotificationOutboxRecord {
  readonly status: "processing";
  readonly leaseToken: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
}

export interface NotificationOutboxFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export interface NotificationOutboxReconciliationResult {
  readonly recoveredExpiredLeases: number;
  readonly deadLetteredExhausted: number;
}

export interface NotificationOutboxUnsupportedReconciliationResult {
  readonly unsupportedPending: number;
  readonly unsupportedDeadLettered: number;
}

export interface NotificationOutboxReconciliationOptions {
  readonly session?: ClientSession;
  readonly recordMetrics?: boolean;
  readonly maxTimeMS?: number;
  readonly signal?: AbortSignal;
}

export interface NotificationOutboxServiceConfig {
  readonly leaseDurationMs: number;
  readonly defaultMaxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

interface NotificationOutboxModelPort {
  findOneAndUpdate(
    filter: Readonly<Record<string, unknown>>,
    update: Readonly<Record<string, unknown>>,
    options: Readonly<Record<string, unknown>>,
  ): Promise<INotificationOutbox | null>;
  findOne(
    filter: Readonly<Record<string, unknown>>,
    projection?: Readonly<Record<string, unknown>> | null,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<INotificationOutbox | null>;
  updateMany(
    filter: Readonly<Record<string, unknown>>,
    update: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  countDocuments(
    filter: Readonly<Record<string, unknown>>,
  ): Promise<number>;
  find?(
    filter: Readonly<Record<string, unknown>>,
    projection?: Readonly<Record<string, unknown>> | null,
    options?: Readonly<Record<string, unknown>>,
  ): PromiseLike<INotificationOutbox[]>;
  insertMany?(
    documents: ReadonlyArray<Readonly<Record<string, unknown>>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<INotificationOutbox[]>;
}

interface NotificationOutboxServiceDependencies {
  readonly model?: NotificationOutboxModelPort;
  readonly now?: () => Date;
  readonly eventId?: () => string;
  readonly leaseToken?: () => string;
  readonly random?: () => number;
  readonly metrics?: NotificationOutboxMetrics;
  readonly config?: Partial<NotificationOutboxServiceConfig>;
}

const DEFAULT_CONFIG: NotificationOutboxServiceConfig = Object.freeze({
  leaseDurationMs: 60_000,
  defaultMaxAttempts: 8,
  baseBackoffMs: 2_000,
  maxBackoffMs: 15 * 60_000,
});

export class NotificationOutboxIdempotencyConflictError extends Error {
  constructor(
    public readonly topic: string,
    public readonly dedupeKeyHash: string,
  ) {
    super("An outbox event already exists for this key with different content");
    this.name = "NotificationOutboxIdempotencyConflictError";
  }
}

export class NotificationOutboxLeaseLostError extends Error {
  constructor(public readonly eventId: string) {
    super(`Notification outbox lease lost for event ${eventId}`);
    this.name = "NotificationOutboxLeaseLostError";
  }
}

function validateConfig(
  candidate: NotificationOutboxServiceConfig,
): NotificationOutboxServiceConfig {
  for (const [name, value] of Object.entries(candidate)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Notification outbox ${name} must be a positive integer`);
    }
  }
  if (candidate.maxBackoffMs < candidate.baseBackoffMs) {
    throw new Error("Notification outbox maxBackoffMs must be at least baseBackoffMs");
  }
  if (candidate.defaultMaxAttempts > 100) {
    throw new Error("Notification outbox defaultMaxAttempts cannot exceed 100");
  }
  return Object.freeze(candidate);
}

function requireTopic(topic: unknown): string {
  if (
    typeof topic !== "string" ||
    topic.length === 0 ||
    topic.length > 120 ||
    !TOPIC_PATTERN.test(topic)
  ) {
    throw new Error("Invalid notification outbox topic");
  }
  return topic;
}

function requirePayloadVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000) {
    throw new Error("Invalid notification outbox payloadVersion");
  }
  return Number(value);
}

function requireDedupeKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid notification outbox dedupeKey");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error("Invalid notification outbox dedupeKey");
  }
  return normalized;
}

function requireSupportedDeliveries(
  deliveries: readonly SupportedOutboxDelivery[],
  allowEmpty: boolean,
): readonly SupportedOutboxDelivery[] {
  if ((!allowEmpty && deliveries.length === 0) || deliveries.length > 200) {
    throw new Error("Invalid supported notification outbox deliveries");
  }
  const seen = new Set<string>();
  return deliveries.map((delivery) => {
    const normalized = Object.freeze({
      topic: requireTopic(delivery.topic),
      payloadVersion: requirePayloadVersion(delivery.payloadVersion),
    });
    const key = `${normalized.topic}\u0000${normalized.payloadVersion}`;
    if (seen.has(key)) {
      throw new Error("Duplicate supported notification outbox delivery");
    }
    seen.add(key);
    return normalized;
  });
}

function requireActiveTransactionSession(session: ClientSession): ClientSession {
  if (
    !session ||
    typeof session !== "object" ||
    typeof session.inTransaction !== "function" ||
    !session.inTransaction()
  ) {
    throw new Error(
      "Notification outbox transactional enqueue requires an active ClientSession",
    );
  }
  return session;
}

function requireIdentifier(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid notification outbox ${name}`);
  }
  return value;
}

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid notification outbox ${name}`);
  }
  return value;
}

function requireDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Invalid notification outbox ${name}`);
  }
  return new Date(value.getTime());
}

export function buildExhaustedOutboxRecoveryFilter(
  nowInput: Date,
): Readonly<Record<string, unknown>> {
  const now = requireDate(nowInput, "reconciliation timestamp");
  return {
    $and: [
      {
        $or: [
          { status: "pending" },
          {
            status: "processing",
            $or: [
              { leaseExpiresAt: { $lte: now } },
              { leaseExpiresAt: null },
            ],
          },
        ],
      },
      { $expr: { $gte: ["$attemptCount", "$maxAttempts"] } },
    ],
  };
}

export function buildExpiredLeaseOutboxRecoveryFilter(
  nowInput: Date,
): Readonly<Record<string, unknown>> {
  const now = requireDate(nowInput, "reconciliation timestamp");
  return {
    status: "processing",
    $or: [
      { leaseExpiresAt: { $lte: now } },
      { leaseExpiresAt: null },
    ],
    $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000,
  );
}

function errorCode(value: unknown): string {
  if (typeof value !== "string") return "DELIVERY_FAILED";
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return normalized || "DELIVERY_FAILED";
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function toRecord(document: INotificationOutbox): NotificationOutboxRecord {
  return Object.freeze({
    eventId: document.eventId,
    topic: document.topic,
    dedupeKeyHash: document.dedupeKeyHash,
    payloadVersion: document.payloadVersion,
    payload: normalizeOutboxPayload(document.payload),
    payloadHash: document.payloadHash,
    status: document.status,
    attemptCount: document.attemptCount,
    maxAttempts: document.maxAttempts,
    nextAttemptAt: asDate(document.nextAttemptAt),
    leaseToken: document.leaseToken ?? null,
    leaseOwner: document.leaseOwner ?? null,
    leaseExpiresAt: asDate(document.leaseExpiresAt),
    lastHeartbeatAt: asDate(document.lastHeartbeatAt),
    unsupportedSince: asDate(document.unsupportedSince),
    lastAttemptAt: asDate(document.lastAttemptAt),
    deliveredAt: asDate(document.deliveredAt),
    deadAt: asDate(document.deadAt),
    purgeAt: asDate(document.purgeAt),
    lastErrorCode: document.lastErrorCode ?? null,
    lastErrorDigest: document.lastErrorDigest ?? null,
    lastErrorAt: asDate(document.lastErrorAt),
    correlationId: document.correlationId ?? null,
    revision: document.revision,
    createdAt: requireDate(document.createdAt, "createdAt"),
    updatedAt: requireDate(document.updatedAt, "updatedAt"),
  });
}

function toClaim(document: INotificationOutbox): ClaimedNotificationOutbox {
  const record = toRecord(document);
  if (
    record.status !== "processing" ||
    !record.leaseToken ||
    !record.leaseOwner ||
    !record.leaseExpiresAt
  ) {
    throw new Error("Claimed notification outbox event has an invalid lease");
  }
  return Object.freeze({
    ...record,
    status: "processing",
    leaseToken: record.leaseToken,
    leaseOwner: record.leaseOwner,
    leaseExpiresAt: record.leaseExpiresAt,
  });
}

/**
 * Durable notification event store. External effects are intentionally absent
 * from this class: producers commit an outbox row with domain data, then a
 * worker performs at-least-once delivery after the transaction commits.
 */
export class NotificationOutboxService {
  private readonly model: NotificationOutboxModelPort;
  private readonly now: () => Date;
  private readonly createEventId: () => string;
  private readonly createLeaseToken: () => string;
  private readonly random: () => number;
  private readonly config: NotificationOutboxServiceConfig;
  private readonly metrics: NotificationOutboxMetrics;

  constructor(dependencies: NotificationOutboxServiceDependencies = {}) {
    this.model =
      dependencies.model ??
      (NotificationOutbox as unknown as NotificationOutboxModelPort);
    this.now = dependencies.now ?? (() => new Date());
    this.createEventId = dependencies.eventId ?? randomUUID;
    this.createLeaseToken = dependencies.leaseToken ?? randomUUID;
    this.random = dependencies.random ?? Math.random;
    this.metrics = dependencies.metrics ?? notificationOutboxMetrics;
    this.config = validateConfig({
      ...DEFAULT_CONFIG,
      ...dependencies.config,
    });
  }

  get leaseDurationMs(): number {
    return this.config.leaseDurationMs;
  }

  /**
   * Adds an outbox event to the caller's active domain transaction. Domain data,
   * required audit, and the outbox receipt must use this entry point together.
   */
  async enqueueInTransaction(
    input: EnqueueNotificationOutboxInTransactionInput,
  ): Promise<NotificationOutboxRecord> {
    return this.performEnqueue(
      input,
      requireActiveTransactionSession(input.session),
    );
  }

  /**
   * Inserts a bounded group with two database operations at most. Every item
   * retains its own topic/dedupe identity and payload-conflict verification;
   * callers split larger fan-outs into batches of at most 100.
   */
  async enqueueManyInTransaction(
    inputs: readonly EnqueueNotificationOutboxInTransactionInput[],
  ): Promise<readonly NotificationOutboxRecord[]> {
    if (
      inputs.length < 1 ||
      inputs.length > NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM
    ) {
      throw new Error(
        `Notification outbox enqueue batch must contain 1-${NOTIFICATION_OUTBOX_ENQUEUE_BATCH_MAXIMUM} items`,
      );
    }
    const session = requireActiveTransactionSession(inputs[0]!.session);
    if (inputs.some((input) => input.session !== session)) {
      throw new Error("Notification outbox enqueue batch must share one session");
    }
    if (!this.model.find || !this.model.insertMany) {
      throw new Error("Notification outbox model does not support batch enqueue");
    }

    const prepared = inputs.map((input) => {
      const topic = requireTopic(input.topic);
      const dedupeKey = requireDedupeKey(input.dedupeKey);
      const dedupeKeyHash = hashOutboxDedupeKey(dedupeKey);
      const payloadVersion = requirePayloadVersion(input.payloadVersion);
      const payload = normalizeOutboxPayload(input.payload);
      const payloadHash = hashOutboxPayload(payloadVersion, payload);
      const maxAttempts = input.maxAttempts ?? this.config.defaultMaxAttempts;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
        throw new Error("Invalid notification outbox maxAttempts");
      }
      const nextAttemptAt = requireDate(
        input.nextAttemptAt ?? this.now(),
        "nextAttemptAt",
      );
      const correlationId = input.correlationId
        ? requireIdentifier(input.correlationId, "correlationId", 128)
        : null;
      return Object.freeze({
        key: `${topic}\u0000${dedupeKeyHash}`,
        topic,
        dedupeKeyHash,
        payloadVersion,
        payload,
        payloadHash,
        maxAttempts,
        nextAttemptAt,
        correlationId,
        eventId: requireUuid(this.createEventId(), "eventId"),
      });
    });
    if (new Set(prepared.map((item) => item.key)).size !== prepared.length) {
      throw new Error("Notification outbox enqueue batch contains duplicate keys");
    }

    const existing = await this.model.find(
      {
        $or: prepared.map(({ topic, dedupeKeyHash }) => ({
          topic,
          dedupeKeyHash,
        })),
      },
      null,
      { session },
    );
    const byKey = new Map(
      existing.map((document) => [
        `${document.topic}\u0000${document.dedupeKeyHash}`,
        document,
      ]),
    );
    for (const item of prepared) {
      const document = byKey.get(item.key);
      if (
        document &&
        (document.payloadHash !== item.payloadHash ||
          document.payloadVersion !== item.payloadVersion)
      ) {
        this.metrics.increment("idempotencyConflicts");
        throw new NotificationOutboxIdempotencyConflictError(
          item.topic,
          item.dedupeKeyHash,
        );
      }
    }

    const missing = prepared.filter((item) => !byKey.has(item.key));
    if (missing.length > 0) {
      const createdAt = requireDate(this.now(), "clock");
      const inserted = await this.model.insertMany(
        missing.map((item) => ({
          eventId: item.eventId,
          topic: item.topic,
          dedupeKeyHash: item.dedupeKeyHash,
          payloadVersion: item.payloadVersion,
          payload: item.payload,
          payloadHash: item.payloadHash,
          status: "pending",
          attemptCount: 0,
          maxAttempts: item.maxAttempts,
          nextAttemptAt: item.nextAttemptAt,
          purgeAt: null,
          correlationId: item.correlationId,
          revision: 0,
          createdAt,
          updatedAt: createdAt,
        })),
        { session, ordered: true },
      );
      for (const document of inserted) {
        byKey.set(
          `${document.topic}\u0000${document.dedupeKeyHash}`,
          document,
        );
      }
    }

    const result = prepared.map((item) => {
      const document = byKey.get(item.key);
      if (!document) {
        throw new Error("Failed to enqueue notification outbox batch item");
      }
      if (
        document.payloadHash !== item.payloadHash ||
        document.payloadVersion !== item.payloadVersion
      ) {
        this.metrics.increment("idempotencyConflicts");
        throw new NotificationOutboxIdempotencyConflictError(
          item.topic,
          item.dedupeKeyHash,
        );
      }
      this.metrics.increment(
        document.eventId === item.eventId ? "enqueued" : "deduplicated",
      );
      return toRecord(document);
    });
    return Object.freeze(result);
  }

  /**
   * Adds an event without a transaction only when this event is the complete
   * durable write. Never use this entry point beside a separate domain write.
   */
  async enqueueStandalone(
    input: EnqueueNotificationOutboxStandaloneInput,
  ): Promise<NotificationOutboxRecord> {
    if ("session" in input) {
      throw new Error(
        "Notification outbox standalone enqueue does not accept a ClientSession",
      );
    }
    return this.performEnqueue(input, null);
  }

  private async performEnqueue(
    input: EnqueueNotificationOutboxInput,
    session: ClientSession | null,
  ): Promise<NotificationOutboxRecord> {
    const topic = requireTopic(input.topic);
    const dedupeKey = requireDedupeKey(input.dedupeKey);
    const dedupeKeyHash = hashOutboxDedupeKey(dedupeKey);
    const payloadVersion = requirePayloadVersion(input.payloadVersion);
    const payload = normalizeOutboxPayload(input.payload);
    const payloadHash = hashOutboxPayload(payloadVersion, payload);
    const maxAttempts = input.maxAttempts ?? this.config.defaultMaxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("Invalid notification outbox maxAttempts");
    }
    const nextAttemptAt = requireDate(
      input.nextAttemptAt ?? this.now(),
      "nextAttemptAt",
    );
    const correlationId = input.correlationId
      ? requireIdentifier(input.correlationId, "correlationId", 128)
      : null;
    const filter = { topic, dedupeKeyHash };
    const options = {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
      ...(session ? { session } : {}),
    };

    const candidateEventId = requireUuid(this.createEventId(), "eventId");
    let document: INotificationOutbox | null;
    try {
      document = await this.model.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            eventId: candidateEventId,
            topic,
            dedupeKeyHash,
            payloadVersion,
            payload,
            payloadHash,
            status: "pending",
            attemptCount: 0,
            maxAttempts,
            nextAttemptAt,
            purgeAt: null,
            correlationId,
            revision: 0,
          },
        },
        options,
      );
    } catch (error) {
      if (!isDuplicateKeyError(error) || session) throw error;
      document = await this.model.findOne(filter, null, {});
    }

    if (!document) {
      throw new Error("Failed to enqueue notification outbox event");
    }
    if (
      document.payloadHash !== payloadHash ||
      document.payloadVersion !== payloadVersion
    ) {
      this.metrics.increment("idempotencyConflicts");
      throw new NotificationOutboxIdempotencyConflictError(
        topic,
        dedupeKeyHash,
      );
    }
    this.metrics.increment(
      document.eventId === candidateEventId ? "enqueued" : "deduplicated",
    );
    return toRecord(document);
  }

  async claimNext(
    leaseOwnerInput: string,
    supportedDeliveries: readonly SupportedOutboxDelivery[],
  ): Promise<ClaimedNotificationOutbox | null> {
    const leaseOwner = requireIdentifier(leaseOwnerInput, "leaseOwner", 128);
    if (supportedDeliveries.length === 0) return null;
    const supported = requireSupportedDeliveries(supportedDeliveries, false);
    const now = requireDate(this.now(), "clock");
    const leaseToken = requireUuid(this.createLeaseToken(), "leaseToken");
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseDurationMs);

    const document = await this.model.findOneAndUpdate(
      {
        status: "pending",
        nextAttemptAt: { $lte: now },
        $expr: { $lt: ["$attemptCount", "$maxAttempts"] },
        $or: supported,
      },
      {
        $set: {
          status: "processing",
          leaseToken,
          leaseOwner,
          leaseExpiresAt,
          lastHeartbeatAt: now,
          lastAttemptAt: now,
          purgeAt: null,
          updatedAt: now,
        },
        $unset: { unsupportedSince: "" },
        $inc: { attemptCount: 1, revision: 1 },
      },
      {
        new: true,
        sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 },
        runValidators: true,
      },
    );

    if (!document) return null;
    this.metrics.increment("claimed");
    return toClaim(document);
  }

  async renewLease(
    claim: ClaimedNotificationOutbox,
  ): Promise<ClaimedNotificationOutbox> {
    const now = requireDate(this.now(), "clock");
    const leaseExpiresAt = new Date(now.getTime() + this.config.leaseDurationMs);
    const document = await this.model.findOneAndUpdate(
      {
        eventId: claim.eventId,
        status: "processing",
        leaseToken: claim.leaseToken,
        leaseOwner: claim.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: {
          lastHeartbeatAt: now,
          updatedAt: now,
        },
        // A slower, earlier renewal must never shorten a lease extended by a
        // later concurrent renewal from the same fenced owner/token.
        $max: { leaseExpiresAt },
      },
      { new: true, runValidators: true },
    );
    if (!document) {
      this.metrics.increment("leaseLost");
      throw new NotificationOutboxLeaseLostError(claim.eventId);
    }
    this.metrics.increment("leasesRenewed");
    return toClaim(document);
  }

  /**
   * Releases a claim when a runtime delivery gate changes after the atomic
   * claim. Reversing the claim increment prevents a kill switch from
   * exhausting or dead-lettering an otherwise valid notification.
   */
  async deferClaim(
    claim: ClaimedNotificationOutbox,
  ): Promise<NotificationOutboxRecord> {
    if (!Number.isSafeInteger(claim.attemptCount) || claim.attemptCount < 1) {
      throw new Error("Deferred notification outbox claim is invalid");
    }
    const now = requireDate(this.now(), "clock");
    const document = await this.model.findOneAndUpdate(
      {
        eventId: claim.eventId,
        status: "processing",
        attemptCount: claim.attemptCount,
        leaseToken: claim.leaseToken,
        leaseOwner: claim.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: {
          status: "pending",
          nextAttemptAt: new Date(now.getTime() + this.config.baseBackoffMs),
          purgeAt: null,
          updatedAt: now,
        },
        $unset: {
          leaseToken: "",
          leaseOwner: "",
          leaseExpiresAt: "",
          lastHeartbeatAt: "",
        },
        $inc: { attemptCount: -1, revision: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!document) {
      this.metrics.increment("leaseLost");
      throw new NotificationOutboxLeaseLostError(claim.eventId);
    }
    return toRecord(document);
  }

  async finalizeDelivered(
    claim: ClaimedNotificationOutbox,
  ): Promise<NotificationOutboxRecord> {
    const now = requireDate(this.now(), "clock");
    const purgeAt = notificationOutboxTerminalPurgeAt("delivered", now);
    const document = await this.model.findOneAndUpdate(
      {
        eventId: claim.eventId,
        status: "processing",
        leaseToken: claim.leaseToken,
        leaseOwner: claim.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: {
          status: "delivered",
          deliveredAt: now,
          purgeAt,
          updatedAt: now,
        },
        $unset: {
          nextAttemptAt: "",
          leaseToken: "",
          leaseOwner: "",
          leaseExpiresAt: "",
          lastHeartbeatAt: "",
          lastErrorCode: "",
          lastErrorDigest: "",
          lastErrorAt: "",
        },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!document) {
      this.metrics.increment("leaseLost");
      throw new NotificationOutboxLeaseLostError(claim.eventId);
    }
    this.metrics.increment("delivered");
    return toRecord(document);
  }

  async finalizeFailure(
    claim: ClaimedNotificationOutbox,
    failure: NotificationOutboxFailure,
  ): Promise<NotificationOutboxRecord> {
    const now = requireDate(this.now(), "clock");
    const code = errorCode(failure.code);
    const digest = hashOutboxError(failure.cause ?? code);
    const exhausted = claim.attemptCount >= claim.maxAttempts;
    const shouldDeadLetter = !failure.retryable || exhausted;
    const setFields: Record<string, unknown> = {
      status: shouldDeadLetter ? "dead" : "pending",
      lastErrorCode: code,
      lastErrorDigest: digest,
      lastErrorAt: now,
      updatedAt: now,
    };
    if (shouldDeadLetter) {
      setFields.deadAt = now;
      setFields.purgeAt = notificationOutboxTerminalPurgeAt("dead", now);
    } else {
      setFields.nextAttemptAt = new Date(
        now.getTime() + this.calculateBackoffMs(claim.attemptCount),
      );
      setFields.purgeAt = null;
    }

    const unsetFields: Record<string, ""> = {
      leaseToken: "",
      leaseOwner: "",
      leaseExpiresAt: "",
      lastHeartbeatAt: "",
    };
    if (shouldDeadLetter) unsetFields.nextAttemptAt = "";

    const document = await this.model.findOneAndUpdate(
      {
        eventId: claim.eventId,
        status: "processing",
        leaseToken: claim.leaseToken,
        leaseOwner: claim.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: setFields,
        $unset: unsetFields,
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true },
    );
    if (!document) {
      this.metrics.increment("leaseLost");
      throw new NotificationOutboxLeaseLostError(claim.eventId);
    }
    this.metrics.increment(
      document.status === "dead" ? "deadLettered" : "retryScheduled",
    );
    return toRecord(document);
  }

  async reconcile(
    limitInput: number = 100,
    options: NotificationOutboxReconciliationOptions = {},
  ): Promise<NotificationOutboxReconciliationResult> {
    if (!Number.isInteger(limitInput) || limitInput < 1 || limitInput > 1_000) {
      throw new Error("Invalid notification outbox reconciliation limit");
    }
    const session = options.session
      ? requireActiveTransactionSession(options.session)
      : undefined;
    const recordMetrics = options.recordMetrics !== false;
    if (
      options.maxTimeMS !== undefined &&
      (!Number.isSafeInteger(options.maxTimeMS) ||
        options.maxTimeMS < 1 ||
        options.maxTimeMS > 60_000)
    ) {
      throw new Error("Invalid notification outbox reconciliation timeout");
    }
    const now = requireDate(this.now(), "clock");
    const exhaustedFilter = buildExhaustedOutboxRecoveryFilter(now);
    const expiredLeaseFilter = buildExpiredLeaseOutboxRecoveryFilter(now);
    let recoveredExpiredLeases = 0;
    let deadLetteredExhausted = 0;

    const executeUpdate = async (
      filter: Readonly<Record<string, unknown>>,
      update: Readonly<Record<string, unknown>>,
      operationOptions: Readonly<Record<string, unknown>>,
    ): Promise<INotificationOutbox | null> => {
      const operation = this.model.findOneAndUpdate(
        filter,
        update,
        operationOptions,
      );
      return options.signal
        ? awaitWithAbort(operation, options.signal)
        : operation;
    };

    for (let processed = 0; processed < limitInput; processed += 1) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Reconciliation aborted");
      }
      const exhausted = await executeUpdate(
        exhaustedFilter,
        {
          $set: {
            status: "dead",
            deadAt: now,
            purgeAt: notificationOutboxTerminalPurgeAt("dead", now),
            lastErrorCode: "MAX_ATTEMPTS_EXHAUSTED",
            lastErrorDigest: hashOutboxError("MAX_ATTEMPTS_EXHAUSTED"),
            lastErrorAt: now,
            updatedAt: now,
          },
          $unset: {
            nextAttemptAt: "",
            leaseToken: "",
            leaseOwner: "",
            leaseExpiresAt: "",
            lastHeartbeatAt: "",
          },
          $inc: { revision: 1 },
        },
        {
          new: true,
          sort: { createdAt: 1, _id: 1 },
          runValidators: true,
          ...(session ? { session } : {}),
          ...(options.maxTimeMS === undefined
            ? {}
            : { maxTimeMS: options.maxTimeMS }),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (exhausted) {
        deadLetteredExhausted += 1;
        if (recordMetrics) this.metrics.increment("deadLettered");
        continue;
      }

      const stale = await executeUpdate(
        expiredLeaseFilter,
        {
          $set: {
            status: "pending",
            nextAttemptAt: now,
            purgeAt: null,
            lastErrorCode: "LEASE_EXPIRED",
            lastErrorDigest: hashOutboxError("LEASE_EXPIRED"),
            lastErrorAt: now,
            updatedAt: now,
          },
          $unset: {
            leaseToken: "",
            leaseOwner: "",
            leaseExpiresAt: "",
            lastHeartbeatAt: "",
          },
          $inc: { revision: 1 },
        },
        {
          new: true,
          sort: { leaseExpiresAt: 1, createdAt: 1, _id: 1 },
          runValidators: true,
          ...(session ? { session } : {}),
          ...(options.maxTimeMS === undefined
            ? {}
            : { maxTimeMS: options.maxTimeMS }),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (!stale) break;
      recoveredExpiredLeases += 1;
      if (recordMetrics) this.metrics.increment("expiredLeasesRecovered");
    }

    return { recoveredExpiredLeases, deadLetteredExhausted };
  }

  /**
   * Observes pending records that no deployed handler can process. A record is
   * retained for a grace period from first observation so rolling deployments
   * and quick rollbacks can restore support without losing the delivery.
   */
  async reconcileUnsupportedDeliveries(
    supportedDeliveries: readonly SupportedOutboxDelivery[],
    gracePeriodMs: number,
    limitInput: number = 100,
  ): Promise<NotificationOutboxUnsupportedReconciliationResult> {
    const supported = requireSupportedDeliveries(supportedDeliveries, false);
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs <= 0) {
      throw new Error("Invalid unsupported notification outbox grace period");
    }
    if (!Number.isInteger(limitInput) || limitInput < 1 || limitInput > 1_000) {
      throw new Error("Invalid notification outbox reconciliation limit");
    }

    const now = requireDate(this.now(), "clock");
    const unsupportedFilter = { $nor: supported };

    // A restored handler resets the observation window before its event is due.
    await this.model.updateMany(
      {
        status: "pending",
        unsupportedSince: { $ne: null },
        $or: supported,
      },
      {
        $unset: { unsupportedSince: "" },
        $set: { purgeAt: null, updatedAt: now },
      },
      { runValidators: true },
    );

    await this.model.updateMany(
      {
        status: "pending",
        $and: [
          unsupportedFilter,
          {
            $or: [
              { unsupportedSince: { $exists: false } },
              { unsupportedSince: null },
            ],
          },
        ],
      },
      {
        $set: { unsupportedSince: now, purgeAt: null, updatedAt: now },
      },
      { runValidators: true },
    );

    const cutoff = new Date(now.getTime() - gracePeriodMs);
    let unsupportedDeadLettered = 0;
    for (let processed = 0; processed < limitInput; processed += 1) {
      const dead = await this.model.findOneAndUpdate(
        {
          status: "pending",
          unsupportedSince: { $lte: cutoff },
          ...unsupportedFilter,
        },
        {
          $set: {
            status: "dead",
            deadAt: now,
            purgeAt: notificationOutboxTerminalPurgeAt("dead", now),
            lastErrorCode: "HANDLER_NOT_REGISTERED",
            lastErrorDigest: hashOutboxError("HANDLER_NOT_REGISTERED"),
            lastErrorAt: now,
            updatedAt: now,
          },
          $unset: {
            nextAttemptAt: "",
            leaseToken: "",
            leaseOwner: "",
            leaseExpiresAt: "",
            lastHeartbeatAt: "",
          },
          $inc: { revision: 1 },
        },
        {
          new: true,
          sort: { unsupportedSince: 1, createdAt: 1, _id: 1 },
          runValidators: true,
        },
      );
      if (!dead) break;
      unsupportedDeadLettered += 1;
      this.metrics.increment("deadLettered");
      this.metrics.increment("unsupportedDeadLettered");
    }

    const unsupportedPending = await this.model.countDocuments({
      status: "pending",
      ...unsupportedFilter,
    });
    this.metrics.setUnsupportedPending(unsupportedPending);
    return { unsupportedPending, unsupportedDeadLettered };
  }

  private calculateBackoffMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(30, attemptCount - 1));
    const capped = Math.min(
      this.config.maxBackoffMs,
      this.config.baseBackoffMs * 2 ** exponent,
    );
    const sampled = this.random();
    const random = Number.isFinite(sampled)
      ? Math.max(0, Math.min(1, sampled))
      : 0.5;
    return Math.max(1, Math.floor(capped * (0.5 + random * 0.5)));
  }
}

export const notificationOutboxService = new NotificationOutboxService();
