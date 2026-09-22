import mongoose from "mongoose";
import type {
  Collection,
  Document as MongoDocument,
  Filter,
  UpdateFilter,
} from "mongodb";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  MigrationBatchContext,
  MigrationCounts,
  MigrationDefinition,
  MigrationDirection,
  MigrationPlanContext,
  MigrationVerificationContext,
} from "../../src/migrations/types";
import {
  SCHEMA_MIGRATION_COLLECTION,
  MigrationRunner,
} from "../../src/services/migrations/MigrationRunner";
import {
  MigrationLeaseContentionError,
  MigrationLeaseLostError,
  MigrationLeaseService,
  SCHEMA_MIGRATION_LOCK_COLLECTION,
} from "../../src/services/migrations/MigrationLeaseService";
import {
  MongoTransactionCommitUncertainError,
  MongoTransactionService,
} from "../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../integration/setup/connect";

const FIXTURE_COLLECTION = "migration_runner_test_fixtures";
const FIRST_MIGRATION_ID = "20260909_001_fixture-one";
const SECOND_MIGRATION_ID = "20260909_002_fixture-two";
const UNKNOWN_MIGRATION_ID = "20260909_099_unknown-ledger";
const FIRST_CHECKSUM = "a".repeat(64);
const SECOND_CHECKSUM = "b".repeat(64);
const DIFFERENT_CHECKSUM = "f".repeat(64);

interface FixtureDocument extends MongoDocument {
  readonly _id: number;
  readonly label: string;
  readonly updatedAt: Date;
  readonly migrationOne?: boolean;
  readonly migrationOneRuns?: number;
  readonly migrationTwo?: boolean;
  readonly migrationTwoRuns?: number;
}

type FixtureCheckpoint = {
  readonly lastId: number;
};

interface MigrationControl {
  upCalls: number;
  downCalls: number;
  lastDownAppliedCheckpoint?: FixtureCheckpoint | null;
}

interface FixtureMigrationOptions {
  readonly id: string;
  readonly checksum: string;
  readonly marker: "migrationOne" | "migrationTwo";
  readonly counter: "migrationOneRuns" | "migrationTwoRuns";
  readonly failUpOnCall?: number;
  readonly failUpAfterFirstWriteOnCall?: number;
  readonly failDownOnCall?: number;
  readonly failUpVerificationOnCall?: number;
}

const ZERO_COUNTS: MigrationCounts = {
  examined: 0,
  matched: 0,
  modified: 0,
  skipped: 0,
  errors: 0,
};

function database() {
  const value = mongoose.connection.db;
  if (!value) throw new Error("Integration database is not connected.");
  return value;
}

function fixtures(): Collection<FixtureDocument> {
  return database().collection<FixtureDocument>(FIXTURE_COLLECTION);
}

function ledger(): Collection<MongoDocument> {
  return database().collection(SCHEMA_MIGRATION_COLLECTION);
}

function locks(): Collection<MongoDocument> {
  return database().collection(SCHEMA_MIGRATION_LOCK_COLLECTION);
}

function seedDocuments(count = 5): FixtureDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    _id: index + 1,
    label: `record-${index + 1}`,
    updatedAt: new Date(Date.UTC(2025, 0, index + 1)),
  }));
}

function counts(examined: number, matched: number, modified: number): MigrationCounts {
  return {
    examined,
    matched,
    modified,
    skipped: examined - matched,
    errors: 0,
  };
}

function checkpointLastId(
  checkpoint: FixtureCheckpoint | null,
): number {
  return checkpoint?.lastId ?? 0;
}

function markerFilter(
  marker: FixtureMigrationOptions["marker"],
  direction: MigrationDirection,
  lastId?: number,
): Filter<FixtureDocument> {
  return {
    ...(lastId === undefined ? {} : { _id: { $gt: lastId } }),
    [marker]: direction === "up" ? { $ne: true } : true,
  } as Filter<FixtureDocument>;
}

function markerUpdate(
  marker: FixtureMigrationOptions["marker"],
  counter: FixtureMigrationOptions["counter"],
  direction: MigrationDirection,
): UpdateFilter<FixtureDocument> {
  if (direction === "up") {
    return {
      $set: { [marker]: true },
      $inc: { [counter]: 1 },
    } as UpdateFilter<FixtureDocument>;
  }
  return {
    $unset: { [marker]: "", [counter]: "" },
  } as UpdateFilter<FixtureDocument>;
}

function createFixtureMigration(
  options: FixtureMigrationOptions,
): {
  readonly definition: MigrationDefinition<FixtureCheckpoint>;
  readonly control: MigrationControl;
} {
  const control: MigrationControl = { upCalls: 0, downCalls: 0 };
  let upVerificationCalls = 0;

  const plan = async (
    context: MigrationPlanContext,
  ) => {
    const matched = await context.database
      .collection<FixtureDocument>(FIXTURE_COLLECTION)
      .countDocuments(markerFilter(options.marker, "up"));
    return {
      summary: `Update ${options.marker} fixture records.`,
      counts: counts(matched, matched, matched),
      estimatedBatches: Math.ceil(matched / context.batchSize),
      warnings: [],
    };
  };

  const runBatch = async (
    context: MigrationBatchContext<FixtureCheckpoint>,
  ) => {
    if (context.direction === "up") {
      control.upCalls += 1;
      if (control.upCalls === options.failUpOnCall) {
        throw new Error("Injected fixture apply failure.");
      }
    } else {
      control.downCalls += 1;
      control.lastDownAppliedCheckpoint = context.appliedCheckpoint;
      if (control.downCalls === options.failDownOnCall) {
        throw new Error("Injected fixture rollback failure.");
      }
    }

    const collection = context.database.collection<FixtureDocument>(
      FIXTURE_COLLECTION,
    );
    const candidates = await collection
      .find(
        markerFilter(
          options.marker,
          context.direction,
          checkpointLastId(context.checkpoint),
        ),
      )
      .sort({ _id: 1 })
      .limit(context.batchSize + 1)
      .toArray();
    const batch = candidates.slice(0, context.batchSize);

    let matched = 0;
    let modified = 0;
    for (const [index, document] of batch.entries()) {
      const result = await collection.updateOne(
        {
          _id: document._id,
          [options.marker]:
            context.direction === "up" ? { $ne: true } : true,
        } as Filter<FixtureDocument>,
        markerUpdate(options.marker, options.counter, context.direction),
      );
      matched += result.matchedCount;
      modified += result.modifiedCount;
      if (
        context.direction === "up" &&
        control.upCalls === options.failUpAfterFirstWriteOnCall &&
        index === 0
      ) {
        throw new Error("Injected failure after a fixture write.");
      }
    }

    const nextCheckpoint =
      batch.length > 0
        ? { lastId: batch[batch.length - 1]!._id }
        : context.checkpoint;
    const resultCounts = counts(batch.length, matched, modified);
    return candidates.length <= context.batchSize
      ? {
          done: true as const,
          checkpoint: nextCheckpoint,
          counts: resultCounts,
        }
      : {
          done: false as const,
          checkpoint: nextCheckpoint!,
          counts: resultCounts,
        };
  };

  const verify = async (
    context: MigrationVerificationContext<FixtureCheckpoint>,
  ) => {
    if (context.direction === "up") upVerificationCalls += 1;
    const remaining = await context.database
      .collection<FixtureDocument>(FIXTURE_COLLECTION)
      .countDocuments(markerFilter(options.marker, context.direction));
    return {
      ok:
        remaining === 0 &&
        !(
          context.direction === "up" &&
          upVerificationCalls === options.failUpVerificationOnCall
        ),
      summary: `${options.marker} postcondition checked.`,
      counts: counts(remaining, remaining, 0),
    };
  };

  return {
    definition: {
      id: options.id,
      description: `Fixture migration for ${options.marker}.`,
      checksum: options.checksum,
      plan,
      up: runBatch,
      down: runBatch,
      verify,
    },
    control,
  };
}

let runnerSequence = 0;

function createRunner(
  registry: readonly MigrationDefinition[],
  overrides: Partial<{
    leaseOwner: string;
    leaseDurationMs: number;
    leaseService: MigrationLeaseService;
    transactionService: MongoTransactionService;
    now: () => Date;
  }> = {},
): MigrationRunner {
  runnerSequence += 1;
  return new MigrationRunner({
    connection: mongoose.connection,
    operator: "migration-integration-test",
    appVersion: "m0-04-test",
    leaseOwner: overrides.leaseOwner ?? `test-runner-${runnerSequence}`,
    registry,
    batchSize: 2,
    leaseDurationMs: overrides.leaseDurationMs ?? 60_000,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.leaseService
      ? { leaseService: overrides.leaseService }
      : {}),
    ...(overrides.transactionService
      ? { transactionService: overrides.transactionService }
      : {}),
  });
}

async function readFixtureDocuments(): Promise<FixtureDocument[]> {
  return fixtures().find({}).sort({ _id: 1 }).toArray();
}

async function insertAppliedLedgerRecord(
  migrationId: string,
  checksum: string,
): Promise<void> {
  const now = new Date("2026-09-09T12:00:00.000Z");
  await ledger().insertOne({
    _id: migrationId,
    migrationId,
    description: "Synthetic applied migration ledger record.",
    checksum,
    status: "applied",
    direction: "up",
    applyCheckpoint: null,
    rollbackCheckpoint: null,
    counts: ZERO_COUNTS,
    attempt: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    operator: "migration-integration-test",
    appVersion: "m0-04-test",
    runStartedAt: now,
    runFinishedAt: now,
    lastHeartbeatAt: now,
    appliedAt: now,
    rolledBackAt: null,
    rollbackReasonCode: null,
    lastError: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe("versioned MigrationRunner with a MongoDB replica set", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      fixtures().deleteMany({}),
      ledger().deleteMany({}),
      locks().deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      fixtures().deleteMany({}),
      ledger().deleteMany({}),
      locks().deleteMany({}),
    ]);
  });

  it("keeps fixture data, the ledger, and the lease collection unchanged during dry-run", async () => {
    const original = seedDocuments(3);
    await fixtures().insertMany(original);
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });

    const result = await createRunner([definition]).dryRun();

    expect(result.entries).toEqual([
      {
        id: FIRST_MIGRATION_ID,
        description: definition.description,
        plan: {
          summary: "Update migrationOne fixture records.",
          counts: counts(3, 3, 3),
          estimatedBatches: 2,
          warnings: [],
        },
      },
    ]);
    expect(control).toEqual({ upCalls: 0, downCalls: 0 });
    expect(await readFixtureDocuments()).toEqual(original);
    expect(await ledger().countDocuments()).toBe(0);
    expect(await locks().countDocuments()).toBe(0);
  });

  it("applies multiple batches, persists progress totals, and makes a second apply a no-op", async () => {
    const original = seedDocuments();
    await fixtures().insertMany(original);
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const runner = createRunner([definition]);

    const first = await runner.apply();

    expect(first.runId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.entries).toEqual([
      {
        id: FIRST_MIGRATION_ID,
        direction: "up",
        status: "applied",
        attempt: 1,
        counts: counts(5, 5, 5),
      },
    ]);
    expect(control.upCalls).toBe(3);
    const migrated = await readFixtureDocuments();
    expect(
      migrated.map(({ migrationOne, migrationOneRuns, updatedAt }) => ({
        migrationOne,
        migrationOneRuns,
        updatedAt,
      })),
    ).toEqual(
      original.map(({ updatedAt }) => ({
        migrationOne: true,
        migrationOneRuns: 1,
        updatedAt,
      })),
    );

    const appliedLedger = await ledger().findOne({ _id: FIRST_MIGRATION_ID });
    expect(appliedLedger).toMatchObject({
      migrationId: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      status: "applied",
      direction: "up",
      applyCheckpoint: { lastId: 5 },
      rollbackCheckpoint: null,
      counts: counts(5, 5, 5),
      attempt: 1,
      lastError: null,
    });
    expect(appliedLedger?.appliedAt).toBeInstanceOf(Date);
    expect(appliedLedger?.runFinishedAt).toBeInstanceOf(Date);

    const second = await runner.apply();

    expect(second).toEqual({ runId: null, entries: [] });
    expect(control.upCalls).toBe(3);
    expect(await readFixtureDocuments()).toEqual(migrated);
    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toEqual(
      appliedLedger,
    );
    expect((await runner.status()).entries[0]).toMatchObject({
      status: "applied",
      attempt: 1,
      counts: counts(5, 5, 5),
    });
  });

  it.each([
    { phase: "terminal", fixtureCount: 1 },
    { phase: "non-terminal", fixtureCount: 5 },
  ])("reconciles a committed $phase batch after an uncertain commit result", async ({
    fixtureCount,
  }) => {
    await fixtures().insertMany(seedDocuments(fixtureCount));
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const transactionService = new MongoTransactionService(
      mongoose.connection,
    );
    const runTransaction = transactionService.run.bind(transactionService);
    let injectUncertainResult = true;
    vi.spyOn(transactionService, "run").mockImplementation(
      async (...arguments_: Parameters<typeof transactionService.run>) => {
        const result = await runTransaction(...arguments_);
        if (injectUncertainResult) {
          injectUncertainResult = false;
          throw new MongoTransactionCommitUncertainError(
            3,
            new Error("Injected unknown commit result."),
          );
        }
        return result;
      },
    );
    const runner = createRunner([definition], { transactionService });

    await expect(runner.apply()).resolves.toMatchObject({
      entries: [
        {
          id: FIRST_MIGRATION_ID,
          status: "applied",
          counts: counts(fixtureCount, fixtureCount, fixtureCount),
        },
      ],
    });

    expect(control.upCalls).toBe(Math.ceil(fixtureCount / 2));
    expect(
      (await readFixtureDocuments()).map((document) =>
        document.migrationOneRuns,
      ),
    ).toEqual(Array.from({ length: fixtureCount }, () => 1));
    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "applied",
      applyCheckpoint: { lastId: fixtureCount },
      counts: counts(fixtureCount, fixtureCount, fixtureCount),
      lastError: null,
    });
  });

  it("keeps ledger timestamps monotonic when the runner clock moves backward", async () => {
    await fixtures().insertMany(seedDocuments());
    const { definition } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const clockValues = [
      "2026-09-09T12:00:10.000Z",
      "2026-09-09T12:00:09.000Z",
      "2026-09-09T12:00:08.000Z",
      "2026-09-09T12:00:07.000Z",
    ];
    let clockIndex = 0;
    const runner = createRunner([definition], {
      now: () =>
        new Date(
          clockValues[Math.min(clockIndex++, clockValues.length - 1)]!,
        ),
    });

    await expect(runner.apply()).resolves.toMatchObject({
      entries: [{ id: FIRST_MIGRATION_ID, status: "applied" }],
    });

    const record = await ledger().findOne({ _id: FIRST_MIGRATION_ID });
    const monotonicTimestamp = new Date(clockValues[0]!);
    expect(record).toMatchObject({
      runStartedAt: monotonicTimestamp,
      lastHeartbeatAt: monotonicTimestamp,
      runFinishedAt: monotonicTimestamp,
      appliedAt: monotonicTimestamp,
      updatedAt: monotonicTimestamp,
    });
    expect(await runner.status()).toMatchObject({
      healthy: true,
      recoveryRequired: false,
      issues: [],
    });
  });

  it("keeps failure timestamps monotonic when the runner clock moves backward", async () => {
    await fixtures().insertMany(seedDocuments(1));
    const { definition } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
      failUpOnCall: 1,
    });
    const clockValues = [
      "2026-09-09T12:00:10.000Z",
      "2026-09-09T12:00:09.000Z",
    ];
    let clockIndex = 0;
    const runner = createRunner([definition], {
      now: () =>
        new Date(
          clockValues[Math.min(clockIndex++, clockValues.length - 1)]!,
        ),
    });

    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_EXECUTION_FAILED",
    });

    const monotonicTimestamp = new Date(clockValues[0]!);
    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "apply_failed",
      runStartedAt: monotonicTimestamp,
      lastHeartbeatAt: monotonicTimestamp,
      runFinishedAt: monotonicTimestamp,
      updatedAt: monotonicTimestamp,
      lastError: {
        code: "MIGRATION_APPLY_FAILED",
        recordedAt: monotonicTimestamp,
      },
    });
    expect(await runner.status()).toMatchObject({
      healthy: false,
      recoveryRequired: true,
      issues: [],
    });
  });

  it("does not mark a replacement run as failed from a stale runner", async () => {
    await fixtures().insertMany(seedDocuments());
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const replacementRunId = "33333333-3333-4333-8333-333333333333";
    const transactionService = new MongoTransactionService(
      mongoose.connection,
    );
    vi.spyOn(transactionService, "run").mockImplementation(async () => {
      const current = await ledger().findOne({ _id: FIRST_MIGRATION_ID });
      if (!current) throw new Error("Expected an active migration ledger.");
      const replaced = await ledger().updateOne(
        {
          _id: FIRST_MIGRATION_ID,
          runId: current.runId,
          status: "applying",
          revision: current.revision,
        },
        {
          $set: { runId: replacementRunId },
          $inc: { revision: 1 },
        },
      );
      expect(replaced.matchedCount).toBe(1);
      throw new Error("Injected stale runner failure.");
    });
    const runner = createRunner([definition], { transactionService });

    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_EXECUTION_FAILED",
    });

    expect(control.upCalls).toBe(0);
    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "applying",
      runId: replacementRunId,
      revision: 1,
      lastError: null,
    });
  });

  it("records the exact committed checkpoint after an apply failure and resumes without replay", async () => {
    await fixtures().insertMany(seedDocuments());
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
      failUpOnCall: 2,
    });
    const runner = createRunner([definition]);

    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_EXECUTION_FAILED",
    });

    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "apply_failed",
      direction: "up",
      applyCheckpoint: { lastId: 2 },
      counts: counts(2, 2, 2),
      attempt: 1,
      lastError: { code: "MIGRATION_APPLY_FAILED" },
    });
    expect(
      (await readFixtureDocuments()).map((document) => ({
        id: document._id,
        runs: document.migrationOneRuns ?? 0,
      })),
    ).toEqual([
      { id: 1, runs: 1 },
      { id: 2, runs: 1 },
      { id: 3, runs: 0 },
      { id: 4, runs: 0 },
      { id: 5, runs: 0 },
    ]);
    expect(await runner.status()).toMatchObject({
      healthy: false,
      recoveryRequired: true,
      issues: [],
    });

    const resumed = await runner.resume(FIRST_MIGRATION_ID);

    expect(resumed.entries[0]).toMatchObject({
      id: FIRST_MIGRATION_ID,
      status: "applied",
      attempt: 2,
      counts: counts(5, 5, 5),
    });
    expect(control.upCalls).toBe(4);
    expect(
      (await readFixtureDocuments()).map((document) =>
        document.migrationOneRuns,
      ),
    ).toEqual([1, 1, 1, 1, 1]);
    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "applied",
      applyCheckpoint: { lastId: 5 },
      counts: counts(5, 5, 5),
      attempt: 2,
      lastError: null,
    });
  });

  it("atomically aborts a partially written batch and resumes from the preceding checkpoint", async () => {
    await fixtures().insertMany(seedDocuments());
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
      failUpAfterFirstWriteOnCall: 2,
    });
    const runner = createRunner([definition]);

    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_EXECUTION_FAILED",
    });

    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "apply_failed",
      applyCheckpoint: { lastId: 2 },
      counts: counts(2, 2, 2),
    });
    expect(
      (await readFixtureDocuments()).map((document) => ({
        id: document._id,
        migrated: document.migrationOne === true,
        runs: document.migrationOneRuns ?? 0,
      })),
    ).toEqual([
      { id: 1, migrated: true, runs: 1 },
      { id: 2, migrated: true, runs: 1 },
      { id: 3, migrated: false, runs: 0 },
      { id: 4, migrated: false, runs: 0 },
      { id: 5, migrated: false, runs: 0 },
    ]);

    await expect(runner.resume(FIRST_MIGRATION_ID)).resolves.toMatchObject({
      entries: [
        {
          status: "applied",
          attempt: 2,
          counts: counts(5, 5, 5),
        },
      ],
    });
    expect(control.upCalls).toBe(4);
    expect(
      (await readFixtureDocuments()).map((document) =>
        document.migrationOneRuns,
      ),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("rolls back a terminal batch when verification fails and then resumes safely", async () => {
    await fixtures().insertMany(seedDocuments());
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
      failUpVerificationOnCall: 1,
    });
    const runner = createRunner([definition]);

    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_EXECUTION_FAILED",
    });

    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "apply_failed",
      applyCheckpoint: { lastId: 4 },
      counts: counts(4, 4, 4),
      attempt: 1,
    });
    expect(
      (await readFixtureDocuments()).map((document) => ({
        id: document._id,
        migrated: document.migrationOne === true,
        runs: document.migrationOneRuns ?? 0,
      })),
    ).toEqual([
      { id: 1, migrated: true, runs: 1 },
      { id: 2, migrated: true, runs: 1 },
      { id: 3, migrated: true, runs: 1 },
      { id: 4, migrated: true, runs: 1 },
      { id: 5, migrated: false, runs: 0 },
    ]);

    await expect(runner.resume(FIRST_MIGRATION_ID)).resolves.toMatchObject({
      entries: [
        {
          status: "applied",
          attempt: 2,
          counts: counts(5, 5, 5),
        },
      ],
    });
    expect(control.upCalls).toBe(4);
    expect(
      (await readFixtureDocuments()).map((document) =>
        document.migrationOneRuns,
      ),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("rolls back to the exact original documents and permits a clean re-apply", async () => {
    const original = seedDocuments();
    await fixtures().insertMany(original);
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const runner = createRunner([definition]);
    await runner.apply();

    const rollback = await runner.rollback(
      FIRST_MIGRATION_ID,
      "OPERATOR_REQUEST",
    );

    expect(rollback.entries).toEqual([
      {
        id: FIRST_MIGRATION_ID,
        direction: "down",
        status: "rolled_back",
        attempt: 2,
        counts: counts(5, 5, 5),
      },
    ]);
    expect(await readFixtureDocuments()).toEqual(original);
    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "rolled_back",
      direction: "down",
      applyCheckpoint: { lastId: 5 },
      rollbackCheckpoint: { lastId: 5 },
      counts: counts(5, 5, 5),
      attempt: 2,
      lastError: null,
      rollbackReasonCode: "OPERATOR_REQUEST",
    });
    expect(control.lastDownAppliedCheckpoint).toEqual({ lastId: 5 });

    const reapplied = await runner.apply();

    expect(reapplied.entries[0]).toMatchObject({
      status: "applied",
      direction: "up",
      attempt: 3,
      counts: counts(5, 5, 5),
    });
    expect(
      (await readFixtureDocuments()).map((document) =>
        document.migrationOneRuns,
      ),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("keeps rollback timestamps monotonic when the runner clock is behind the ledger", async () => {
    await fixtures().insertMany(seedDocuments(1));
    const { definition } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const appliedAt = new Date("2026-09-09T12:00:10.000Z");
    await createRunner([definition], {
      now: () => new Date(appliedAt),
    }).apply();

    const rollbackRunner = createRunner([definition], {
      now: () => new Date("2026-09-09T11:00:00.000Z"),
    });
    await expect(
      rollbackRunner.rollback(FIRST_MIGRATION_ID, "OPERATOR_REQUEST"),
    ).resolves.toMatchObject({
      entries: [{ id: FIRST_MIGRATION_ID, status: "rolled_back" }],
    });

    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "rolled_back",
      appliedAt,
      runStartedAt: appliedAt,
      lastHeartbeatAt: appliedAt,
      runFinishedAt: appliedAt,
      rolledBackAt: appliedAt,
      updatedAt: appliedAt,
    });
    expect(await rollbackRunner.status()).toMatchObject({
      healthy: true,
      recoveryRequired: false,
      issues: [],
    });
  });

  it("resumes an interrupted rollback from its committed checkpoint", async () => {
    const original = seedDocuments();
    await fixtures().insertMany(original);
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
      failDownOnCall: 2,
    });
    const runner = createRunner([definition]);
    await runner.apply();

    await expect(
      runner.rollback(FIRST_MIGRATION_ID, "POSTCONDITION_FAILED"),
    ).rejects.toMatchObject({ code: "MIGRATION_EXECUTION_FAILED" });

    expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
      status: "rollback_failed",
      direction: "down",
      applyCheckpoint: { lastId: 5 },
      rollbackCheckpoint: { lastId: 2 },
      counts: counts(2, 2, 2),
      attempt: 2,
      lastError: { code: "MIGRATION_ROLLBACK_FAILED" },
    });
    expect(
      (await readFixtureDocuments()).map((document) =>
        document.migrationOne === true,
      ),
    ).toEqual([false, false, true, true, true]);

    const resumed = await runner.resume(FIRST_MIGRATION_ID);

    expect(resumed.entries[0]).toMatchObject({
      status: "rolled_back",
      direction: "down",
      attempt: 3,
      counts: counts(5, 5, 5),
    });
    expect(control.downCalls).toBe(4);
    expect(control.lastDownAppliedCheckpoint).toEqual({ lastId: 5 });
    expect(await readFixtureDocuments()).toEqual(original);
  });

  it("rejects a second runner while the live lease is held", async () => {
    await fixtures().insertMany(seedDocuments(2));
    const { definition } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const leaseService = new MigrationLeaseService(mongoose.connection, {
      owner: "runner-one",
      leaseDurationMs: 60_000,
    });
    const originalAcquire = leaseService.acquire.bind(leaseService);
    let signalAcquired!: () => void;
    let letFirstRunnerProceed!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const firstRunnerMayProceed = new Promise<void>((resolve) => {
      letFirstRunnerProceed = resolve;
    });
    vi.spyOn(leaseService, "acquire").mockImplementation(async (input) => {
      const handle = await originalAcquire(input);
      signalAcquired();
      await firstRunnerMayProceed;
      return handle;
    });
    const firstRunner = createRunner([definition], {
      leaseOwner: "runner-one",
      leaseService,
    });
    const secondRunner = createRunner([definition], {
      leaseOwner: "runner-two",
    });

    const firstRun = firstRunner.apply();
    await acquired;
    try {
      await expect(secondRunner.apply()).rejects.toBeInstanceOf(
        MigrationLeaseContentionError,
      );
    } finally {
      letFirstRunnerProceed();
    }

    await expect(firstRun).resolves.toMatchObject({
      entries: [{ status: "applied" }],
    });
  });

  it("does not report a no-op apply while a concurrent rollback holds the lease", async () => {
    await fixtures().insertMany(seedDocuments(2));
    const { definition } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    await createRunner([definition]).apply();

    const rollbackLeaseService = new MigrationLeaseService(mongoose.connection, {
      owner: "rollback-runner",
      leaseDurationMs: 60_000,
    });
    const originalAcquire = rollbackLeaseService.acquire.bind(
      rollbackLeaseService,
    );
    let signalRollbackLeaseAcquired!: () => void;
    let letRollbackProceed!: () => void;
    const rollbackLeaseAcquired = new Promise<void>((resolve) => {
      signalRollbackLeaseAcquired = resolve;
    });
    const rollbackMayProceed = new Promise<void>((resolve) => {
      letRollbackProceed = resolve;
    });
    vi.spyOn(rollbackLeaseService, "acquire").mockImplementation(
      async (input) => {
        const handle = await originalAcquire(input);
        signalRollbackLeaseAcquired();
        await rollbackMayProceed;
        return handle;
      },
    );
    const rollbackRunner = createRunner([definition], {
      leaseOwner: "rollback-runner",
      leaseService: rollbackLeaseService,
    });
    const applyRunner = createRunner([definition], {
      leaseOwner: "no-op-apply-runner",
    });

    const rollback = rollbackRunner.rollback(
      FIRST_MIGRATION_ID,
      "OPERATOR_REQUEST",
    );
    await rollbackLeaseAcquired;
    try {
      await expect(applyRunner.apply()).rejects.toBeInstanceOf(
        MigrationLeaseContentionError,
      );
    } finally {
      letRollbackProceed();
    }

    await expect(rollback).resolves.toMatchObject({
      entries: [{ status: "rolled_back" }],
    });
    expect(await readFixtureDocuments()).toEqual(seedDocuments(2));
  });

  it.each([
    SCHEMA_MIGRATION_COLLECTION,
    SCHEMA_MIGRATION_LOCK_COLLECTION,
  ])(
    "rejects migration access to reserved control collection %s and aborts prior domain writes",
    async (reservedCollectionName) => {
      const original = seedDocuments(1);
      await fixtures().insertMany(original);
      const fixtureMigration = createFixtureMigration({
        id: FIRST_MIGRATION_ID,
        checksum: FIRST_CHECKSUM,
        marker: "migrationOne",
        counter: "migrationOneRuns",
      });
      let reservedCollectionWasReturned = false;
      const definition: MigrationDefinition<FixtureCheckpoint> = {
        ...fixtureMigration.definition,
        up: async (context) => {
          await context.database
            .collection<FixtureDocument>(FIXTURE_COLLECTION)
            .updateOne(
              { _id: 1 },
              { $set: { migrationOne: true }, $inc: { migrationOneRuns: 1 } },
            );
          const reserved = context.database.collection(reservedCollectionName);
          reservedCollectionWasReturned = true;
          await reserved.deleteMany({});
          return {
            done: true,
            checkpoint: { lastId: 1 },
            counts: counts(1, 1, 1),
          };
        },
      };
      const runner = createRunner([definition]);

      await expect(runner.apply()).rejects.toMatchObject({
        code: "MIGRATION_EXECUTION_FAILED",
      });

      expect(reservedCollectionWasReturned).toBe(false);
      expect(await readFixtureDocuments()).toEqual(original);
      expect(await ledger().countDocuments()).toBe(1);
      expect(await ledger().findOne({ _id: FIRST_MIGRATION_ID })).toMatchObject({
        status: "apply_failed",
        direction: "up",
        applyCheckpoint: null,
        rollbackCheckpoint: null,
        counts: ZERO_COUNTS,
        lastError: { code: "MIGRATION_USAGE_ERROR" },
      });
      expect(await createRunner([definition]).status()).toMatchObject({
        healthy: false,
        recoveryRequired: true,
        issues: [],
      });
      const releasedLock = await locks().findOne({});
      expect(releasedLock).toMatchObject({
        _id: "schema-migration-global",
        releasedAt: expect.any(Date),
      });
      expect(releasedLock).not.toHaveProperty("owner");
      expect(releasedLock).not.toHaveProperty("runId");
      expect(releasedLock).not.toHaveProperty("token");
      expect(releasedLock).not.toHaveProperty("currentMigrationId");
    },
  );

  it("allows an expired lease takeover and fences the stale owner", async () => {
    await fixtures().insertOne(seedDocuments(1)[0]!);
    const first = new MigrationLeaseService(mongoose.connection, {
      owner: "expired-runner",
      leaseDurationMs: 60_000,
    });
    const second = new MigrationLeaseService(mongoose.connection, {
      owner: "takeover-runner",
      leaseDurationMs: 60_000,
    });
    const staleHandle = await first.acquire({
      runId: "11111111-1111-4111-8111-111111111111",
    });
    const forcedExpiry = await locks().updateOne(
      {
        _id: staleHandle.lockId,
        owner: staleHandle.owner,
        runId: staleHandle.runId,
        token: staleHandle.token,
        fence: staleHandle.fence,
        revision: staleHandle.revision,
      },
      [
        {
          $set: {
            acquiredAt: {
              $dateSubtract: {
                startDate: "$$NOW",
                unit: "minute",
                amount: 2,
              },
            },
            heartbeatAt: {
              $dateSubtract: {
                startDate: "$$NOW",
                unit: "minute",
                amount: 2,
              },
            },
            expiresAt: {
              $dateSubtract: {
                startDate: "$$NOW",
                unit: "minute",
                amount: 1,
              },
            },
            updatedAt: "$$NOW",
          },
        },
      ],
    );
    expect(forcedExpiry.matchedCount).toBe(1);

    const currentHandle = await second.acquire({
      runId: "22222222-2222-4222-8222-222222222222",
    });

    expect(currentHandle.fence).toBe(staleHandle.fence + 1);
    expect(currentHandle.token).not.toBe(staleHandle.token);
    const transactions = new MongoTransactionService(mongoose.connection);
    await expect(
      transactions.run(async (session) => {
        await fixtures().updateOne(
          { _id: 1 },
          { $set: { migrationOne: true } },
          { session },
        );
        await first.assertHeld(staleHandle, session);
      }),
    ).rejects.toBeInstanceOf(MigrationLeaseLostError);
    expect(await fixtures().findOne({ _id: 1 })).not.toHaveProperty(
      "migrationOne",
    );
    await second.release(currentHandle);
  });

  it.each([
    {
      name: "checksum drift",
      buildRegistry: () => {
        const migration = createFixtureMigration({
          id: FIRST_MIGRATION_ID,
          checksum: FIRST_CHECKSUM,
          marker: "migrationOne",
          counter: "migrationOneRuns",
        });
        return {
          registry: [migration.definition],
          controls: [migration.control],
          ledgerId: FIRST_MIGRATION_ID,
          ledgerChecksum: DIFFERENT_CHECKSUM,
          expectedIssue: "CHECKSUM_DRIFT",
        };
      },
    },
    {
      name: "an unknown ledger version",
      buildRegistry: () => {
        const migration = createFixtureMigration({
          id: FIRST_MIGRATION_ID,
          checksum: FIRST_CHECKSUM,
          marker: "migrationOne",
          counter: "migrationOneRuns",
        });
        return {
          registry: [migration.definition],
          controls: [migration.control],
          ledgerId: UNKNOWN_MIGRATION_ID,
          ledgerChecksum: DIFFERENT_CHECKSUM,
          expectedIssue: "UNKNOWN_LEDGER_VERSION",
        };
      },
    },
    {
      name: "a version gap",
      buildRegistry: () => {
        const first = createFixtureMigration({
          id: FIRST_MIGRATION_ID,
          checksum: FIRST_CHECKSUM,
          marker: "migrationOne",
          counter: "migrationOneRuns",
        });
        const second = createFixtureMigration({
          id: SECOND_MIGRATION_ID,
          checksum: SECOND_CHECKSUM,
          marker: "migrationTwo",
          counter: "migrationTwoRuns",
        });
        return {
          registry: [first.definition, second.definition],
          controls: [first.control, second.control],
          ledgerId: SECOND_MIGRATION_ID,
          ledgerChecksum: SECOND_CHECKSUM,
          expectedIssue: "VERSION_GAP",
        };
      },
    },
  ])("fails on $name before any domain write", async ({ buildRegistry }) => {
    const original = seedDocuments(2);
    await fixtures().insertMany(original);
    const scenario = buildRegistry();
    await insertAppliedLedgerRecord(
      scenario.ledgerId,
      scenario.ledgerChecksum,
    );
    const runner = createRunner(scenario.registry);

    const status = await runner.status();
    expect(status.healthy).toBe(false);
    expect(status.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: scenario.expectedIssue }),
      ]),
    );
    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_STATE_CONFLICT",
    });

    expect(scenario.controls).toEqual(
      scenario.controls.map(() => ({ upCalls: 0, downCalls: 0 })),
    );
    expect(await readFixtureDocuments()).toEqual(original);
    expect(await locks().countDocuments()).toBe(0);
  });

  it.each([
    {
      name: "an unknown ledger field",
      update: { $set: { unexpected: true } },
    },
    {
      name: "an unknown nested count field",
      update: { $set: { "counts.unexpected": 1 } },
    },
    {
      name: "a heartbeat preceding the run start",
      update: {
        $set: { lastHeartbeatAt: new Date("2026-09-09T11:59:59.000Z") },
      },
    },
    {
      name: "an unregistered failure code",
      update: {
        $set: {
          status: "apply_failed",
          appliedAt: null,
          lastError: {
            code: "CUSTOM_UPPERCASE_CODE",
            digest: "c".repeat(64),
            recordedAt: new Date("2026-09-09T12:00:00.000Z"),
          },
        },
      },
    },
  ])("reports $name as an invalid raw ledger record", async ({ update }) => {
    const original = seedDocuments(2);
    await fixtures().insertMany(original);
    const { definition, control } = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    await insertAppliedLedgerRecord(FIRST_MIGRATION_ID, FIRST_CHECKSUM);
    await ledger().updateOne({ _id: FIRST_MIGRATION_ID }, update);
    const runner = createRunner([definition]);

    expect(await runner.status()).toMatchObject({
      healthy: false,
      recoveryRequired: false,
      issues: [
        { code: "INVALID_LEDGER_RECORD", migrationId: FIRST_MIGRATION_ID },
      ],
    });
    await expect(runner.apply()).rejects.toMatchObject({
      code: "MIGRATION_STATE_CONFLICT",
    });
    expect(control).toEqual({ upCalls: 0, downCalls: 0 });
    expect(await readFixtureDocuments()).toEqual(original);
  });

  it("allows rollback only for the latest applied migration", async () => {
    await fixtures().insertMany(seedDocuments(3));
    const first = createFixtureMigration({
      id: FIRST_MIGRATION_ID,
      checksum: FIRST_CHECKSUM,
      marker: "migrationOne",
      counter: "migrationOneRuns",
    });
    const second = createFixtureMigration({
      id: SECOND_MIGRATION_ID,
      checksum: SECOND_CHECKSUM,
      marker: "migrationTwo",
      counter: "migrationTwoRuns",
    });
    const runner = createRunner([first.definition, second.definition]);
    await runner.apply();
    const beforeRejectedRollback = await readFixtureDocuments();

    await expect(
      runner.rollback(FIRST_MIGRATION_ID, "OPERATOR_REQUEST"),
    ).rejects.toMatchObject({ code: "MIGRATION_STATE_CONFLICT" });

    expect(first.control.downCalls).toBe(0);
    expect(second.control.downCalls).toBe(0);
    expect(await readFixtureDocuments()).toEqual(beforeRejectedRollback);
    expect(
      await ledger()
        .find({}, { projection: { _id: 1, status: 1 } })
        .sort({ _id: 1 })
        .toArray(),
    ).toEqual([
      { _id: FIRST_MIGRATION_ID, status: "applied" },
      { _id: SECOND_MIGRATION_ID, status: "applied" },
    ]);

    await expect(
      runner.rollback(SECOND_MIGRATION_ID, "RELEASE_ROLLBACK"),
    ).resolves.toMatchObject({
      entries: [
        {
          id: SECOND_MIGRATION_ID,
          direction: "down",
          status: "rolled_back",
        },
      ],
    });
    expect(
      (await readFixtureDocuments()).map((document) => ({
        first: document.migrationOne,
        second: document.migrationTwo,
      })),
    ).toEqual([
      { first: true, second: undefined },
      { first: true, second: undefined },
      { first: true, second: undefined },
    ]);
  });
});
