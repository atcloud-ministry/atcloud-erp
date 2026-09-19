import { randomUUID } from "node:crypto";
import type { ClientSession, Connection } from "mongoose";
import type { Collection, Document as MongoDocument } from "mongodb";
import { MIGRATION_LEDGER_COLLECTION_NAME } from "../../migrations/constants";
import {
  MIGRATION_CHECKSUM_PATTERN,
  MIGRATION_ID_PATTERN,
  MIGRATION_ROLLBACK_REASON_CODES,
  SCHEMA_MIGRATION_STATUSES,
  isMigrationFailureCode,
  type MigrationCheckpoint,
  type MigrationCounts,
  type MigrationDefinition,
  type MigrationDirection,
  type MigrationFailureCode,
  type MigrationPlan,
  type MigrationRollbackReasonCode,
  type SchemaMigrationStatus,
} from "../../migrations/types";
import {
  MIGRATION_REGISTRY,
  validateMigrationRegistry,
} from "../../migrations/registry";
import { MongoTransactionService } from "../reliability/MongoTransactionService";
import {
  MigrationExecutionError,
  MigrationStateConflictError,
  MigrationUsageError,
} from "./MigrationErrors";
import {
  GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
  MigrationLeaseLostError,
  MigrationLeaseService,
  type MigrationLeaseHandle,
} from "./MigrationLeaseService";
import {
  ZERO_MIGRATION_COUNTS,
  addMigrationCounts,
  cloneMigrationCheckpoint,
  normalizeMigrationBatchResult,
  normalizeMigrationCounts,
  normalizeMigrationPlan,
  normalizeMigrationVerification,
  sanitizeMigrationFailure,
} from "./MigrationValidation";
import {
  createMigrationReadDatabase,
  type MigrationReadDatabase,
} from "./MigrationReadDatabase";
import {
  createMigrationTransactionDatabase,
  createMigrationTransactionReadDatabase,
} from "./MigrationTransactionDatabase";
import {
  createMigrationAdministrativeDatabase,
  type MigrationAdministrativeDatabase,
} from "./MigrationAdministrativeDatabase";

export const SCHEMA_MIGRATION_COLLECTION = MIGRATION_LEDGER_COLLECTION_NAME;

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_BATCHES = 100_000;
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_BATCH_SIZE = 10_000;
const MAX_BATCHES = 1_000_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPERATOR_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const SAFE_APP_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const STORED_MIGRATION_KEYS = [
  "_id",
  "migrationId",
  "description",
  "checksum",
  "status",
  "direction",
  "applyCheckpoint",
  "rollbackCheckpoint",
  "counts",
  "attempt",
  "runId",
  "operator",
  "appVersion",
  "runStartedAt",
  "runFinishedAt",
  "lastHeartbeatAt",
  "appliedAt",
  "rolledBackAt",
  "rollbackReasonCode",
  "lastError",
  "revision",
  "createdAt",
  "updatedAt",
] as const;
const STORED_COUNT_KEYS = [
  "examined",
  "matched",
  "modified",
  "skipped",
  "errors",
] as const;
const STORED_ERROR_KEYS = ["code", "digest", "recordedAt"] as const;

type StoredMigrationStatus = SchemaMigrationStatus;

interface StoredMigrationError {
  readonly code: MigrationFailureCode;
  readonly digest: string;
  readonly recordedAt: Date;
}

interface StoredSchemaMigration extends MongoDocument {
  readonly _id: string;
  readonly migrationId: string;
  readonly description: string;
  readonly checksum: string;
  readonly status: StoredMigrationStatus;
  readonly direction: MigrationDirection;
  readonly applyCheckpoint: MigrationCheckpoint | null;
  readonly rollbackCheckpoint: MigrationCheckpoint | null;
  readonly counts: MigrationCounts;
  readonly attempt: number;
  readonly runId: string;
  readonly operator: string;
  readonly appVersion: string;
  readonly runStartedAt: Date;
  readonly runFinishedAt: Date | null;
  readonly lastHeartbeatAt: Date;
  readonly appliedAt: Date | null;
  readonly rolledBackAt: Date | null;
  readonly rollbackReasonCode: MigrationRollbackReasonCode | null;
  readonly lastError: StoredMigrationError | null;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ReportedMigrationStatus = StoredMigrationStatus | "pending";

export interface MigrationStatusEntry {
  readonly id: string;
  readonly description: string;
  readonly checksum: string;
  readonly status: ReportedMigrationStatus;
  readonly attempt: number;
  readonly counts: MigrationCounts;
  readonly appliedAt: Date | null;
  readonly rolledBackAt: Date | null;
}

export interface MigrationStatusIssue {
  readonly code:
    | "INVALID_LEDGER_RECORD"
    | "UNKNOWN_LEDGER_VERSION"
    | "CHECKSUM_DRIFT"
    | "VERSION_GAP"
    | "MULTIPLE_RECOVERY_POINTS";
  readonly migrationId?: string;
}

export interface MigrationStatusResult {
  readonly healthy: boolean;
  readonly recoveryRequired: boolean;
  readonly appliedCount: number;
  readonly pendingCount: number;
  readonly entries: readonly MigrationStatusEntry[];
  readonly issues: readonly MigrationStatusIssue[];
}

export interface MigrationDryRunEntry {
  readonly id: string;
  readonly description: string;
  readonly plan: MigrationPlan;
}

export interface MigrationDryRunResult {
  readonly observedAt: Date;
  readonly entries: readonly MigrationDryRunEntry[];
}

export interface MigrationExecutionEntry {
  readonly id: string;
  readonly direction: MigrationDirection;
  readonly status: "applied" | "rolled_back";
  readonly attempt: number;
  readonly counts: MigrationCounts;
}

export interface MigrationExecutionResult {
  readonly runId: string | null;
  readonly entries: readonly MigrationExecutionEntry[];
}

export interface MigrationRunnerOptions {
  readonly connection: Connection;
  readonly operator: string;
  readonly appVersion: string;
  readonly leaseOwner: string;
  readonly registry?: readonly MigrationDefinition[];
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly signal?: AbortSignal;
  readonly transactionService?: MongoTransactionService;
  readonly leaseService?: MigrationLeaseService;
}

interface MigrationLeasePort {
  acquire(input: {
    readonly runId: string;
    readonly currentMigrationId?: string | null;
  }): Promise<MigrationLeaseHandle>;
  renew(handle: MigrationLeaseHandle): Promise<MigrationLeaseHandle>;
  assertHeld(
    handle: MigrationLeaseHandle,
    session?: ClientSession,
  ): Promise<MigrationLeaseHandle>;
  updateCurrentMigration(
    handle: MigrationLeaseHandle,
    currentMigrationId: string | null,
    session?: ClientSession,
  ): Promise<MigrationLeaseHandle>;
  refreshOwned(handle: MigrationLeaseHandle): Promise<MigrationLeaseHandle>;
  release(handle: MigrationLeaseHandle, session?: ClientSession): Promise<void>;
}

interface LedgerSnapshot {
  readonly records: ReadonlyMap<string, StoredSchemaMigration>;
  readonly status: MigrationStatusResult;
  readonly appliedPrefixLength: number;
  readonly recovery: StoredSchemaMigration | null;
}

interface ActiveRun {
  readonly definition: MigrationDefinition;
  readonly direction: MigrationDirection;
  readonly runId: string;
}

interface BatchCommit {
  readonly record: StoredSchemaMigration;
  readonly terminal: boolean;
  readonly lease: MigrationLeaseHandle;
}

function requirePositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new MigrationUsageError(
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function requireSingleLine(
  value: string,
  name: string,
  maximum: number,
  pattern = SAFE_OPERATOR_PATTERN,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw new MigrationUsageError(`Invalid migration ${name}.`);
  }
  return value;
}

function requireRunId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new MigrationUsageError("Migration run ID must be a UUID.");
  }
  return value;
}

function requireDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return new Date(value.getTime());
}

function cloneCounts(value: MigrationCounts): MigrationCounts {
  return { ...value };
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function isStoredStatus(value: unknown): value is StoredMigrationStatus {
  return (SCHEMA_MIGRATION_STATUSES as readonly unknown[]).includes(value);
}

function isActiveStatus(status: StoredMigrationStatus): boolean {
  return status === "applying" || status === "rolling_back";
}

function isRecoveryStatus(status: StoredMigrationStatus): boolean {
  return (
    isActiveStatus(status) ||
    status === "apply_failed" ||
    status === "rollback_failed"
  );
}

function statusDirection(status: StoredMigrationStatus): MigrationDirection {
  return status === "applying" ||
    status === "applied" ||
    status === "apply_failed"
    ? "up"
    : "down";
}

function migrationIdForIssue(value: unknown): string | undefined {
  return typeof value === "string" && MIGRATION_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function validateTarget(
  registry: readonly MigrationDefinition[],
  target: string | undefined,
): number {
  if (target === undefined) return registry.length - 1;
  const index = registry.findIndex((migration) => migration.id === target);
  if (index < 0) {
    throw new MigrationUsageError("Migration target is not registered.");
  }
  return index;
}

function failureCode(direction: MigrationDirection): string {
  return direction === "up" ? "MIGRATION_APPLY_FAILED" : "MIGRATION_ROLLBACK_FAILED";
}

function failedStatus(direction: MigrationDirection): StoredMigrationStatus {
  return direction === "up" ? "apply_failed" : "rollback_failed";
}

function runningStatus(direction: MigrationDirection): StoredMigrationStatus {
  return direction === "up" ? "applying" : "rolling_back";
}

function completedStatus(direction: MigrationDirection): StoredMigrationStatus {
  return direction === "up" ? "applied" : "rolled_back";
}

/**
 * Runs explicitly registered migrations in bounded MongoDB transactions.
 * Domain writes, lease fencing, verification of the terminal batch, and the
 * durable checkpoint/status update commit together.
 */
export class MigrationRunner {
  private readonly connection: Connection;
  private readonly operator: string;
  private readonly appVersion: string;
  private readonly registry: readonly MigrationDefinition[];
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly now: () => Date;
  private readonly createRunId: () => string;
  private readonly signal?: AbortSignal;
  private readonly transactionService: MongoTransactionService;
  private readonly leaseService: MigrationLeasePort;
  private readonly ledger: Collection<StoredSchemaMigration>;
  private readonly readDatabase: MigrationReadDatabase;
  private readonly administrativeDatabase: MigrationAdministrativeDatabase;

  constructor(options: MigrationRunnerOptions) {
    if (!options?.connection?.db) {
      throw new MigrationUsageError(
        "MongoDB connection is not ready for migrations.",
      );
    }
    this.connection = options.connection;
    this.operator = requireSingleLine(options.operator, "operator", 128);
    this.appVersion = requireSingleLine(
      options.appVersion,
      "appVersion",
      80,
      SAFE_APP_VERSION_PATTERN,
    );
    requireSingleLine(options.leaseOwner, "lease owner", 128);
    this.registry = Object.freeze([...(options.registry ?? MIGRATION_REGISTRY)]);
    try {
      validateMigrationRegistry(this.registry);
    } catch (error) {
      throw new MigrationUsageError("Migration registry is invalid.", error);
    }
    this.batchSize = requirePositiveInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      "Migration batchSize",
      MAX_BATCH_SIZE,
    );
    this.maxBatches = requirePositiveInteger(
      options.maxBatches ?? DEFAULT_MAX_BATCHES,
      "Migration maxBatches",
      MAX_BATCHES,
    );
    this.now = options.now ?? (() => new Date());
    this.createRunId = options.createRunId ?? randomUUID;
    this.signal = options.signal;
    this.transactionService =
      options.transactionService ?? new MongoTransactionService(this.connection);
    this.leaseService =
      options.leaseService ??
      new MigrationLeaseService(this.connection, {
        owner: options.leaseOwner,
        leaseDurationMs:
          options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      });
    this.ledger = options.connection.db.collection<StoredSchemaMigration>(
      SCHEMA_MIGRATION_COLLECTION,
    );
    this.readDatabase = createMigrationReadDatabase(options.connection);
    this.administrativeDatabase =
      createMigrationAdministrativeDatabase(options.connection);
  }

  async status(): Promise<MigrationStatusResult> {
    return (await this.readLedgerSnapshot()).status;
  }

  async dryRun(target?: string): Promise<MigrationDryRunResult> {
    const observedAt = this.readNow();
    const targetIndex = validateTarget(this.registry, target);
    const snapshot = await this.readLedgerSnapshot();
    this.assertHealthy(snapshot);
    if (snapshot.recovery) {
      throw new MigrationStateConflictError(
        "A migration requires explicit resume or rollback before dry-run.",
      );
    }

    const entries: MigrationDryRunEntry[] = [];
    for (
      let index = snapshot.appliedPrefixLength;
      index <= targetIndex;
      index += 1
    ) {
      this.assertNotAborted();
      const definition = this.registry[index];
      if (!definition) continue;
      const plan = normalizeMigrationPlan(
        await definition.plan({
          database: this.readDatabase,
          batchSize: this.batchSize,
          ...(this.signal ? { signal: this.signal } : {}),
        }),
      );
      entries.push({
        id: definition.id,
        description: definition.description,
        plan,
      });
    }

    return { observedAt, entries };
  }

  async apply(target?: string): Promise<MigrationExecutionResult> {
    const targetIndex = validateTarget(this.registry, target);
    const initial = await this.readLedgerSnapshot();
    this.assertHealthy(initial);
    if (initial.recovery) {
      throw new MigrationStateConflictError(
        "A migration requires explicit resume or rollback before apply.",
      );
    }

    return this.withLease<MigrationExecutionResult>(
      async (runId, initialLease) => {
        let lease = initialLease;
        const entries: MigrationExecutionEntry[] = [];
        const snapshot = await this.readLedgerSnapshot();
        this.assertHealthy(snapshot);
        if (snapshot.recovery) {
          throw new MigrationStateConflictError(
            "A migration requires explicit resume or rollback before apply.",
          );
        }
        if (targetIndex < snapshot.appliedPrefixLength) {
          return {
            result: { runId: null, entries: [] },
            lease,
          };
        }

        for (
          let index = snapshot.appliedPrefixLength;
          index <= targetIndex;
          index += 1
        ) {
          const definition = this.registry[index];
          if (!definition) continue;
          this.assertNotAborted();
          lease = await this.leaseService.updateCurrentMigration(
            lease,
            definition.id,
          );
          const record = await this.beginApply(definition, runId);
          const execution = await this.executeMigration(
            { definition, direction: "up", runId },
            record,
            lease,
          );
          lease = execution.lease;
          entries.push(execution.entry);
        }
        return { result: { runId, entries }, lease };
      },
    );
  }

  async resume(migrationId?: string): Promise<MigrationExecutionResult> {
    return this.withLease(async (runId, initialLease) => {
      let lease = initialLease;
      const snapshot = await this.readLedgerSnapshot();
      this.assertHealthy(snapshot);
      const recovery = snapshot.recovery;
      if (!recovery) {
        throw new MigrationStateConflictError(
          "There is no interrupted or failed migration to resume.",
        );
      }
      if (migrationId !== undefined && migrationId !== recovery.migrationId) {
        throw new MigrationStateConflictError(
          "The requested migration is not the current recovery point.",
        );
      }
      const definition = this.definitionById(recovery.migrationId);
      const direction = recovery.direction;
      lease = await this.leaseService.updateCurrentMigration(
        lease,
        definition.id,
      );
      const record = await this.beginResume(recovery, runId);
      const execution = await this.executeMigration(
        { definition, direction, runId },
        record,
        lease,
      );
      return {
        result: { runId, entries: [execution.entry] },
        lease: execution.lease,
      };
    });
  }

  async rollback(
    migrationId: string,
    reasonCode: MigrationRollbackReasonCode,
  ): Promise<MigrationExecutionResult> {
    if (!MIGRATION_ID_PATTERN.test(migrationId)) {
      throw new MigrationUsageError("Invalid rollback migration ID.");
    }
    if (
      !(MIGRATION_ROLLBACK_REASON_CODES as readonly unknown[]).includes(
        reasonCode,
      )
    ) {
      throw new MigrationUsageError("Invalid migration rollback reason code.");
    }

    return this.withLease(async (runId, initialLease) => {
      let lease = initialLease;
      const snapshot = await this.readLedgerSnapshot();
      this.assertHealthy(snapshot);
      const target = this.rollbackTarget(snapshot, migrationId);
      const definition = this.definitionById(target.migrationId);
      lease = await this.leaseService.updateCurrentMigration(
        lease,
        definition.id,
      );
      const record = await this.beginRollback(
        target,
        runId,
        reasonCode,
      );
      const execution = await this.executeMigration(
        { definition, direction: "down", runId },
        record,
        lease,
      );
      return {
        result: { runId, entries: [execution.entry] },
        lease: execution.lease,
      };
    });
  }

  private readNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new MigrationUsageError("Migration clock returned an invalid Date.");
    }
    return new Date(value.getTime());
  }

  private readNowAtOrAfter(
    ...minimums: readonly (Date | null | undefined)[]
  ): Date {
    const now = this.readNow();
    let timestamp = now.getTime();
    for (const minimum of minimums) {
      if (minimum === null || minimum === undefined) continue;
      const validMinimum = requireDate(minimum);
      if (!validMinimum) {
        throw new MigrationStateConflictError(
          "Migration ledger contains an invalid timestamp.",
        );
      }
      timestamp = Math.max(timestamp, validMinimum.getTime());
    }
    return new Date(timestamp);
  }

  private assertNotAborted(): void {
    if (this.signal?.aborted) {
      throw new MigrationExecutionError("Migration execution was interrupted.");
    }
  }

  private definitionById(id: string): MigrationDefinition {
    const definition = this.registry.find((candidate) => candidate.id === id);
    if (!definition) {
      throw new MigrationStateConflictError(
        "Migration ledger references an unknown version.",
      );
    }
    return definition;
  }

  private async readLedgerSnapshot(): Promise<LedgerSnapshot> {
    const rawRecords = await this.ledger.find({}).sort({ _id: 1 }).toArray();
    const records = new Map<string, StoredSchemaMigration>();
    const issues: MigrationStatusIssue[] = [];

    for (const raw of rawRecords) {
      const id = migrationIdForIssue(raw._id);
      if (!id || !this.isValidStoredRecord(raw)) {
        issues.push({
          code: "INVALID_LEDGER_RECORD",
          ...(id ? { migrationId: id } : {}),
        });
        continue;
      }
      records.set(id, raw);
      const definition = this.registry.find((candidate) => candidate.id === id);
      if (!definition) {
        issues.push({ code: "UNKNOWN_LEDGER_VERSION", migrationId: id });
      } else if (definition.checksum !== raw.checksum) {
        issues.push({ code: "CHECKSUM_DRIFT", migrationId: id });
      }
    }

    let appliedPrefixLength = 0;
    while (
      appliedPrefixLength < this.registry.length &&
      records.get(this.registry[appliedPrefixLength]!.id)?.status === "applied"
    ) {
      appliedPrefixLength += 1;
    }

    const recoveryRecords: StoredSchemaMigration[] = [];
    for (let index = 0; index < this.registry.length; index += 1) {
      const definition = this.registry[index]!;
      const record = records.get(definition.id);
      if (!record) continue;
      if (record.status === "applied" && index >= appliedPrefixLength) {
        issues.push({ code: "VERSION_GAP", migrationId: definition.id });
      }
      if (isRecoveryStatus(record.status)) {
        recoveryRecords.push(record);
        if (index !== appliedPrefixLength) {
          issues.push({ code: "VERSION_GAP", migrationId: definition.id });
        }
      }
    }

    let encounteredMissing = false;
    for (
      let index = appliedPrefixLength;
      index < this.registry.length;
      index += 1
    ) {
      const definition = this.registry[index]!;
      const record = records.get(definition.id);
      if (!record) {
        encounteredMissing = true;
      } else if (encounteredMissing) {
        issues.push({ code: "VERSION_GAP", migrationId: definition.id });
      }
    }
    if (recoveryRecords.length > 1) {
      issues.push({ code: "MULTIPLE_RECOVERY_POINTS" });
    }

    const entries = this.registry.map<MigrationStatusEntry>((definition) => {
      const record = records.get(definition.id);
      return {
        id: definition.id,
        description: definition.description,
        checksum: definition.checksum,
        status: record?.status ?? "pending",
        attempt: record?.attempt ?? 0,
        counts: cloneCounts(record?.counts ?? ZERO_MIGRATION_COUNTS),
        appliedAt: requireDate(record?.appliedAt),
        rolledBackAt: requireDate(record?.rolledBackAt),
      };
    });
    const pendingCount = entries.filter(
      (entry) => entry.status !== "applied",
    ).length;
    const status: MigrationStatusResult = {
      healthy: issues.length === 0 && recoveryRecords.length === 0,
      recoveryRequired: recoveryRecords.length > 0,
      appliedCount: appliedPrefixLength,
      pendingCount,
      entries,
      issues,
    };
    return {
      records,
      status,
      appliedPrefixLength,
      recovery:
        recoveryRecords.length === 1 ? recoveryRecords[0]! : null,
    };
  }

  private isValidStoredRecord(
    value: StoredSchemaMigration,
  ): value is StoredSchemaMigration {
    try {
      if (
        !hasExactKeys(value, STORED_MIGRATION_KEYS) ||
        typeof value._id !== "string" ||
        value.migrationId !== value._id ||
        !MIGRATION_ID_PATTERN.test(value._id) ||
        !MIGRATION_CHECKSUM_PATTERN.test(value.checksum) ||
        !isStoredStatus(value.status) ||
        value.direction !== statusDirection(value.status) ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt < 1 ||
        !UUID_PATTERN.test(value.runId) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        typeof value.description !== "string" ||
        value.description.length < 1 ||
        value.description.length > 240 ||
        value.description.trim() !== value.description ||
        !SAFE_OPERATOR_PATTERN.test(value.description) ||
        typeof value.operator !== "string" ||
        value.operator.length < 1 ||
        value.operator.length > 128 ||
        value.operator.trim() !== value.operator ||
        !SAFE_OPERATOR_PATTERN.test(value.operator) ||
        typeof value.appVersion !== "string" ||
        value.appVersion.length > 80 ||
        !SAFE_APP_VERSION_PATTERN.test(value.appVersion) ||
        !requireDate(value.runStartedAt) ||
        !requireDate(value.lastHeartbeatAt) ||
        !requireDate(value.createdAt) ||
        !requireDate(value.updatedAt)
      ) {
        return false;
      }
      if (!hasExactKeys(value.counts, STORED_COUNT_KEYS)) return false;
      const counts = normalizeMigrationCounts(value.counts);
      if (counts.errors !== 0) return false;
      cloneMigrationCheckpoint(value.applyCheckpoint);
      cloneMigrationCheckpoint(value.rollbackCheckpoint);

      const runStartedAt = requireDate(value.runStartedAt)!;
      const lastHeartbeatAt = requireDate(value.lastHeartbeatAt)!;
      const createdAt = requireDate(value.createdAt)!;
      const updatedAt = requireDate(value.updatedAt)!;
      const runFinishedAt = requireDate(value.runFinishedAt);
      const appliedAt = requireDate(value.appliedAt);
      const rolledBackAt = requireDate(value.rolledBackAt);
      if (
        lastHeartbeatAt < runStartedAt ||
        updatedAt < createdAt ||
        updatedAt < lastHeartbeatAt ||
        (runFinishedAt !== null &&
          (runFinishedAt < runStartedAt || runFinishedAt < lastHeartbeatAt)) ||
        (appliedAt !== null && (appliedAt < createdAt || appliedAt > updatedAt)) ||
        (rolledBackAt !== null &&
          (rolledBackAt < createdAt || rolledBackAt > updatedAt))
      ) {
        return false;
      }
      const terminal = !isActiveStatus(value.status);
      if (terminal !== Boolean(runFinishedAt)) return false;
      if (value.status === "applied" && !appliedAt) return false;
      if ((value.status === "rolled_back") !== Boolean(rolledBackAt)) return false;
      const failed =
        value.status === "apply_failed" || value.status === "rollback_failed";
      if (failed !== Boolean(value.lastError)) return false;
      if (
        value.lastError &&
        (!hasExactKeys(value.lastError, STORED_ERROR_KEYS) ||
          !isMigrationFailureCode(value.lastError.code) ||
          !MIGRATION_CHECKSUM_PATTERN.test(value.lastError.digest) ||
          !requireDate(value.lastError.recordedAt) ||
          value.lastError.recordedAt < runStartedAt ||
          value.lastError.recordedAt > updatedAt)
      ) {
        return false;
      }
      if (
        value.rollbackReasonCode !== null &&
        !(MIGRATION_ROLLBACK_REASON_CODES as readonly unknown[]).includes(
          value.rollbackReasonCode,
        )
      ) {
        return false;
      }
      if ((value.direction === "down") !== Boolean(value.rollbackReasonCode)) {
        return false;
      }
      if (value.direction === "up" && value.rollbackCheckpoint !== null) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private assertHealthy(snapshot: LedgerSnapshot): void {
    if (snapshot.status.issues.length > 0) {
      throw new MigrationStateConflictError(
        "Migration ledger is inconsistent with the registered code.",
      );
    }
  }

  private rollbackTarget(
    snapshot: LedgerSnapshot,
    migrationId: string,
  ): StoredSchemaMigration {
    if (snapshot.recovery) {
      if (
        snapshot.recovery.migrationId !== migrationId ||
        !["applying", "apply_failed"].includes(snapshot.recovery.status)
      ) {
        throw new MigrationStateConflictError(
          "The current recovery point must be resumed before rollback.",
        );
      }
      return snapshot.recovery;
    }

    if (snapshot.appliedPrefixLength < 1) {
      throw new MigrationStateConflictError(
        "There is no applied migration to roll back.",
      );
    }
    const expected = this.registry[snapshot.appliedPrefixLength - 1]!;
    if (expected.id !== migrationId) {
      throw new MigrationStateConflictError(
        "Only the latest applied migration can be rolled back.",
      );
    }
    const record = snapshot.records.get(expected.id);
    if (!record || record.status !== "applied") {
      throw new MigrationStateConflictError(
        "The latest migration ledger record is not applied.",
      );
    }
    return record;
  }

  private async beginApply(
    definition: MigrationDefinition,
    runId: string,
  ): Promise<StoredSchemaMigration> {
    const existing = await this.ledger.findOne({ _id: definition.id });
    if (!existing) {
      const now = this.readNow();
      const document: StoredSchemaMigration = {
        _id: definition.id,
        migrationId: definition.id,
        description: definition.description,
        checksum: definition.checksum,
        status: "applying",
        direction: "up",
        applyCheckpoint: null,
        rollbackCheckpoint: null,
        counts: cloneCounts(ZERO_MIGRATION_COUNTS),
        attempt: 1,
        runId,
        operator: this.operator,
        appVersion: this.appVersion,
        runStartedAt: now,
        runFinishedAt: null,
        lastHeartbeatAt: now,
        appliedAt: null,
        rolledBackAt: null,
        rollbackReasonCode: null,
        lastError: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.ledger.insertOne(document, {
          writeConcern: { w: "majority" },
        });
      } catch (error) {
        throw new MigrationStateConflictError(
          "Migration ledger changed while apply was starting.",
          error,
        );
      }
      return document;
    }

    if (
      !this.isValidStoredRecord(existing) ||
      existing.status !== "rolled_back" ||
      existing.checksum !== definition.checksum
    ) {
      throw new MigrationStateConflictError(
        "Migration is not eligible for apply.",
      );
    }
    const now = this.readNowAtOrAfter(
      existing.createdAt,
      existing.updatedAt,
      existing.lastHeartbeatAt,
      existing.runFinishedAt,
      existing.appliedAt,
      existing.rolledBackAt,
    );
    const result = await this.ledger.findOneAndUpdate(
      {
        _id: definition.id,
        status: "rolled_back",
        checksum: definition.checksum,
        revision: existing.revision,
      },
      {
        $set: {
          status: "applying",
          direction: "up",
          applyCheckpoint: null,
          rollbackCheckpoint: null,
          counts: cloneCounts(ZERO_MIGRATION_COUNTS),
          runId,
          operator: this.operator,
          appVersion: this.appVersion,
          runStartedAt: now,
          runFinishedAt: null,
          lastHeartbeatAt: now,
          appliedAt: null,
          rolledBackAt: null,
          rollbackReasonCode: null,
          lastError: null,
          updatedAt: now,
        },
        $inc: { attempt: 1, revision: 1 },
      },
      { returnDocument: "after", writeConcern: { w: "majority" } },
    );
    if (!result) {
      throw new MigrationStateConflictError(
        "Migration ledger changed while apply was starting.",
      );
    }
    return result;
  }

  private async beginResume(
    existing: StoredSchemaMigration,
    runId: string,
  ): Promise<StoredSchemaMigration> {
    if (!isRecoveryStatus(existing.status)) {
      throw new MigrationStateConflictError(
        "Migration is not eligible for resume.",
      );
    }
    const direction = existing.direction;
    const now = this.readNowAtOrAfter(
      existing.createdAt,
      existing.updatedAt,
      existing.lastHeartbeatAt,
      existing.runFinishedAt,
      existing.appliedAt,
      existing.rolledBackAt,
    );
    const result = await this.ledger.findOneAndUpdate(
      {
        _id: existing.migrationId,
        checksum: existing.checksum,
        status: existing.status,
        revision: existing.revision,
      },
      {
        $set: {
          status: runningStatus(direction),
          direction,
          runId,
          operator: this.operator,
          appVersion: this.appVersion,
          runStartedAt: now,
          runFinishedAt: null,
          lastHeartbeatAt: now,
          lastError: null,
          updatedAt: now,
        },
        $inc: { attempt: 1, revision: 1 },
      },
      { returnDocument: "after", writeConcern: { w: "majority" } },
    );
    if (!result) {
      throw new MigrationStateConflictError(
        "Migration ledger changed while resume was starting.",
      );
    }
    return result;
  }

  private async beginRollback(
    existing: StoredSchemaMigration,
    runId: string,
    reasonCode: MigrationRollbackReasonCode,
  ): Promise<StoredSchemaMigration> {
    const now = this.readNowAtOrAfter(
      existing.createdAt,
      existing.updatedAt,
      existing.lastHeartbeatAt,
      existing.runFinishedAt,
      existing.appliedAt,
      existing.rolledBackAt,
    );
    const result = await this.ledger.findOneAndUpdate(
      {
        _id: existing.migrationId,
        checksum: existing.checksum,
        status: existing.status,
        revision: existing.revision,
      },
      {
        $set: {
          status: "rolling_back",
          direction: "down",
          rollbackCheckpoint: null,
          rollbackReasonCode: reasonCode,
          counts: cloneCounts(ZERO_MIGRATION_COUNTS),
          runId,
          operator: this.operator,
          appVersion: this.appVersion,
          runStartedAt: now,
          runFinishedAt: null,
          lastHeartbeatAt: now,
          rolledBackAt: null,
          lastError: null,
          updatedAt: now,
        },
        $inc: { attempt: 1, revision: 1 },
      },
      { returnDocument: "after", writeConcern: { w: "majority" } },
    );
    if (!result) {
      throw new MigrationStateConflictError(
        "Migration ledger changed while rollback was starting.",
      );
    }
    return result;
  }

  private async executeMigration(
    run: ActiveRun,
    initialRecord: StoredSchemaMigration,
    initialLease: MigrationLeaseHandle,
  ): Promise<{
    readonly entry: MigrationExecutionEntry;
    readonly lease: MigrationLeaseHandle;
  }> {
    let record = initialRecord;
    let lease = initialLease;
    const expectedRunningStatus = runningStatus(run.direction);

    for (let batch = 1; batch <= this.maxBatches; batch += 1) {
      this.assertNotAborted();
      lease = await this.leaseService.renew(lease);
      const revisionBefore = record.revision;

      try {
        if (run.definition.prepare) {
          await run.definition.prepare({
            database: this.administrativeDatabase,
            direction: run.direction,
            ...(this.signal ? { signal: this.signal } : {}),
          });
          this.assertNotAborted();
        }
        const commit = await this.commitBatch(run, record, lease);
        record = commit.record;
        lease = commit.lease;
        if (commit.terminal) {
          return {
            entry: {
              id: record.migrationId,
              direction: run.direction,
              status: completedStatus(run.direction) as
                | "applied"
                | "rolled_back",
              attempt: record.attempt,
              counts: cloneCounts(record.counts),
            },
            lease,
          };
        }
      } catch (error) {
        const reconciled = await this.reconcileAfterBatchError(
          run,
          revisionBefore,
          error,
        );
        if (reconciled?.status === completedStatus(run.direction)) {
          lease = await this.leaseService.refreshOwned(lease);
          return {
            entry: {
              id: reconciled.migrationId,
              direction: run.direction,
              status: completedStatus(run.direction) as
                | "applied"
                | "rolled_back",
              attempt: reconciled.attempt,
              counts: cloneCounts(reconciled.counts),
            },
            lease,
          };
        }
        if (
          reconciled?.runId === run.runId &&
          reconciled.status === expectedRunningStatus &&
          reconciled.revision > revisionBefore
        ) {
          lease = await this.leaseService.refreshOwned(lease);
          record = reconciled;
          continue;
        }
        throw new MigrationExecutionError(
          `Migration ${run.definition.id} failed with code ${failureCode(run.direction)}.`,
          error,
        );
      }
    }

    const limitError = new MigrationExecutionError(
      "Migration exceeded the configured batch limit.",
    );
    await this.markFailed(run, limitError);
    throw limitError;
  }

  private async commitBatch(
    run: ActiveRun,
    record: StoredSchemaMigration,
    lease: MigrationLeaseHandle,
  ): Promise<BatchCommit> {
    return this.transactionService.run(async (session) => {
      let transactionLease = await this.leaseService.assertHeld(lease, session);
      const current = await this.ledger.findOne(
        {
          _id: run.definition.id,
          checksum: run.definition.checksum,
          status: runningStatus(run.direction),
          direction: run.direction,
          runId: run.runId,
          revision: record.revision,
        },
        { session },
      );
      if (!current || !this.isValidStoredRecord(current)) {
        throw new MigrationStateConflictError(
          "Migration checkpoint changed during batch execution.",
        );
      }

      const operation =
        run.direction === "up" ? run.definition.up : run.definition.down;
      const currentCheckpoint =
        run.direction === "up"
          ? current.applyCheckpoint
          : current.rollbackCheckpoint;
      const result = normalizeMigrationBatchResult(
        await operation({
          database: createMigrationTransactionDatabase(
            this.connection,
            session,
          ),
          runId: run.runId,
          direction: run.direction,
          checkpoint: cloneMigrationCheckpoint(currentCheckpoint),
          appliedCheckpoint: cloneMigrationCheckpoint(
            current.applyCheckpoint,
          ),
          batchSize: this.batchSize,
          ...(this.signal ? { signal: this.signal } : {}),
        }),
        currentCheckpoint,
      );
      const counts = addMigrationCounts(
        normalizeMigrationCounts(current.counts),
        result.counts,
      );
      const now = this.readNowAtOrAfter(
        current.createdAt,
        current.updatedAt,
        current.runStartedAt,
        current.lastHeartbeatAt,
        current.runFinishedAt,
        current.appliedAt,
        current.rolledBackAt,
      );
      const status = result.done
        ? completedStatus(run.direction)
        : runningStatus(run.direction);

      if (result.done) {
        const verification = normalizeMigrationVerification(
          await run.definition.verify({
            database: createMigrationTransactionReadDatabase(
              this.connection,
              session,
            ),
            direction: run.direction,
            checkpoint: result.checkpoint,
            appliedCheckpoint:
              run.direction === "up"
                ? result.checkpoint
                : cloneMigrationCheckpoint(current.applyCheckpoint),
            batchSize: this.batchSize,
            ...(this.signal ? { signal: this.signal } : {}),
          }),
        );
        if (!verification.ok || verification.counts.errors !== 0) {
          throw new MigrationExecutionError(
            "Migration postcondition verification failed.",
          );
        }
      }

      transactionLease = await this.leaseService.assertHeld(
        transactionLease,
        session,
      );
      const update = await this.ledger.findOneAndUpdate(
        {
          _id: run.definition.id,
          checksum: run.definition.checksum,
          status: runningStatus(run.direction),
          direction: run.direction,
          runId: run.runId,
          revision: current.revision,
        },
        {
          $set: {
            status,
            ...(run.direction === "up"
              ? { applyCheckpoint: result.checkpoint }
              : { rollbackCheckpoint: result.checkpoint }),
            counts,
            lastHeartbeatAt: now,
            runFinishedAt: result.done ? now : null,
            lastError: null,
            updatedAt: now,
            ...(run.direction === "up" && result.done
              ? { appliedAt: now, rolledBackAt: null }
              : {}),
            ...(run.direction === "down" && result.done
              ? { rolledBackAt: now }
              : {}),
          },
          $inc: { revision: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!update) {
        throw new MigrationStateConflictError(
          "Migration checkpoint compare-and-set failed.",
        );
      }
      return {
        record: update,
        terminal: result.done,
        lease: transactionLease,
      };
    });
  }

  private async reconcileAfterBatchError(
    run: ActiveRun,
    revisionBefore: number,
    error: unknown,
  ): Promise<StoredSchemaMigration | null> {
    let current: StoredSchemaMigration | null;
    try {
      current = await this.ledger.findOne({ _id: run.definition.id });
    } catch {
      return null;
    }

    if (
      current?.runId === run.runId &&
      current.revision > revisionBefore &&
      (current.status === runningStatus(run.direction) ||
        current.status === completedStatus(run.direction))
    ) {
      return current;
    }
    await this.markFailed(run, error);
    return null;
  }

  private async markFailed(run: ActiveRun, error: unknown): Promise<void> {
    const selector = {
      _id: run.definition.id,
      checksum: run.definition.checksum,
      status: runningStatus(run.direction),
      direction: run.direction,
      runId: run.runId,
    } as const;
    const current = await this.ledger.findOne(selector);
    if (!current || !this.isValidStoredRecord(current)) return;
    const now = this.readNowAtOrAfter(
      current.createdAt,
      current.updatedAt,
      current.runStartedAt,
      current.lastHeartbeatAt,
      current.appliedAt,
      current.rolledBackAt,
    );
    const failure = sanitizeMigrationFailure(error, failureCode(run.direction));
    await this.ledger.updateOne(
      {
        ...selector,
        revision: current.revision,
      },
      {
        $set: {
          status: failedStatus(run.direction),
          runFinishedAt: now,
          lastHeartbeatAt: now,
          lastError: {
            code: failure.code,
            digest: failure.digest,
            recordedAt: now,
          },
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { writeConcern: { w: "majority" } },
    );
  }

  private async withLease<T>(
    operation: (
      runId: string,
      lease: MigrationLeaseHandle,
    ) => Promise<{
      readonly result: T;
      readonly lease: MigrationLeaseHandle;
    }>,
  ): Promise<T> {
    this.assertNotAborted();
    await this.transactionService.assertTopologyCapability();
    const runId = requireRunId(this.createRunId());
    let lease = await this.leaseService.acquire({ runId });
    let operationError: unknown;
    try {
      const completed = await operation(runId, lease);
      lease = completed.lease;
      return completed.result;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        const currentLease = await this.leaseService.refreshOwned(lease);
        await this.leaseService.release(currentLease);
      } catch (releaseError) {
        if (
          operationError === undefined &&
          !(releaseError instanceof MigrationLeaseLostError)
        ) {
          throw releaseError;
        }
      }
    }
  }
}

export function migrationLockIdentity(): string {
  return GLOBAL_SCHEMA_MIGRATION_LOCK_ID;
}
