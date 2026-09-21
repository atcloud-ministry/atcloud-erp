import { hostname as readHostname } from "node:os";
import mongoose, {
  type ConnectOptions,
  type Connection,
} from "mongoose";
import packageMetadata from "../../../package.json";
import {
  MIGRATION_ID_PATTERN,
  SCHEMA_MIGRATION_STATUSES,
  type MigrationCounts,
  type MigrationRollbackReasonCode,
} from "../../migrations/types";
import {
  MigrationExecutionError,
  MigrationStateConflictError,
  MigrationUsageError,
} from "../../services/migrations/MigrationErrors";
import {
  MigrationLeaseContentionError,
  MigrationLeaseLostError,
  MigrationLeaseUsageError,
} from "../../services/migrations/MigrationLeaseService";
import type {
  MigrationDryRunResult,
  MigrationExecutionResult,
  MigrationRunnerOptions,
  MigrationStatusResult,
} from "../../services/migrations/MigrationRunner";
import {
  UsageError,
  assertMigrationWriteConfirmation,
  formatMigrationUsage,
  isMigrationWriteArguments,
  parseMigrationCliArguments,
  type ParsedMigrationArguments,
} from "./cliArguments";

const CONNECTION_OPTIONS: Readonly<ConnectOptions> = Object.freeze({
  autoCreate: false,
  autoIndex: false,
  bufferCommands: false,
  connectTimeoutMS: 10_000,
  maxPoolSize: 5,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  appName: "atcloud-schema-migration-cli",
});

const SAFE_APP_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const SAFE_OPERATOR_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;
const SAFE_STATUS_VALUES = new Set<string>([
  ...SCHEMA_MIGRATION_STATUSES,
  "pending",
  "planned",
]);
const SAFE_STATUS_ISSUE_CODES = new Set<string>([
  "INVALID_LEDGER_RECORD",
  "UNKNOWN_LEDGER_VERSION",
  "CHECKSUM_DRIFT",
  "VERSION_GAP",
  "MULTIPLE_RECOVERY_POINTS",
]);
const RECOVERY_REQUIRED_STATUSES = new Set<string>([
  "applying",
  "apply_failed",
  "rolling_back",
  "rollback_failed",
]);

type MigrationCliExitCode = 0 | 1 | 2 | 3;
type MigrationSignal = "SIGINT" | "SIGTERM";

export interface MigrationCliEnvironment {
  readonly MONGODB_URI?: string;
  readonly MIGRATION_OPERATOR?: string;
  readonly RENDER_GIT_COMMIT?: string;
  readonly APP_VERSION?: string;
  readonly [key: string]: string | undefined;
}

export interface MigrationCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface MigrationRunnerPort {
  status(): Promise<MigrationStatusResult>;
  dryRun(target?: string): Promise<MigrationDryRunResult>;
  apply(target?: string): Promise<MigrationExecutionResult>;
  resume(migrationId?: string): Promise<MigrationExecutionResult>;
  rollback(
    migrationId: string,
    reasonCode: MigrationRollbackReasonCode,
  ): Promise<MigrationExecutionResult>;
}

export interface MigrationCliRuntime {
  readonly registry: NonNullable<MigrationRunnerOptions["registry"]>;
  readonly createRunner: (
    options: MigrationRunnerOptions,
  ) => MigrationRunnerPort;
}

export interface MigrationCliAdapters {
  readonly io?: Partial<MigrationCliIo>;
  readonly createConnection?: (
    uri: string,
    options: ConnectOptions,
  ) => Connection;
  readonly createRunner?: (
    options: MigrationRunnerOptions,
  ) => MigrationRunnerPort;
  readonly loadRuntime?: () => Promise<MigrationCliRuntime>;
  readonly hostname?: () => string;
  readonly pid?: number;
  readonly packageVersion?: string;
  readonly addSignalListener?: (
    signal: MigrationSignal,
    listener: () => void,
  ) => void;
  readonly removeSignalListener?: (
    signal: MigrationSignal,
    listener: () => void,
  ) => void;
}

interface SafeCounts {
  readonly [key: string]: number;
}

interface SafeTimestamps {
  readonly [key: string]: string | null;
}

interface SafeMigrationOutput {
  readonly id?: string;
  readonly status: string;
  readonly counts: SafeCounts;
  readonly timestamps?: SafeTimestamps;
}

interface SafeIssueOutput {
  readonly code: string;
  readonly id?: string;
  readonly count?: number;
}

interface SafeCliOutput {
  readonly status: string;
  readonly counts: SafeCounts;
  readonly timestamps?: SafeTimestamps;
  readonly migrations: readonly SafeMigrationOutput[];
  readonly issues: readonly SafeIssueOutput[];
}

interface ClassifiedError {
  readonly code: string;
  readonly exitCode: Exclude<MigrationCliExitCode, 0>;
  readonly includeUsage: boolean;
}

interface ExecutedCommand {
  readonly output: SafeCliOutput;
  readonly exitCode: 0 | 3;
}

const DEFAULT_IO: MigrationCliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

async function loadDefaultRuntime(): Promise<MigrationCliRuntime> {
  const [{ MIGRATION_REGISTRY }, { MigrationRunner }] = await Promise.all([
    import("../../migrations/registry"),
    import("../../services/migrations/MigrationRunner"),
  ]);
  return {
    registry: MIGRATION_REGISTRY,
    createRunner: (options) => new MigrationRunner(options),
  };
}

function requireMongoUri(environment: MigrationCliEnvironment): string {
  const uri = environment.MONGODB_URI;
  if (
    typeof uri !== "string" ||
    uri.length === 0 ||
    uri.trim() !== uri
  ) {
    throw new UsageError("A valid database connection environment is required.");
  }
  return uri;
}

function normalizeOperator(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    !SAFE_OPERATOR_PATTERN.test(normalized)
  ) {
    throw new UsageError("A valid migration operator is required.");
  }
  return normalized;
}

function resolveOperator(
  arguments_: ParsedMigrationArguments,
  environment: MigrationCliEnvironment,
): string {
  if (!isMigrationWriteArguments(arguments_)) return "read-only";

  const configured = arguments_.operator ?? environment.MIGRATION_OPERATOR;
  if (configured !== undefined && configured.trim().length > 0) {
    return normalizeOperator(configured);
  }
  throw new UsageError("Migration writes require an explicit operator.");
}

function safeAppVersion(
  environment: MigrationCliEnvironment,
  packageVersion: string,
): string {
  for (const candidate of [
    environment.RENDER_GIT_COMMIT,
    environment.APP_VERSION,
    packageVersion,
  ]) {
    if (
      typeof candidate === "string" &&
      candidate.trim() === candidate &&
      SAFE_APP_VERSION_PATTERN.test(candidate)
    ) {
      return candidate;
    }
  }
  return "unknown";
}

function safeLeaseOwner(hostname: string, pid: number): string {
  const safeHost = hostname
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 90) || "host";
  const safePid = Number.isSafeInteger(pid) && pid >= 0 ? pid : 0;
  return `migration-cli:${safeHost}:${safePid}`.slice(0, 128);
}

function safeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : 0;
}

function safeCountSum(total: number, value: unknown): number {
  const sum = total + safeInteger(value);
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

function safeWarningCode(value: unknown): string {
  return typeof value === "string" && SAFE_CODE_PATTERN.test(value)
    ? value
    : "MIGRATION_PLAN_WARNING";
}

function safeMigrationCounts(counts: MigrationCounts): SafeCounts {
  return {
    examined: safeInteger(counts.examined),
    matched: safeInteger(counts.matched),
    modified: safeInteger(counts.modified),
    skipped: safeInteger(counts.skipped),
    errors: safeInteger(counts.errors),
  };
}

function safeMigrationId(value: unknown): string | undefined {
  return typeof value === "string" && MIGRATION_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function safeStatus(value: unknown): string {
  return typeof value === "string" && SAFE_STATUS_VALUES.has(value)
    ? value
    : "invalid";
}

function safeIsoDate(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return null;
  }
  return value.toISOString();
}

function statusRequiresRecovery(result: MigrationStatusResult): boolean {
  return (
    result.recoveryRequired ||
    result.entries.some((entry) =>
      RECOVERY_REQUIRED_STATUSES.has(entry.status),
    )
  );
}

function projectStatus(result: MigrationStatusResult): SafeCliOutput {
  const recoveryRequired = statusRequiresRecovery(result);
  let status = "healthy";
  if (!result.healthy) status = "issues";
  if (recoveryRequired) status = "recovery-required";
  return {
    status,
    counts: {
      applied: safeInteger(result.appliedCount),
      pending: safeInteger(result.pendingCount),
      migrations: safeInteger(result.entries.length),
      issues: safeInteger(result.issues.length),
    },
    migrations: result.entries.map((entry) => ({
      ...(safeMigrationId(entry.id) ? { id: entry.id } : {}),
      status: safeStatus(entry.status),
      counts: {
        ...safeMigrationCounts(entry.counts),
        attempts: safeInteger(entry.attempt),
      },
      timestamps: {
        appliedAt: safeIsoDate(entry.appliedAt),
        rolledBackAt: safeIsoDate(entry.rolledBackAt),
      },
    })),
    issues: result.issues.map((issue) => ({
      code: SAFE_STATUS_ISSUE_CODES.has(issue.code)
        ? issue.code
        : "MIGRATION_STATUS_ISSUE",
      ...(safeMigrationId(issue.migrationId)
        ? { id: issue.migrationId }
        : {}),
    })),
  };
}

function projectDryRun(result: MigrationDryRunResult): SafeCliOutput {
  const warningCount = result.entries.reduce(
    (total, entry) =>
      entry.plan.warnings.reduce(
        (migrationTotal, warning) =>
          safeCountSum(migrationTotal, warning.count),
        total,
      ),
    0,
  );
  return {
    status: "planned",
    counts: {
      migrations: safeInteger(result.entries.length),
      warnings: safeInteger(warningCount),
    },
    timestamps: { observedAt: safeIsoDate(result.observedAt) },
    migrations: result.entries.map((entry) => ({
      ...(safeMigrationId(entry.id) ? { id: entry.id } : {}),
      status: "planned",
      counts: {
        ...safeMigrationCounts(entry.plan.counts),
        estimatedBatches: safeInteger(entry.plan.estimatedBatches),
        warnings: entry.plan.warnings.reduce(
          (total, warning) => safeCountSum(total, warning.count),
          0,
        ),
      },
    })),
    issues: result.entries.flatMap((entry) =>
      entry.plan.warnings.map((warning) => ({
        code: safeWarningCode(warning.code),
        ...(safeMigrationId(entry.id) ? { id: entry.id } : {}),
        count: safeInteger(warning.count),
      })),
    ),
  };
}

function projectExecution(result: MigrationExecutionResult): SafeCliOutput {
  return {
    status: result.entries.length === 0 ? "no-op" : "complete",
    counts: { migrations: safeInteger(result.entries.length) },
    migrations: result.entries.map((entry) => ({
      ...(safeMigrationId(entry.id) ? { id: entry.id } : {}),
      status: safeStatus(entry.status),
      counts: {
        ...safeMigrationCounts(entry.counts),
        attempts: safeInteger(entry.attempt),
      },
    })),
    issues: [],
  };
}

function formatCounts(counts: SafeCounts): string {
  return Object.entries(counts)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
}

function formatTextOutput(output: SafeCliOutput): string {
  const lines = [`status=${output.status} ${formatCounts(output.counts)}`];
  if (output.timestamps) {
    const timestamps = Object.entries(output.timestamps)
      .map(([name, value]) => `${name}=${value ?? "none"}`)
      .join(" ");
    if (timestamps) lines.push(`timestamps ${timestamps}`);
  }
  for (const migration of output.migrations) {
    const id = migration.id ? ` id=${migration.id}` : "";
    const timestamps = migration.timestamps
      ? ` ${Object.entries(migration.timestamps)
          .map(([name, value]) => `${name}=${value ?? "none"}`)
          .join(" ")}`
      : "";
    lines.push(
      `migration${id} status=${migration.status} ${formatCounts(migration.counts)}${timestamps}`,
    );
  }
  for (const issue of output.issues) {
    const id = issue.id ? ` id=${issue.id}` : "";
    const count = issue.count === undefined ? "" : ` count=${issue.count}`;
    lines.push(`issue code=${issue.code}${id}${count}`);
  }
  return lines.join("\n");
}

function classifyError(error: unknown): ClassifiedError {
  if (
    error instanceof UsageError ||
    error instanceof MigrationUsageError ||
    error instanceof MigrationLeaseUsageError
  ) {
    return {
      code: "MIGRATION_USAGE_ERROR",
      exitCode: 2,
      includeUsage: true,
    };
  }
  if (error instanceof MigrationStateConflictError) {
    return {
      code: error.code,
      exitCode: 3,
      includeUsage: false,
    };
  }
  if (error instanceof MigrationLeaseContentionError) {
    return {
      code: error.code,
      exitCode: 3,
      includeUsage: false,
    };
  }
  if (error instanceof MigrationLeaseLostError) {
    return {
      code: error.code,
      exitCode: 3,
      includeUsage: false,
    };
  }
  if (error instanceof MigrationExecutionError) {
    return {
      code: error.code,
      exitCode: 1,
      includeUsage: false,
    };
  }
  return {
    code: "MIGRATION_EXECUTION_FAILED",
    exitCode: 1,
    includeUsage: false,
  };
}

function formatError(error: ClassifiedError, json: boolean): string {
  if (json) {
    return JSON.stringify({
      code: error.code,
      ...(error.includeUsage ? { usage: formatMigrationUsage() } : {}),
    });
  }
  return error.includeUsage
    ? `${error.code}\n${formatMigrationUsage()}`
    : error.code;
}

async function executeCommand(
  arguments_: ParsedMigrationArguments,
  runner: MigrationRunnerPort,
): Promise<ExecutedCommand> {
  switch (arguments_.command) {
    case "status": {
      const result = await runner.status();
      return {
        output: projectStatus(result),
        exitCode:
          result.healthy && !statusRequiresRecovery(result) ? 0 : 3,
      };
    }
    case "dry-run":
      return {
        output: projectDryRun(await runner.dryRun(arguments_.to)),
        exitCode: 0,
      };
    case "apply":
      return {
        output: projectExecution(await runner.apply(arguments_.to)),
        exitCode: 0,
      };
    case "resume":
      return {
        output: projectExecution(await runner.resume(arguments_.migrationId)),
        exitCode: 0,
      };
    case "rollback":
      return {
        output: projectExecution(
          await runner.rollback(
            arguments_.migrationId,
            arguments_.reasonCode,
          ),
        ),
        exitCode: 0,
      };
  }
}

/**
 * Runs the isolated migration command. The adapter accepts all external
 * effects as dependencies so tests never open a real connection or mutate
 * process signal state.
 */
export async function runMigrationCli(
  argv: readonly string[],
  environment: MigrationCliEnvironment,
  adapters: MigrationCliAdapters = {},
): Promise<MigrationCliExitCode> {
  const io: MigrationCliIo = {
    stdout: adapters.io?.stdout ?? DEFAULT_IO.stdout,
    stderr: adapters.io?.stderr ?? DEFAULT_IO.stderr,
  };
  const createConnection =
    adapters.createConnection ??
    ((uri: string, options: ConnectOptions) =>
      mongoose.createConnection(uri, options));
  const addSignalListener =
    adapters.addSignalListener ??
    ((signal: MigrationSignal, listener: () => void) =>
      process.on(signal, listener));
  const removeSignalListener =
    adapters.removeSignalListener ??
    ((signal: MigrationSignal, listener: () => void) =>
      process.removeListener(signal, listener));

  const wantsJson = argv.includes("--json");
  let connection: Connection | undefined;
  let output: SafeCliOutput | undefined;
  let successExitCode: 0 | 3 = 0;
  let failure: unknown;
  let signalListenersAttached = false;
  let interrupted = false;
  const abortController = new AbortController();
  const abort = (): void => {
    interrupted = true;
    abortController.abort();
  };

  try {
    const arguments_ = parseMigrationCliArguments(argv);
    const uri = requireMongoUri(environment);
    const runtime = await (adapters.loadRuntime ?? loadDefaultRuntime)();
    const createRunner = adapters.createRunner ?? runtime.createRunner;

    addSignalListener("SIGINT", abort);
    addSignalListener("SIGTERM", abort);
    signalListenersAttached = true;

    connection = createConnection(uri, { ...CONNECTION_OPTIONS });
    connection = await connection.asPromise();
    const databaseName = connection.db?.databaseName;
    if (typeof databaseName !== "string" || databaseName.length === 0) {
      throw new UsageError("The connected database name is unavailable.");
    }

    assertMigrationWriteConfirmation(arguments_, {
      databaseName,
    });
    const operator = resolveOperator(arguments_, environment);
    const runner = createRunner({
      connection,
      operator,
      appVersion: safeAppVersion(
        environment,
        adapters.packageVersion ?? packageMetadata.version,
      ),
      leaseOwner: safeLeaseOwner(
        (adapters.hostname ?? readHostname)(),
        adapters.pid ?? process.pid,
      ),
      registry: runtime.registry,
      signal: abortController.signal,
    });
    const executed = await executeCommand(arguments_, runner);
    output = executed.output;
    successExitCode = executed.exitCode;
  } catch (error) {
    failure = error;
  } finally {
    if (signalListenersAttached) {
      removeSignalListener("SIGINT", abort);
      removeSignalListener("SIGTERM", abort);
    }
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }

  if (interrupted) {
    io.stderr(
      formatError(
        {
          code: "MIGRATION_INTERRUPTED",
          exitCode: 1,
          includeUsage: false,
        },
        wantsJson,
      ),
    );
    return 1;
  }

  if (failure !== undefined) {
    const classified = classifyError(failure);
    io.stderr(formatError(classified, wantsJson));
    return classified.exitCode;
  }

  if (!output) {
    io.stderr("MIGRATION_EXECUTION_FAILED");
    return 1;
  }
  io.stdout(wantsJson ? JSON.stringify(output) : formatTextOutput(output));
  return successExitCode;
}

if (require.main === module) {
  void runMigrationCli(process.argv.slice(2), process.env).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
