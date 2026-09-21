import type { ConnectOptions, Connection } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type {
  MigrationDryRunResult,
  MigrationExecutionResult,
  MigrationStatusResult,
} from "../../../../src/services/migrations/MigrationRunner";
import { MigrationStateConflictError } from "../../../../src/services/migrations/MigrationErrors";
import { MigrationLeaseContentionError } from "../../../../src/services/migrations/MigrationLeaseService";
import {
  runMigrationCli,
  type MigrationCliAdapters,
  type MigrationCliEnvironment,
  type MigrationRunnerPort,
} from "../../../../src/scripts/migrations/runMigrations";

const MIGRATION_A = "20260909_001_alumni-profile";
const MIGRATION_B = "20260909_002_help-outcomes";
const SECRET_URI =
  "mongodb+srv://migration-user:super-secret@example.invalid/atcloud-production";
const CONFIRMED_WRITE_ARGUMENTS = [
  "--execute",
  "--yes",
  "--confirm-db",
  "atcloud-production",
  "--operator",
  "Migration Test Operator",
] as const;
const ZERO_COUNTS = {
  examined: 0,
  matched: 0,
  modified: 0,
  skipped: 0,
  errors: 0,
} as const;

const EMPTY_STATUS: MigrationStatusResult = {
  healthy: true,
  recoveryRequired: false,
  appliedCount: 0,
  pendingCount: 0,
  entries: [],
  issues: [],
};

const EMPTY_DRY_RUN: MigrationDryRunResult = {
  observedAt: new Date("2026-09-09T12:00:00.000Z"),
  entries: [],
};

const EMPTY_EXECUTION: MigrationExecutionResult = {
  runId: null,
  entries: [],
};

type MigrationSignal = "SIGINT" | "SIGTERM";

interface Harness {
  readonly adapters: MigrationCliAdapters;
  readonly connection: Connection;
  readonly close: ReturnType<typeof vi.fn>;
  readonly asPromise: ReturnType<typeof vi.fn>;
  readonly createConnection: ReturnType<typeof vi.fn>;
  readonly createRunner: ReturnType<typeof vi.fn>;
  readonly runner: MigrationRunnerPort;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly listeners: Map<MigrationSignal, () => void>;
  readonly addSignalListener: ReturnType<typeof vi.fn>;
  readonly removeSignalListener: ReturnType<typeof vi.fn>;
}

function createHarness(
  runnerOverrides: Partial<MigrationRunnerPort> = {},
  databaseName = "atcloud-production",
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const listeners = new Map<MigrationSignal, () => void>();
  const close = vi.fn(async () => undefined);
  let connection: Connection;
  const asPromise = vi.fn(async () => connection);
  connection = {
    db: { databaseName },
    asPromise,
    close,
  } as unknown as Connection;
  const createConnection = vi.fn(
    (_uri: string, _options: ConnectOptions) => connection,
  );
  const runner: MigrationRunnerPort = {
    status: vi.fn(async () => EMPTY_STATUS),
    dryRun: vi.fn(async () => EMPTY_DRY_RUN),
    apply: vi.fn(async () => EMPTY_EXECUTION),
    resume: vi.fn(async () => EMPTY_EXECUTION),
    rollback: vi.fn(async () => EMPTY_EXECUTION),
    ...runnerOverrides,
  };
  const createRunner = vi.fn(() => runner);
  const addSignalListener = vi.fn(
    (signal: MigrationSignal, listener: () => void) => {
      listeners.set(signal, listener);
    },
  );
  const removeSignalListener = vi.fn(
    (signal: MigrationSignal, listener: () => void) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
  );
  return {
    adapters: {
      io: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      createConnection,
      createRunner,
      hostname: () => "render-host.example",
      pid: 4321,
      packageVersion: "1.1.0",
      addSignalListener,
      removeSignalListener,
    },
    connection,
    close,
    asPromise,
    createConnection,
    createRunner,
    runner,
    stdout,
    stderr,
    listeners,
    addSignalListener,
    removeSignalListener,
  };
}

function environment(
  overrides: MigrationCliEnvironment = {},
): MigrationCliEnvironment {
  return { MONGODB_URI: SECRET_URI, NODE_ENV: "test", ...overrides };
}

describe("runMigrationCli", () => {
  it("requires MONGODB_URI without accepting or printing connection details", async () => {
    const harness = createHarness();
    const exitCode = await runMigrationCli(
      ["status", "--json"],
      { NODE_ENV: "test" },
      harness.adapters,
    );

    expect(exitCode).toBe(2);
    expect(harness.createConnection).not.toHaveBeenCalled();
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toHaveLength(1);
    expect(JSON.parse(harness.stderr[0]!)).toEqual({
      code: "MIGRATION_USAGE_ERROR",
      usage: expect.stringContaining("migration status"),
    });
    expect(harness.stderr.join("\n")).not.toContain("MONGODB_URI");
    expect(harness.stderr.join("\n")).not.toContain("mongodb");
  });

  it("uses an isolated, non-indexing connection and emits only projected status fields", async () => {
    const status: MigrationStatusResult = {
      healthy: false,
      recoveryRequired: false,
      appliedCount: 1,
      pendingCount: 1,
      entries: [
        {
          id: MIGRATION_A,
          description: `must not print ${SECRET_URI}`,
          checksum: "a".repeat(64),
          status: "applied",
          attempt: 2,
          counts: { ...ZERO_COUNTS, examined: 4, modified: 3 },
          appliedAt: new Date("2026-09-09T12:01:00.000Z"),
          rolledBackAt: null,
        },
      ],
      issues: [{ code: "VERSION_GAP", migrationId: MIGRATION_B }],
    };
    const harness = createHarness({ status: vi.fn(async () => status) });

    const exitCode = await runMigrationCli(
      ["status", "--json"],
      environment(),
      harness.adapters,
    );

    expect(exitCode).toBe(3);
    expect(harness.createConnection).toHaveBeenCalledTimes(1);
    const [uri, options] = harness.createConnection.mock.calls[0]!;
    expect(uri).toBe(SECRET_URI);
    expect(options).toMatchObject({
      autoCreate: false,
      autoIndex: false,
      bufferCommands: false,
      maxPoolSize: 5,
      minPoolSize: 0,
      appName: "atcloud-schema-migration-cli",
    });
    expect(harness.runner.status).toHaveBeenCalledTimes(1);
    expect(harness.runner.dryRun).not.toHaveBeenCalled();
    expect(harness.runner.apply).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout.join("\n")).not.toContain(SECRET_URI);
    expect(harness.stdout.join("\n")).not.toContain("description");
    expect(harness.stdout.join("\n")).not.toContain("checksum");
    expect(JSON.parse(harness.stdout[0]!)).toEqual({
      status: "issues",
      counts: { applied: 1, pending: 1, migrations: 1, issues: 1 },
      migrations: [
        {
          id: MIGRATION_A,
          status: "applied",
          counts: {
            examined: 4,
            matched: 0,
            modified: 3,
            skipped: 0,
            errors: 0,
            attempts: 2,
          },
          timestamps: {
            appliedAt: "2026-09-09T12:01:00.000Z",
            rolledBackAt: null,
          },
        },
      ],
      issues: [{ code: "VERSION_GAP", id: MIGRATION_B }],
    });
  });

  it("returns exit 3 and recovery-required for an interrupted ledger state", async () => {
    const recoveryStatus: MigrationStatusResult = {
      healthy: false,
      recoveryRequired: true,
      appliedCount: 0,
      pendingCount: 1,
      entries: [
        {
          id: MIGRATION_A,
          description: "Private recovery detail is not emitted.",
          checksum: "a".repeat(64),
          status: "apply_failed",
          attempt: 1,
          counts: ZERO_COUNTS,
          appliedAt: null,
          rolledBackAt: null,
        },
      ],
      issues: [],
    };
    const harness = createHarness({
      status: vi.fn(async () => recoveryStatus),
    });

    const exitCode = await runMigrationCli(
      ["status", "--json"],
      environment(),
      harness.adapters,
    );

    expect(exitCode).toBe(3);
    expect(harness.stderr).toEqual([]);
    expect(JSON.parse(harness.stdout[0]!)).toMatchObject({
      status: "recovery-required",
      migrations: [{ id: MIGRATION_A, status: "apply_failed" }],
    });
  });

  it("maps dry-run to safe warning codes/counts and redacts free text", async () => {
    const dryRun: MigrationDryRunResult = {
      observedAt: new Date("2026-09-09T12:00:00.000Z"),
      entries: [
        {
          id: MIGRATION_A,
          description: SECRET_URI,
          plan: {
            summary: SECRET_URI,
            counts: { ...ZERO_COUNTS, examined: 10, matched: 8 },
            estimatedBatches: 2,
            warnings: [{ code: "FULL_COLLECTION_SCAN", count: 4 }],
          },
        },
      ],
    };
    const harness = createHarness({ dryRun: vi.fn(async () => dryRun) });

    const exitCode = await runMigrationCli(
      ["dry-run", "--to", MIGRATION_A, "--json"],
      environment(),
      harness.adapters,
    );

    expect(exitCode).toBe(0);
    expect(harness.runner.dryRun).toHaveBeenCalledWith(MIGRATION_A);
    expect(harness.runner.status).not.toHaveBeenCalled();
    expect(harness.runner.apply).not.toHaveBeenCalled();
    expect(harness.stdout.join("\n")).not.toContain(SECRET_URI);
    expect(JSON.parse(harness.stdout[0]!)).toEqual({
      status: "planned",
      counts: { migrations: 1, warnings: 4 },
      timestamps: { observedAt: "2026-09-09T12:00:00.000Z" },
      migrations: [
        {
          id: MIGRATION_A,
          status: "planned",
          counts: {
            examined: 10,
            matched: 8,
            modified: 0,
            skipped: 0,
            errors: 0,
            estimatedBatches: 2,
            warnings: 4,
          },
        },
      ],
      issues: [
        {
          code: "FULL_COLLECTION_SCAN",
          id: MIGRATION_A,
          count: 4,
        },
      ],
    });
  });

  it("confirms an apply against the connected database and records safe provenance", async () => {
    const execution: MigrationExecutionResult = {
      runId: "3d594650-b22c-4a9c-8fe2-906ad078afd1",
      entries: [
        {
          id: MIGRATION_A,
          direction: "up",
          status: "applied",
          attempt: 1,
          counts: { ...ZERO_COUNTS, modified: 20 },
        },
      ],
    };
    const harness = createHarness({ apply: vi.fn(async () => execution) });

    const exitCode = await runMigrationCli(
      [
        "apply",
        "--to",
        MIGRATION_A,
        "--execute",
        "--yes",
        "--confirm-db",
        "atcloud-production",
        "--json",
      ],
      environment({
        NODE_ENV: "production",
        MIGRATION_OPERATOR: "Render Release Operator",
        RENDER_GIT_COMMIT: "abc123def456",
      }),
      harness.adapters,
    );

    expect(exitCode).toBe(0);
    expect(harness.runner.apply).toHaveBeenCalledWith(MIGRATION_A);
    expect(harness.createRunner).toHaveBeenCalledTimes(1);
    expect(harness.createRunner.mock.calls[0]![0]).toMatchObject({
      connection: harness.connection,
      operator: "Render Release Operator",
      appVersion: "abc123def456",
      leaseOwner: "migration-cli:render-host.example:4321",
    });
    expect(harness.createRunner.mock.calls[0]![0].registry).toBeDefined();
    expect(harness.createRunner.mock.calls[0]![0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(harness.stdout.join("\n")).not.toContain(execution.runId!);
    expect(JSON.parse(harness.stdout[0]!)).toMatchObject({
      status: "complete",
      migrations: [{ id: MIGRATION_A, status: "applied" }],
    });
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it.each(["test", "development", "Production", undefined])(
    "requires full write confirmation regardless of NODE_ENV=%s",
    async (nodeEnv) => {
      const harness = createHarness();

      const exitCode = await runMigrationCli(
        ["apply", "--execute", "--operator", "Migration Operator", "--json"],
        environment({ NODE_ENV: nodeEnv }),
        harness.adapters,
      );

      expect(exitCode).toBe(2);
      expect(harness.createRunner).not.toHaveBeenCalled();
      expect(harness.close).toHaveBeenCalledTimes(1);
      expect(JSON.parse(harness.stderr[0]!)).toMatchObject({
        code: "MIGRATION_USAGE_ERROR",
      });
    },
  );

  it("closes the connected database when operator identity is missing", async () => {
    const harness = createHarness();
    const exitCode = await runMigrationCli(
      [
        "apply",
        "--execute",
        "--yes",
        "--confirm-db",
        "atcloud-production",
        "--json",
      ],
      environment(),
      harness.adapters,
    );

    expect(exitCode).toBe(2);
    expect(harness.asPromise).toHaveBeenCalledTimes(1);
    expect(harness.createRunner).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(harness.stderr[0]!)).toMatchObject({
      code: "MIGRATION_USAGE_ERROR",
    });
  });

  it("checks database confirmation only after connecting and always closes", async () => {
    const harness = createHarness();
    const exitCode = await runMigrationCli(
      [
        "apply",
        "--execute",
        "--yes",
        "--confirm-db",
        "wrong-database",
      ],
      environment({
        NODE_ENV: "production",
        MIGRATION_OPERATOR: "Travis Fan",
      }),
      harness.adapters,
    );

    expect(exitCode).toBe(2);
    expect(harness.asPromise).toHaveBeenCalledTimes(1);
    expect(harness.createRunner).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.stderr.join("\n")).toContain("MIGRATION_USAGE_ERROR");
    expect(harness.stderr.join("\n")).not.toContain("wrong-database");
    expect(harness.stderr.join("\n")).not.toContain("atcloud-production");
  });

  it("maps resume and rollback arguments with an allowlisted reason code", async () => {
    const reasonCode = "DATA_VALIDATION_FAILED" as const;
    const harness = createHarness();

    expect(
      await runMigrationCli(
        [
          "resume",
          MIGRATION_A,
          ...CONFIRMED_WRITE_ARGUMENTS,
          "--json",
        ],
        environment(),
        harness.adapters,
      ),
    ).toBe(0);
    expect(harness.runner.resume).toHaveBeenCalledWith(MIGRATION_A);

    expect(
      await runMigrationCli(
        [
          "rollback",
          MIGRATION_A,
          "--reason-code",
          reasonCode,
          ...CONFIRMED_WRITE_ARGUMENTS,
          "--json",
        ],
        environment(),
        harness.adapters,
      ),
    ).toBe(0);
    expect(harness.runner.rollback).toHaveBeenCalledWith(
      MIGRATION_A,
      reasonCode,
    );
    expect(harness.close).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      error: new MigrationStateConflictError("contains private state"),
      expectedCode: "MIGRATION_STATE_CONFLICT",
    },
    {
      error: new MigrationLeaseContentionError(
        new Error(`contains ${SECRET_URI}`),
      ),
      expectedCode: "MIGRATION_LEASE_CONTENDED",
    },
  ])("maps state and lease contention to exit 3", async (fixture) => {
    const harness = createHarness({
      status: vi.fn(async () => {
        throw fixture.error;
      }),
    });
    const exitCode = await runMigrationCli(
      ["status", "--json"],
      environment(),
      harness.adapters,
    );

    expect(exitCode).toBe(3);
    expect(JSON.parse(harness.stderr[0]!)).toEqual({
      code: fixture.expectedCode,
    });
    expect(harness.stderr.join("\n")).not.toContain("private");
    expect(harness.stderr.join("\n")).not.toContain(SECRET_URI);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("redacts migration runtime initialization failures before connecting", async () => {
    const harness = createHarness();
    const loadRuntime = vi.fn(async () => {
      throw new Error(`registry initialization exposed ${SECRET_URI}`);
    });

    const exitCode = await runMigrationCli(
      ["status", "--json"],
      environment(),
      { ...harness.adapters, loadRuntime },
    );

    expect(exitCode).toBe(1);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(harness.createConnection).not.toHaveBeenCalled();
    expect(harness.addSignalListener).not.toHaveBeenCalled();
    expect(harness.stdout).toEqual([]);
    expect(JSON.parse(harness.stderr[0]!)).toEqual({
      code: "MIGRATION_EXECUTION_FAILED",
    });
    expect(harness.stderr.join("\n")).not.toContain(SECRET_URI);
  });

  it("maps unexpected execution and connection failures to a redacted exit 1", async () => {
    const executionHarness = createHarness({
      status: vi.fn(async () => {
        throw new Error(`failed while connecting to ${SECRET_URI}`);
      }),
    });
    expect(
      await runMigrationCli(
        ["status", "--json"],
        environment(),
        executionHarness.adapters,
      ),
    ).toBe(1);
    expect(JSON.parse(executionHarness.stderr[0]!)).toEqual({
      code: "MIGRATION_EXECUTION_FAILED",
    });

    const connectionHarness = createHarness();
    connectionHarness.asPromise.mockRejectedValueOnce(
      new Error(`cannot reach ${SECRET_URI}`),
    );
    expect(
      await runMigrationCli(
        ["status"],
        environment(),
        connectionHarness.adapters,
      ),
    ).toBe(1);
    expect(connectionHarness.stderr).toEqual(["MIGRATION_EXECUTION_FAILED"]);
    expect(connectionHarness.stderr.join("\n")).not.toContain(SECRET_URI);
    expect(connectionHarness.close).toHaveBeenCalledTimes(1);
  });

  it("redacts a connection-close failure and does not emit stale success output", async () => {
    const harness = createHarness();
    harness.close.mockRejectedValueOnce(
      new Error(`close failed for ${SECRET_URI}`),
    );

    const exitCode = await runMigrationCli(
      ["status", "--json"],
      environment(),
      harness.adapters,
    );

    expect(exitCode).toBe(1);
    expect(harness.stdout).toEqual([]);
    expect(JSON.parse(harness.stderr[0]!)).toEqual({
      code: "MIGRATION_EXECUTION_FAILED",
    });
    expect(harness.stderr.join("\n")).not.toContain(SECRET_URI);
  });

  it("uses a safe app-version fallback and sanitizes lease ownership", async () => {
    const harness = createHarness();
    const adapters: MigrationCliAdapters = {
      ...harness.adapters,
      hostname: () => " hostile host/name\nwith controls ",
      pid: -10,
      packageVersion: "2.3.4",
    };
    const exitCode = await runMigrationCli(
      ["apply", ...CONFIRMED_WRITE_ARGUMENTS],
      environment({
        RENDER_GIT_COMMIT: `bad value ${SECRET_URI}`,
        APP_VERSION: "also unsafe value",
      }),
      adapters,
    );

    expect(exitCode).toBe(0);
    expect(harness.createRunner.mock.calls[0]![0]).toMatchObject({
      appVersion: "2.3.4",
      leaseOwner: "migration-cli:hostile-host-name-with-controls-:0",
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "propagates %s through an AbortSignal, exits nonzero, and removes handlers",
    async (signalName) => {
      const harness = createHarness();
      let observedSignal: AbortSignal | undefined;
      harness.createRunner.mockImplementationOnce((options) => {
        observedSignal = options.signal;
        return {
          ...harness.runner,
          status: vi.fn(async () => {
            harness.listeners.get(signalName)?.();
            return EMPTY_STATUS;
          }),
        };
      });

      expect(
        await runMigrationCli(
          ["status", "--json"],
          environment(),
          harness.adapters,
        ),
      ).toBe(1);
      expect(observedSignal?.aborted).toBe(true);
      expect(harness.stdout).toEqual([]);
      expect(JSON.parse(harness.stderr[0]!)).toEqual({
        code: "MIGRATION_INTERRUPTED",
      });
      expect(harness.addSignalListener).toHaveBeenCalledTimes(2);
      expect(harness.removeSignalListener).toHaveBeenCalledTimes(2);
      expect(harness.listeners.size).toBe(0);
      expect(harness.close).toHaveBeenCalledTimes(1);
    },
  );
});
