import type { QueryOptions } from "mongoose";
import { MIGRATION_REGISTRY } from "../../migrations/registry";
import type { MigrationDefinition } from "../../migrations/types";
import SchemaMigration from "../../models/SchemaMigration";

export const MIGRATION_READINESS_TIMEOUT_MS = 1_500;

export type MigrationReadinessIssueCode =
  | "LEDGER_READ_FAILED"
  | "INVALID_LEDGER_RECORD"
  | "UNKNOWN_LEDGER_VERSION"
  | "CHECKSUM_DRIFT"
  | "PENDING_MIGRATION"
  | "VERSION_GAP"
  | "RECOVERY_REQUIRED";

export interface MigrationReadinessSnapshot {
  readonly ready: boolean;
  readonly appliedCount: number;
  readonly requiredCount: number;
  readonly issues: readonly MigrationReadinessIssueCode[];
}

type MigrationLedgerRecord = Readonly<{
  _id?: unknown;
  migrationId?: unknown;
  checksum?: unknown;
  status?: unknown;
}>;

export interface MigrationReadinessServiceDependencies {
  readonly registry?: readonly MigrationDefinition[];
  readonly readLedger?: (
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<readonly MigrationLedgerRecord[]>;
  readonly timeoutMs?: number;
}

export class MigrationReadinessError extends Error {
  readonly name = "MigrationReadinessError";
  readonly code = "ALUMNI_NETWORK_MIGRATIONS_NOT_READY";

  constructor() {
    super("Required schema migrations are not ready.");
  }
}

async function readProductionLedger(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<readonly MigrationLedgerRecord[]> {
  const options: QueryOptions = { maxTimeMS: timeoutMs, signal };
  return SchemaMigration.find(
    {},
    { _id: 1, migrationId: 1, checksum: 1, status: 1 },
    options,
  )
    .lean<MigrationLedgerRecord[]>()
    .exec();
}

function inspectLedger(
  registry: readonly MigrationDefinition[],
  records: readonly MigrationLedgerRecord[],
): MigrationReadinessSnapshot {
  const issues = new Set<MigrationReadinessIssueCode>();
  const byId = new Map<string, MigrationLedgerRecord>();
  const definitions = new Map(registry.map((definition) => [definition.id, definition]));

  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      issues.add("INVALID_LEDGER_RECORD");
      continue;
    }
    const id = typeof record._id === "string" ? record._id : null;
    if (!id || record.migrationId !== id || byId.has(id)) {
      issues.add("INVALID_LEDGER_RECORD");
      continue;
    }
    const definition = definitions.get(id);
    if (!definition) {
      issues.add("UNKNOWN_LEDGER_VERSION");
      continue;
    }
    byId.set(id, record);
    if (record.checksum !== definition.checksum) issues.add("CHECKSUM_DRIFT");
    if (record.status !== "applied") {
      issues.add("PENDING_MIGRATION");
      if (
        record.status === "applying" ||
        record.status === "apply_failed" ||
        record.status === "rolling_back" ||
        record.status === "rollback_failed"
      ) {
        issues.add("RECOVERY_REQUIRED");
      }
    }
  }

  let appliedCount = 0;
  let prefixComplete = true;
  for (const definition of registry) {
    const record = byId.get(definition.id);
    const applied =
      record?.status === "applied" && record.checksum === definition.checksum;
    if (applied) {
      appliedCount += 1;
      if (!prefixComplete) issues.add("VERSION_GAP");
    } else {
      prefixComplete = false;
      issues.add("PENDING_MIGRATION");
    }
  }

  return Object.freeze({
    ready: issues.size === 0 && appliedCount === registry.length,
    appliedCount,
    requiredCount: registry.length,
    issues: Object.freeze([...issues]),
  });
}

export class MigrationReadinessService {
  private readonly registry: readonly MigrationDefinition[];
  private readonly readLedger: (
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<readonly MigrationLedgerRecord[]>;
  private readonly timeoutMs: number;

  constructor(dependencies: MigrationReadinessServiceDependencies = {}) {
    this.registry = Object.freeze([...(dependencies.registry ?? MIGRATION_REGISTRY)]);
    this.readLedger = dependencies.readLedger ?? readProductionLedger;
    this.timeoutMs = dependencies.timeoutMs ?? MIGRATION_READINESS_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Migration readiness timeout is invalid.");
    }
  }

  async getSnapshot(options: { readonly signal?: AbortSignal } = {}): Promise<MigrationReadinessSnapshot> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    try {
      signal.throwIfAborted();
      const records = await this.readLedger(signal, this.timeoutMs);
      signal.throwIfAborted();
      return inspectLedger(this.registry, records);
    } catch {
      return Object.freeze({
        ready: false,
        appliedCount: 0,
        requiredCount: this.registry.length,
        issues: Object.freeze([
          "LEDGER_READ_FAILED" as MigrationReadinessIssueCode,
        ]),
      });
    }
  }

  async assertReady(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (!(await this.getSnapshot(options)).ready) {
      throw new MigrationReadinessError();
    }
  }
}

export const migrationReadinessService = new MigrationReadinessService();
