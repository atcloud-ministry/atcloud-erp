import { createHash } from "node:crypto";
import type { ClientSession, Connection } from "mongoose";
import mongoose from "mongoose";
import { createRuntimeConfigDTO } from "../../contracts/runtimeConfig";
import AuditLog, { AUDIT_LOG_RETENTION_MONTHS } from "../../models/AuditLog";
import NotificationOutbox from "../../models/NotificationOutbox";
import User from "../../models/User";
import {
  AlumniAccountDeletionService,
  RESTORE_ACCOUNT_DELETION_ACTOR_KEY,
  type DeleteAlumniAccountInput,
} from "../alumni/AlumniAccountDeletionService";
import {
  AlumniOutcomeDeadlineService,
  type AlumniOutcomeDeadlineResult,
  type AlumniOutcomeRunContext,
} from "../alumni/AlumniOutcomeDeadlineService";
import {
  AlumniRetentionCleanupService,
  type AlumniRetentionCleanupResult,
  type AlumniRetentionRunContext,
} from "../alumni/AlumniRetentionCleanupService";
import {
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  workerAuthorizationService,
} from "../authorization/WorkerAuthorizationService";
import {
  EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
  ProgramMembershipReconciliationService,
  type ProgramMembershipReconciliationCheckpoint,
  type ProgramMembershipReconciliationCheckpointRun,
  type ProgramMembershipReconciliationResult,
  type ProgramMembershipReconciliationRunContext,
} from "../programs/ProgramMembershipReconciliationService";
import { ProgramRoomMembershipSyncService } from "../programs/ProgramRoomMembershipSyncService";
import type { ProgramMembershipRuntimeReader } from "../programs/ProgramMembershipRuntimeGate";
import { AuditLogService } from "../AuditLogService";
import {
  idempotencyService,
  type IdempotencyReplayResponseDto,
} from "../reliability/IdempotencyService";
import {
  buildExhaustedOutboxRecoveryFilter,
  buildExpiredLeaseOutboxRecoveryFilter,
  notificationOutboxService,
} from "../reliability/NotificationOutboxService";
import {
  mongoTransactionService,
  type MongoTransactionTopologyCapability,
} from "../reliability/MongoTransactionService";
import {
  RESTORE_TTL_DEFINITIONS,
  type RestoreTtlDefinition,
} from "./RestoreQualificationService";

const REPORT_SCHEMA_VERSION = 1 as const;
const ACCOUNT_DELETION_BATCH_LIMIT = 100;
const RETENTION_BATCH_LIMIT = 500;
const OUTCOME_BATCH_LIMIT = 500;
const MEMBERSHIP_BATCH_LIMIT = 100;
const OUTBOX_BATCH_LIMIT = 100;
const TTL_BATCH_LIMIT = 500;
const RESTORE_OPERATION_MAX_TIME_MS = 5_000;
const MAX_ACCOUNT_DELETION_MANIFEST_ENTRIES = 5_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const ISO_UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const RESTORE_RECOVERY_LIMITS = Object.freeze({
  accountDeletion: ACCOUNT_DELETION_BATCH_LIMIT,
  retentionPerKind: RETENTION_BATCH_LIMIT,
  outcome: OUTCOME_BATCH_LIMIT,
  membership: MEMBERSHIP_BATCH_LIMIT,
  outbox: OUTBOX_BATCH_LIMIT,
  ttl: TTL_BATCH_LIMIT,
});

/**
 * Restore isolation has already been established by the dedicated CLI. Both
 * membership layers receive this same local permit reader so they can repair
 * an isolated clone while the public-release flag remains disabled.
 */
export const RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER: ProgramMembershipRuntimeReader =
  Object.freeze({
    getOperationalRuntimeConfig: async () => createRuntimeConfigDTO("on", 0),
  });

export interface RestoreAccountDeletionManifestEntry {
  readonly userId: string;
  readonly deletedAt: string;
}

/**
 * A restricted, source-generated delta for accounts deleted after the Atlas
 * snapshot.  The CLI hashes this input for reporting and never emits an ID.
 */
export interface RestoreAccountDeletionManifest {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly kind: "alumni_account_deletion_reconciliation";
  readonly sourceSnapshotAt: string;
  readonly entries: readonly RestoreAccountDeletionManifestEntry[];
}

interface ValidatedRestoreAccountDeletionManifest {
  readonly sourceSnapshotAt: Date;
  readonly entries: readonly {
    readonly userId: string;
    readonly deletedAt: Date;
  }[];
  readonly digest: string;
}

export interface RestoreAccountDeletionRecoveryResult {
  readonly manifestEntries: number;
  readonly reconciledAccounts: number;
  readonly outstandingAccounts: number;
  readonly hasMore: boolean;
  readonly manifestDigest: string;
}

export interface RestoreOutboxReconciliationResult {
  readonly recoveredExpiredLeases: number;
  readonly deadLetteredExhausted: number;
  readonly hasMore: boolean;
  readonly replayed: boolean;
}

export interface RestoreOutboxReconciliationPort {
  reconcile(input: {
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<RestoreOutboxReconciliationResult>;
}

export interface RestoreRecoveryWorkerContexts {
  createRetention(): AlumniRetentionRunContext;
  createOutcome(): AlumniOutcomeRunContext;
  createMembership(): ProgramMembershipReconciliationRunContext;
}

export interface RestoreMembershipCheckpointState {
  readonly checkpoint: ProgramMembershipReconciliationCheckpoint;
  readonly completed: boolean;
  /**
   * Optimistic-concurrency version. It is intentionally an operations-only
   * value and never appears in the recovery report.
   */
  readonly revision: number;
}

export interface RestoreMembershipCheckpointPort {
  load(manifestDigest: string): Promise<RestoreMembershipCheckpointState>;
  save(
    manifestDigest: string,
    state: RestoreMembershipCheckpointState,
    expectedRevision: number,
  ): Promise<void>;
}

interface AccountDeletionRecoveryPort {
  findExistingUserIds(userIds: readonly string[]): Promise<readonly string[]>;
  deleteAccount(input: DeleteAlumniAccountInput): Promise<unknown>;
}

interface AuditRetentionPort {
  purgeOldAuditLogsBounded(
    limit: number,
    retentionMonths?: number,
  ): Promise<{ readonly deletedCount: number; readonly hasMore: boolean }>;
}

export interface RestoreTtlCleanupResult {
  readonly recordsDeleted: number;
  readonly hasMore: boolean;
}

interface RestoreTtlCleanupPort {
  purgeBounded(): Promise<RestoreTtlCleanupResult>;
}

interface TransactionCapabilityPort {
  assertTopologyCapability(
    forceRefresh?: boolean,
  ): Promise<MongoTransactionTopologyCapability>;
}

export interface RestoreRecoveryServiceDependencies {
  readonly now?: () => Date;
  readonly transactions?: TransactionCapabilityPort;
  readonly accountDeletion?: AccountDeletionRecoveryPort;
  readonly retention?: Pick<AlumniRetentionCleanupService, "runBounded">;
  readonly outcome?: Pick<AlumniOutcomeDeadlineService, "runBounded">;
  readonly membership?: Pick<
    ProgramMembershipReconciliationService,
    "runBoundedFromCheckpoint"
  >;
  readonly outbox?: RestoreOutboxReconciliationPort;
  readonly auditRetention?: AuditRetentionPort;
  readonly ttlRetention?: RestoreTtlCleanupPort;
  readonly membershipCheckpoints?: RestoreMembershipCheckpointPort;
  readonly contexts?: RestoreRecoveryWorkerContexts;
}

export interface RestoreRecoveryInput {
  readonly accountDeletionManifest: RestoreAccountDeletionManifest;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface RestoreRecoveryIssue {
  readonly code:
    | "RESTORE_ACCOUNT_DELETION_RECONCILIATION_REQUIRED"
    | "RESTORE_RETENTION_RECOVERY_INCOMPLETE"
    | "RESTORE_MEMBERSHIP_RECOVERY_INCOMPLETE"
    | "RESTORE_OUTCOME_RECOVERY_INCOMPLETE"
    | "RESTORE_OUTBOX_RECOVERY_INCOMPLETE";
}

export interface RestoreRecoveryReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly kind: "restore_recovery";
  readonly generatedAt: string;
  readonly status: "completed" | "incomplete";
  readonly transaction: {
    readonly supported: boolean;
    readonly topology: MongoTransactionTopologyCapability["topology"];
  };
  readonly accountDeletion: RestoreAccountDeletionRecoveryResult;
  readonly retention: AlumniRetentionCleanupResult & {
    readonly auditLogsPurged: number;
    readonly ttlRecordsPurged: number;
    readonly hasMore: boolean;
  };
  readonly membership: ProgramMembershipReconciliationResult;
  readonly outcome: AlumniOutcomeDeadlineResult & {
    readonly hasMore: boolean;
  };
  readonly outbox: RestoreOutboxReconciliationResult;
  readonly issues: readonly RestoreRecoveryIssue[];
}

interface RestoreRecoveryReportInput {
  readonly generatedAt: Date;
  readonly capability: MongoTransactionTopologyCapability;
  readonly accountDeletion: RestoreAccountDeletionRecoveryResult;
  readonly retention: RestoreRecoveryReport["retention"];
  readonly membership: ProgramMembershipReconciliationResult;
  readonly outcome: RestoreRecoveryReport["outcome"];
  readonly outbox: RestoreOutboxReconciliationResult;
  readonly issues: readonly RestoreRecoveryIssue[];
}

export class RestoreRecoveryInputError extends Error {
  readonly name = "RestoreRecoveryInputError";
  readonly code = "RESTORE_RECOVERY_INPUT_INVALID";

  constructor(message: string) {
    super(message);
  }
}

export class RestoreRecoveryTransactionTopologyError extends Error {
  readonly name = "RestoreRecoveryTransactionTopologyError";
  readonly code = "RESTORE_TRANSACTION_TOPOLOGY_UNSUPPORTED";

  constructor() {
    super("Restore recovery requires MongoDB transaction support.");
  }
}

/** A second recovery process advanced the same restore-only checkpoint. */
export class RestoreRecoveryConcurrentRunError extends Error {
  readonly name = "RestoreRecoveryConcurrentRunError";
  readonly code = "RESTORE_RECOVERY_CONCURRENT_RUN";

  constructor() {
    super("Another restore recovery process updated the membership checkpoint.");
  }
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new RestoreRecoveryInputError(
      "Account deletion manifest contains unsupported fields.",
    );
  }
}

function requireUtcInstant(value: unknown, label: string): Date {
  if (typeof value !== "string" || !ISO_UTC_INSTANT_PATTERN.test(value)) {
    throw new RestoreRecoveryInputError(`${label} must be a UTC ISO instant.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RestoreRecoveryInputError(`${label} must be a valid UTC instant.`);
  }
  return parsed;
}

function validateAccountDeletionManifest(
  value: unknown,
  recoveryNow?: Date,
): ValidatedRestoreAccountDeletionManifest {
  const source = plainRecord(value);
  if (!source) {
    throw new RestoreRecoveryInputError(
      "Account deletion manifest must be a JSON object.",
    );
  }
  requireExactKeys(source, ["schemaVersion", "kind", "sourceSnapshotAt", "entries"]);
  if (source.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new RestoreRecoveryInputError(
      "Account deletion manifest schema version is invalid.",
    );
  }
  if (source.kind !== "alumni_account_deletion_reconciliation") {
    throw new RestoreRecoveryInputError("Account deletion manifest kind is invalid.");
  }
  const sourceSnapshotAt = requireUtcInstant(
    source.sourceSnapshotAt,
    "sourceSnapshotAt",
  );
  if (recoveryNow && sourceSnapshotAt.getTime() > recoveryNow.getTime()) {
    throw new RestoreRecoveryInputError(
      "Account deletion manifest source snapshot is after recovery time.",
    );
  }
  if (
    !Array.isArray(source.entries) ||
    source.entries.length > MAX_ACCOUNT_DELETION_MANIFEST_ENTRIES
  ) {
    throw new RestoreRecoveryInputError(
      "Account deletion manifest entries are invalid.",
    );
  }

  const seen = new Set<string>();
  const entries = source.entries.map((entry): { readonly userId: string; readonly deletedAt: Date } => {
    const record = plainRecord(entry);
    if (!record) {
      throw new RestoreRecoveryInputError("Account deletion manifest entry is invalid.");
    }
    requireExactKeys(record, ["userId", "deletedAt"]);
    if (typeof record.userId !== "string" || !OBJECT_ID_PATTERN.test(record.userId)) {
      throw new RestoreRecoveryInputError("Account deletion manifest user ID is invalid.");
    }
    const userId = record.userId.toLowerCase();
    if (seen.has(userId)) {
      throw new RestoreRecoveryInputError("Account deletion manifest contains duplicate users.");
    }
    seen.add(userId);
    const deletedAt = requireUtcInstant(record.deletedAt, "deletedAt");
    if (deletedAt.getTime() < sourceSnapshotAt.getTime()) {
      throw new RestoreRecoveryInputError(
        "Account deletion manifest contains a deletion before the source snapshot.",
      );
    }
    if (recoveryNow && deletedAt.getTime() > recoveryNow.getTime()) {
      throw new RestoreRecoveryInputError(
        "Account deletion manifest contains a deletion after recovery time.",
      );
    }
    return Object.freeze({ userId, deletedAt });
  });
  entries.sort((left, right) => left.userId.localeCompare(right.userId));
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: REPORT_SCHEMA_VERSION,
        kind: "alumni_account_deletion_reconciliation",
        sourceSnapshotAt: sourceSnapshotAt.toISOString(),
        entries: entries.map((entry) => ({
          userId: entry.userId,
          deletedAt: entry.deletedAt.toISOString(),
        })),
      }),
    )
    .digest("hex");
  return Object.freeze({
    sourceSnapshotAt,
    entries: Object.freeze(entries),
    digest,
  });
}

/** Validates and normalizes an account-deletion delta without retaining IDs. */
export function parseRestoreAccountDeletionManifest(
  value: unknown,
): RestoreAccountDeletionManifest {
  const manifest = validateAccountDeletionManifest(value);
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "alumni_account_deletion_reconciliation" as const,
    sourceSnapshotAt: manifest.sourceSnapshotAt.toISOString(),
    entries: Object.freeze(
      manifest.entries.map((entry) =>
        Object.freeze({
          userId: entry.userId,
          deletedAt: entry.deletedAt.toISOString(),
        }),
      ),
    ),
  });
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RestoreRecoveryInputError("Restore recovery idempotency key is invalid.");
  }
  return value.toLowerCase();
}

function requireCorrelationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new RestoreRecoveryInputError("Restore recovery correlation ID is invalid.");
  }
  return value;
}

function requireNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RestoreRecoveryInputError("Restore recovery clock is invalid.");
  }
  return new Date(value);
}

async function defaultExistingUserIds(
  userIds: readonly string[],
): Promise<readonly string[]> {
  if (userIds.length === 0) return Object.freeze([]);
  const documents = await User.find({
    _id: { $in: userIds.map((userId) => new mongoose.Types.ObjectId(userId)) },
  })
    .select({ _id: 1 })
    .lean()
    .exec();
  return Object.freeze(documents.map((document) => String(document._id).toLowerCase()));
}

function defaultWorkerContexts(): RestoreRecoveryWorkerContexts {
  return Object.freeze({
    createRetention: () =>
      workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.ALUMNI_RETENTION,
        WORKER_RUN_TRIGGERS.RECOVERY,
      ),
    createOutcome: () =>
      workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
        WORKER_RUN_TRIGGERS.RECOVERY,
      ),
    createMembership: () =>
      workerAuthorizationService.createRunContext(
        WORKER_SERVICE_KEYS.PROGRAM_MEMBERSHIP_RECONCILER,
        WORKER_RUN_TRIGGERS.RECOVERY,
      ),
  });
}

const EMPTY_RETENTION_RESULT: AlumniRetentionCleanupResult = Object.freeze({
  importCandidatesScanned: 0,
  importBatchesPurged: 0,
  invitationCandidatesScanned: 0,
  invitationsPurged: 0,
});

const EMPTY_MEMBERSHIP_RESULT: ProgramMembershipReconciliationResult = Object.freeze({
  paused: false,
  candidatesScanned: 0,
  reconciledPrograms: 0,
  createdMemberships: 0,
  updatedRoles: 0,
  closedMemberships: 0,
  reactivatedMemberships: 0,
  archivedRooms: 0,
  ignoredPurchasesMissingStudentRoleId: 0,
  ignoredPurchasesUnmappedStudentRoleId: 0,
  deferredRevocations: 0,
  deferredReactivations: 0,
  racedOrUnavailable: 0,
  hasMore: false,
  capacityPerRun: MEMBERSHIP_BATCH_LIMIT,
});

const EMPTY_OUTCOME_RESULT: AlumniOutcomeDeadlineResult = Object.freeze({
  candidatesScanned: 0,
  automaticallyConfirmed: 0,
  racedOrUnavailable: 0,
  remainingOverdue: 0,
  paused: false,
});

const EMPTY_OUTBOX_RESULT: RestoreOutboxReconciliationResult = Object.freeze({
  recoveredExpiredLeases: 0,
  deadLetteredExhausted: 0,
  hasMore: false,
  replayed: false,
});

export interface RestoreTtlCleanupDependencies {
  readonly connection?: Connection;
  readonly now?: () => Date;
  readonly definitions?: readonly RestoreTtlDefinition[];
  readonly limit?: number;
}

/**
 * Mirrors Atlas TTL expiration with a deterministic bounded pass so a final
 * restore qualification does not depend on the asynchronous TTL monitor.
 */
export class RestoreTtlCleanupService implements RestoreTtlCleanupPort {
  private readonly connection: Connection;
  private readonly now: () => Date;
  private readonly definitions: readonly RestoreTtlDefinition[];
  private readonly limit: number;

  constructor(dependencies: RestoreTtlCleanupDependencies = {}) {
    this.connection = dependencies.connection ?? mongoose.connection;
    this.now = dependencies.now ?? (() => new Date());
    this.definitions = dependencies.definitions ?? RESTORE_TTL_DEFINITIONS;
    this.limit = dependencies.limit ?? TTL_BATCH_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 500) {
      throw new RestoreRecoveryInputError(
        "Restore TTL cleanup limit must be an integer from 1 to 500.",
      );
    }
  }

  async purgeBounded(): Promise<RestoreTtlCleanupResult> {
    const database = this.connection.db;
    if (!database) {
      throw new Error("Restore TTL cleanup requires an active MongoDB connection.");
    }
    const now = requireNow(this.now());
    let remaining = this.limit;
    let recordsDeleted = 0;
    for (const definition of this.definitions) {
      if (remaining === 0) {
        return Object.freeze({ recordsDeleted, hasMore: true });
      }
      const collection = database.collection(definition.collectionName);
      // Each scoped TTL index has exactly this leading field.  Sorting by it
      // lets Atlas stop after the bounded page instead of materializing a
      // broad expired set merely to order by _id.
      const ttlFieldSort: Record<string, 1> = { [definition.field]: 1 };
      const candidates = await collection
        .find(
          { [definition.field]: { $lte: now } },
          { projection: { _id: 1 } },
        )
        .sort(ttlFieldSort)
        .limit(remaining + 1)
        .maxTimeMS(RESTORE_OPERATION_MAX_TIME_MS)
        .toArray();
      const selected = candidates.slice(0, remaining).map((candidate) => candidate._id);
      if (selected.length === 0) continue;
      const deleted = await collection.deleteMany({
        _id: { $in: selected },
        [definition.field]: { $lte: now },
      });
      const deletedCount = deleted.deletedCount ?? 0;
      recordsDeleted += deletedCount;
      remaining -= selected.length;
      if (deletedCount < selected.length || candidates.length > selected.length) {
        return Object.freeze({ recordsDeleted, hasMore: true });
      }
    }
    return Object.freeze({
      recordsDeleted,
      // An exact full pass deliberately requires one no-op confirmation pass;
      // this preserves the hard cap without a potentially broad final query.
      hasMore: remaining === 0,
    });
  }
}

const MEMBERSHIP_CHECKPOINT_COLLECTION = "restore_recovery_checkpoints";

interface RestoreMembershipCheckpointDocument {
  readonly _id: string;
  readonly membership?: unknown;
  readonly membershipCompleted?: unknown;
  readonly revision?: number;
  readonly schemaVersion?: unknown;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

function checkpointDocumentId(manifestDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(manifestDigest)) {
    throw new RestoreRecoveryInputError("Restore membership checkpoint key is invalid.");
  }
  return `alumni_network:${manifestDigest}`;
}

function normalizeCheckpoint(value: unknown): ProgramMembershipReconciliationCheckpoint {
  const record = plainRecord(value);
  const settingsAfterId = record?.settingsAfterId;
  const anomalyAfterId = record?.anomalyAfterId;
  const validCursor = (cursor: unknown): cursor is string | null =>
    cursor === null ||
    (typeof cursor === "string" && OBJECT_ID_PATTERN.test(cursor));
  if (!record || !validCursor(settingsAfterId) || !validCursor(anomalyAfterId)) {
    throw new RestoreRecoveryInputError("Restore membership checkpoint is invalid.");
  }
  return Object.freeze({
    settingsAfterId:
      typeof settingsAfterId === "string" ? settingsAfterId.toLowerCase() : null,
    anomalyAfterId:
      typeof anomalyAfterId === "string" ? anomalyAfterId.toLowerCase() : null,
  });
}

function normalizeCheckpointRevision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new RestoreRecoveryInputError("Restore membership checkpoint is invalid.");
  }
  return value;
}

function duplicateKeyError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === 11_000
  );
}

export interface RestoreMembershipCheckpointDependencies {
  readonly connection?: Connection;
  readonly now?: () => Date;
}

/**
 * A restore-only checkpoint lives in the isolated clone and stores no user
 * data.  A terminal record is retained for idempotent CLI retries; a changed
 * source manifest has a different digest and therefore gets a fresh record.
 */
export class RestoreMembershipCheckpointService
  implements RestoreMembershipCheckpointPort
{
  private readonly connection: Connection;
  private readonly now: () => Date;

  constructor(dependencies: RestoreMembershipCheckpointDependencies = {}) {
    this.connection = dependencies.connection ?? mongoose.connection;
    this.now = dependencies.now ?? (() => new Date());
  }

  async load(
    manifestDigest: string,
  ): Promise<RestoreMembershipCheckpointState> {
    const database = this.requireDatabase();
    const document = await database
      .collection<RestoreMembershipCheckpointDocument>(
        MEMBERSHIP_CHECKPOINT_COLLECTION,
      )
      .findOne(
        { _id: checkpointDocumentId(manifestDigest) },
        { projection: { membership: 1, membershipCompleted: 1, revision: 1 } },
      );
    if (!document) {
      return Object.freeze({
        checkpoint: EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
        completed: false,
        revision: 0,
      });
    }
    const record = plainRecord(document);
    if (
      !record ||
      typeof record.membershipCompleted !== "boolean"
    ) {
      throw new RestoreRecoveryInputError("Restore membership checkpoint is invalid.");
    }
    return Object.freeze({
      checkpoint: normalizeCheckpoint(record.membership),
      completed: record.membershipCompleted,
      revision: normalizeCheckpointRevision(record.revision),
    });
  }

  async save(
    manifestDigest: string,
    state: RestoreMembershipCheckpointState,
    expectedRevision: number,
  ): Promise<void> {
    const database = this.requireDatabase();
    const checkpoint = normalizeCheckpoint(state.checkpoint);
    const revision = normalizeCheckpointRevision(state.revision);
    if (
      typeof state.completed !== "boolean" ||
      revision !== expectedRevision ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      throw new RestoreRecoveryInputError("Restore membership checkpoint is invalid.");
    }
    const now = requireNow(this.now());
    const collection = database.collection<RestoreMembershipCheckpointDocument>(
      MEMBERSHIP_CHECKPOINT_COLLECTION,
    );
    const id = checkpointDocumentId(manifestDigest);
    // Establishing the record separately lets the following compare-and-set
    // reject a competing recovery instead of overwriting its newer cursor.
    try {
      await collection.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            schemaVersion: REPORT_SCHEMA_VERSION,
            membership: EMPTY_PROGRAM_MEMBERSHIP_RECONCILIATION_CHECKPOINT,
            membershipCompleted: false,
            revision: 0,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // Concurrent upserts of the same fixed _id may produce one duplicate
      // key error; the succeeding compare-and-set below remains authoritative.
      if (!duplicateKeyError(error)) throw error;
    }
    const saved = await collection.updateOne(
      { _id: id, revision: expectedRevision },
      {
        $set: {
          schemaVersion: REPORT_SCHEMA_VERSION,
          membership: checkpoint,
          membershipCompleted: state.completed,
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
    );
    if (saved.matchedCount !== 1) {
      throw new RestoreRecoveryConcurrentRunError();
    }
  }

  private requireDatabase() {
    if (!this.connection.db) {
      throw new Error("Restore membership checkpoint requires an active MongoDB connection.");
    }
    return this.connection.db;
  }
}

interface RestoreOutboxMutationPort {
  reconcile(
    limit: number,
    options: {
      readonly session: ClientSession;
      readonly recordMetrics: false;
      readonly maxTimeMS: number;
    },
  ): Promise<{
    readonly recoveredExpiredLeases: number;
    readonly deadLetteredExhausted: number;
  }>;
}

interface RestoreOutboxStatusPort {
  countDocuments(filter: Readonly<Record<string, unknown>>): PromiseLike<number>;
}

interface RestoreOutboxAuditPort {
  recordRequiredInTransaction(
    input: Parameters<typeof AuditLogService.recordRequiredInTransaction>[0],
    session: ClientSession,
  ): Promise<void>;
}

interface RestoreOutboxIdempotencyPort {
  execute<TResponse extends IdempotencyReplayResponseDto>(input: {
    readonly scope: string;
    readonly actorKey: string;
    readonly key: string;
    readonly requestPayload: unknown;
    readonly execute: (
      session: ClientSession,
    ) => Promise<{
      readonly httpStatus: number;
      readonly response: TResponse;
    }>;
  }): Promise<{
    readonly receiptId: string;
    readonly replayed: boolean;
    readonly response?: TResponse;
  }>;
}

interface RestoreOutboxIdempotencyResponse extends IdempotencyReplayResponseDto {
  readonly operation: "restore_recovery_notification_outbox";
  readonly recoveredExpiredLeases: number;
  readonly deadLetteredExhausted: number;
}

export interface RestoreOutboxReconciliationDependencies {
  readonly outbox?: RestoreOutboxMutationPort;
  readonly status?: RestoreOutboxStatusPort;
  readonly idempotency?: RestoreOutboxIdempotencyPort;
  readonly audit?: RestoreOutboxAuditPort;
  readonly now?: () => Date;
}

/**
 * Reconciles only durable outbox state.  It never loads a delivery handler,
 * so an isolated restore can repair expired leases without sending a message.
 */
export class RestoreOutboxReconciliationService
  implements RestoreOutboxReconciliationPort
{
  private readonly outbox: RestoreOutboxMutationPort;
  private readonly status: RestoreOutboxStatusPort;
  private readonly idempotency: RestoreOutboxIdempotencyPort;
  private readonly audit: RestoreOutboxAuditPort;
  private readonly now: () => Date;

  constructor(dependencies: RestoreOutboxReconciliationDependencies = {}) {
    this.outbox = dependencies.outbox ?? notificationOutboxService;
    this.status = dependencies.status ?? NotificationOutbox;
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.audit = dependencies.audit ?? AuditLogService;
    this.now = dependencies.now ?? (() => new Date());
  }

  async reconcile(input: {
    readonly idempotencyKey: string;
    readonly correlationId?: string;
  }): Promise<RestoreOutboxReconciliationResult> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const correlationId = requireCorrelationId(input.correlationId);
    const execution = await this.idempotency.execute<RestoreOutboxIdempotencyResponse>(
      {
        scope: "operations.restore_recovery.notification_outbox",
        // The UUID is both the opaque worker identity and retry key.  It is
        // stored only as a one-way idempotency hash by the service.
        actorKey: key,
        key,
        requestPayload: {
          operation: "restore_recovery_notification_outbox",
          limit: OUTBOX_BATCH_LIMIT,
        },
        execute: async (session) => {
          const result = await this.outbox.reconcile(OUTBOX_BATCH_LIMIT, {
            session,
            recordMetrics: false,
            maxTimeMS: 1_000,
          });
          const response: RestoreOutboxIdempotencyResponse = Object.freeze({
            operation: "restore_recovery_notification_outbox",
            recoveredExpiredLeases: result.recoveredExpiredLeases,
            deadLetteredExhausted: result.deadLetteredExhausted,
          });
          await this.audit.recordRequiredInTransaction(
            {
              action: "operations.restore_recovery.notification_outbox",
              actor: { type: "system", key: RESTORE_ACCOUNT_DELETION_ACTOR_KEY },
              source: "system",
              outcome: "success",
              target: { model: "NotificationOutbox", id: "restore-recovery" },
              correlationId,
              details: {
                limit: OUTBOX_BATCH_LIMIT,
                recoveredExpiredLeases: result.recoveredExpiredLeases,
                deadLetteredExhausted: result.deadLetteredExhausted,
              },
            },
            session,
          );
          return { httpStatus: 200, response };
        },
      },
    );
    if (!execution.response) {
      throw new Error("Restore outbox reconciliation receipt is incomplete.");
    }
    const now = requireNow(this.now());
    const [expiredLeases, exhaustedAttempts] = await Promise.all([
      this.status.countDocuments(buildExpiredLeaseOutboxRecoveryFilter(now)),
      this.status.countDocuments(buildExhaustedOutboxRecoveryFilter(now)),
    ]);
    return Object.freeze({
      recoveredExpiredLeases: execution.response.recoveredExpiredLeases,
      deadLetteredExhausted: execution.response.deadLetteredExhausted,
      hasMore: expiredLeases > 0 || exhaustedAttempts > 0,
      replayed: execution.replayed,
    });
  }
}

export const restoreOutboxReconciliationService =
  new RestoreOutboxReconciliationService();

function issue(
  code: RestoreRecoveryIssue["code"],
): RestoreRecoveryIssue {
  return Object.freeze({ code });
}

/**
 * Runs exactly one recovery batch against an isolated restored database.  It
 * performs no HTTP/socket startup and does not instantiate an outbox delivery
 * worker; external notification effects remain disabled by restore isolation.
 */
export class RestoreRecoveryService {
  private readonly now: () => Date;
  private readonly transactions: TransactionCapabilityPort;
  private readonly accountDeletion: AccountDeletionRecoveryPort;
  private readonly retention: Pick<AlumniRetentionCleanupService, "runBounded">;
  private readonly outcome: Pick<AlumniOutcomeDeadlineService, "runBounded">;
  private readonly membership: Pick<
    ProgramMembershipReconciliationService,
    "runBoundedFromCheckpoint"
  >;
  private readonly membershipCheckpoints: RestoreMembershipCheckpointPort;
  private readonly outbox: RestoreOutboxReconciliationPort;
  private readonly auditRetention: AuditRetentionPort;
  private readonly ttlRetention: RestoreTtlCleanupPort;
  private readonly contexts: RestoreRecoveryWorkerContexts;

  constructor(dependencies: RestoreRecoveryServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    const accountDeletionService = new AlumniAccountDeletionService();
    this.accountDeletion =
      dependencies.accountDeletion ??
      Object.freeze({
        findExistingUserIds: defaultExistingUserIds,
        deleteAccount: accountDeletionService.deleteAccount.bind(
          accountDeletionService,
        ),
      });
    this.retention =
      dependencies.retention ??
      new AlumniRetentionCleanupService({
        maxCandidatesPerKind: RETENTION_BATCH_LIMIT,
      });
    this.outcome =
      dependencies.outcome ??
      new AlumniOutcomeDeadlineService({
        maxCandidates: OUTCOME_BATCH_LIMIT,
        runtimeWritable: async () => true,
      });
    this.membership =
      dependencies.membership ??
      (() => {
        const sync = new ProgramRoomMembershipSyncService({
          runtimeReader: RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER,
        });
        return new ProgramMembershipReconciliationService({
          limit: MEMBERSHIP_BATCH_LIMIT,
          sync,
          runtimeReader: RESTORE_RECOVERY_MEMBERSHIP_RUNTIME_READER,
        });
      })();
    this.membershipCheckpoints =
      dependencies.membershipCheckpoints ??
      new RestoreMembershipCheckpointService();
    this.outbox = dependencies.outbox ?? restoreOutboxReconciliationService;
    this.auditRetention = dependencies.auditRetention ?? AuditLog;
    this.ttlRetention = dependencies.ttlRetention ?? new RestoreTtlCleanupService();
    this.contexts = dependencies.contexts ?? defaultWorkerContexts();
  }

  async run(input: RestoreRecoveryInput): Promise<RestoreRecoveryReport> {
    const generatedAt = requireNow(this.now());
    const manifest = validateAccountDeletionManifest(
      input.accountDeletionManifest,
      generatedAt,
    );
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const correlationId = requireCorrelationId(input.correlationId);
    const capability = await this.transactions.assertTopologyCapability(true);
    if (!capability.supported) {
      throw new RestoreRecoveryTransactionTopologyError();
    }

    const accountDeletion = await this.reconcileAccountDeletion(
      manifest,
      correlationId,
    );
    if (accountDeletion.hasMore) {
      return this.report({
        generatedAt,
        capability,
        accountDeletion,
        retention: {
          ...EMPTY_RETENTION_RESULT,
          auditLogsPurged: 0,
          ttlRecordsPurged: 0,
          hasMore: false,
        },
        membership: EMPTY_MEMBERSHIP_RESULT,
        outcome: { ...EMPTY_OUTCOME_RESULT, hasMore: false },
        outbox: EMPTY_OUTBOX_RESULT,
        issues: [issue("RESTORE_ACCOUNT_DELETION_RECONCILIATION_REQUIRED")],
      });
    }

    const retentionResult = await this.retention.runBounded(
      this.contexts.createRetention(),
    );
    const auditRetention = await this.auditRetention.purgeOldAuditLogsBounded(
      TTL_BATCH_LIMIT,
      AUDIT_LOG_RETENTION_MONTHS,
    );

    const membership = await this.reconcileMembership(manifest.digest);
    const outcomeResult = await this.outcome.runBounded(
      this.contexts.createOutcome(),
    );
    const outcome = Object.freeze({
      ...outcomeResult,
      hasMore:
        outcomeResult.paused ||
        outcomeResult.racedOrUnavailable > 0 ||
        outcomeResult.remainingOverdue > 0,
    });
    const outbox = await this.outbox.reconcile({
      idempotencyKey,
      correlationId,
    });
    const ttlRetention = await this.ttlRetention.purgeBounded();
    const retention = Object.freeze({
      ...retentionResult,
      auditLogsPurged: auditRetention.deletedCount,
      ttlRecordsPurged: ttlRetention.recordsDeleted,
      hasMore:
        retentionResult.importCandidatesScanned >= RETENTION_BATCH_LIMIT ||
        retentionResult.invitationCandidatesScanned >= RETENTION_BATCH_LIMIT ||
        auditRetention.hasMore ||
        ttlRetention.hasMore,
    });

    const issues: RestoreRecoveryIssue[] = [];
    if (retention.hasMore) {
      issues.push(issue("RESTORE_RETENTION_RECOVERY_INCOMPLETE"));
    }
    if (membership.hasMore || membership.paused || membership.racedOrUnavailable > 0) {
      issues.push(issue("RESTORE_MEMBERSHIP_RECOVERY_INCOMPLETE"));
    }
    if (outcome.hasMore) {
      issues.push(issue("RESTORE_OUTCOME_RECOVERY_INCOMPLETE"));
    }
    if (outbox.hasMore) {
      issues.push(issue("RESTORE_OUTBOX_RECOVERY_INCOMPLETE"));
    }
    const report = this.report({
      generatedAt,
      capability,
      accountDeletion,
      retention,
      membership,
      outcome,
      outbox,
      issues,
    });
    return report;
  }

  private async reconcileMembership(
    manifestDigest: string,
  ): Promise<ProgramMembershipReconciliationResult> {
    const persisted = await this.membershipCheckpoints.load(manifestDigest);
    if (persisted.completed) return EMPTY_MEMBERSHIP_RESULT;
    const execution: ProgramMembershipReconciliationCheckpointRun =
      await this.membership.runBoundedFromCheckpoint(
        this.contexts.createMembership(),
        persisted.checkpoint,
      );
    const completed =
      !execution.result.paused &&
      !execution.result.hasMore &&
      execution.result.racedOrUnavailable === 0;
    await this.membershipCheckpoints.save(manifestDigest, {
      checkpoint: execution.checkpoint,
      completed,
      revision: persisted.revision,
    }, persisted.revision);
    return execution.result;
  }

  private async reconcileAccountDeletion(
    manifest: ValidatedRestoreAccountDeletionManifest,
    correlationId: string | undefined,
  ): Promise<RestoreAccountDeletionRecoveryResult> {
    const sourceIds = manifest.entries.map((entry) => entry.userId);
    const before = await this.existingManifestUsers(sourceIds);
    // The checksum remains canonicalized by user ID, but the replay itself
    // must preserve source deletion chronology: shared Help rooms use the
    // closing deletion time to establish their retention clock.
    const batch = manifest.entries
      .filter((entry) => before.has(entry.userId))
      .sort(
        (left, right) =>
          left.deletedAt.getTime() - right.deletedAt.getTime() ||
          left.userId.localeCompare(right.userId),
      )
      .slice(0, ACCOUNT_DELETION_BATCH_LIMIT);
    for (const entry of batch) {
      await this.accountDeletion.deleteAccount({
        targetUserId: entry.userId,
        actor: { type: "system", key: RESTORE_ACCOUNT_DELETION_ACTOR_KEY },
        occurredAt: entry.deletedAt,
        correlationId,
      });
    }
    const after = await this.existingManifestUsers(sourceIds);
    return Object.freeze({
      manifestEntries: manifest.entries.length,
      reconciledAccounts: batch.length,
      outstandingAccounts: after.size,
      hasMore: after.size > 0,
      manifestDigest: manifest.digest,
    });
  }

  private async existingManifestUsers(
    sourceIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const allowed = new Set(sourceIds);
    const loaded = await this.accountDeletion.findExistingUserIds(sourceIds);
    const existing = new Set<string>();
    for (const userId of loaded) {
      if (typeof userId === "string" && OBJECT_ID_PATTERN.test(userId)) {
        const normalized = userId.toLowerCase();
        if (allowed.has(normalized)) existing.add(normalized);
      }
    }
    return existing;
  }

  private report(input: RestoreRecoveryReportInput): RestoreRecoveryReport {
    const status = input.issues.length === 0 ? "completed" : "incomplete";
    return Object.freeze({
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: "restore_recovery" as const,
      generatedAt: input.generatedAt.toISOString(),
      status,
      transaction: Object.freeze({
        supported: input.capability.supported,
        topology: input.capability.topology,
      }),
      accountDeletion: input.accountDeletion,
      retention: input.retention,
      membership: input.membership,
      outcome: input.outcome,
      outbox: input.outbox,
      issues: Object.freeze([...input.issues]),
    });
  }
}
