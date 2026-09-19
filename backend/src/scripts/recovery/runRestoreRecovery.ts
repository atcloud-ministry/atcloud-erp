import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import mongoose, { type ConnectOptions } from "mongoose";
import {
  assertRestoreIsolationDatabase,
  assertRestoreIsolationConfiguration,
  RestoreIsolationConfigurationError,
  type RestoreIsolationEnvironment,
} from "../../config/restoreIsolation";
import {
  parseRestoreAccountDeletionManifest,
  RestoreRecoveryInputError,
  RestoreRecoveryService,
  RestoreRecoveryTransactionTopologyError,
  type RestoreRecoveryReport,
} from "../../services/operations/RestoreRecoveryService";
import {
  formatRestoreRecoveryCliUsage,
  parseRestoreRecoveryCliArguments,
  RestoreRecoveryCliUsageError,
} from "./reconciliationCliArguments";

const CONNECTION_OPTIONS: Readonly<ConnectOptions> = Object.freeze({
  autoCreate: false,
  autoIndex: false,
  bufferCommands: false,
  connectTimeoutMS: 10_000,
  maxPoolSize: 5,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  appName: "atcloud-restore-recovery-cli",
});
const MAX_MANIFEST_FILE_BYTES = 2 * 1024 * 1024;

type RestoreRecoveryCliExitCode = 0 | 1 | 2 | 3;

export interface RestoreRecoveryCliEnvironment extends RestoreIsolationEnvironment {
  readonly MONGODB_URI?: string;
  readonly [key: string]: string | undefined;
}

export interface RestoreRecoveryCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

interface ConnectionHandle {
  readonly databaseName: string;
  close(): Promise<void>;
}

interface RestoreRecoveryCliRuntime {
  readonly createService: () => Pick<RestoreRecoveryService, "run">;
}

export interface RestoreRecoveryCliAdapters {
  readonly io?: Partial<RestoreRecoveryCliIo>;
  readonly connect?: (
    uri: string,
    options: ConnectOptions,
  ) => Promise<ConnectionHandle>;
  readonly readAccountDeletionManifest?: (path: string) => Promise<unknown>;
  readonly loadRuntime?: () => Promise<RestoreRecoveryCliRuntime>;
}

const DEFAULT_IO: RestoreRecoveryCliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

async function defaultConnect(
  uri: string,
  options: ConnectOptions,
): Promise<ConnectionHandle> {
  try {
    await mongoose.connect(uri, options);
    const databaseName = mongoose.connection.db?.databaseName;
    if (!databaseName) {
      throw new RestoreRecoveryCliUsageError(
        "The connected database name is unavailable.",
      );
    }
    return Object.freeze({
      databaseName,
      close: async () => {
        await mongoose.disconnect();
      },
    });
  } catch (error) {
    await mongoose.disconnect().catch(() => undefined);
    throw error;
  }
}

async function defaultReadAccountDeletionManifest(path: string): Promise<unknown> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new RestoreRecoveryCliUsageError(
      "The account deletion manifest cannot be read.",
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_MANIFEST_FILE_BYTES
  ) {
    throw new RestoreRecoveryCliUsageError(
      "The account deletion manifest must be a regular file no larger than 2 MiB.",
    );
  }
  let text: string;
  try {
    text = (await readFile(path)).toString("utf8");
  } catch {
    throw new RestoreRecoveryCliUsageError(
      "The account deletion manifest cannot be read.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RestoreRecoveryCliUsageError(
      "The account deletion manifest must contain JSON.",
    );
  }
}

async function loadDefaultRuntime(): Promise<RestoreRecoveryCliRuntime> {
  return Object.freeze({
    createService: () => new RestoreRecoveryService(),
  });
}

function requireMongoUri(environment: RestoreRecoveryCliEnvironment): string {
  const value = environment.MONGODB_URI;
  if (!value || value.trim() !== value || value.length > 4_096) {
    throw new RestoreRecoveryCliUsageError(
      "MONGODB_URI must be supplied through the environment.",
    );
  }
  return value;
}

function operatorCorrelationId(operator: string): string {
  // A release code is retained only as a one-way audit correlation value and
  // is excluded from CLI output and report DTOs.
  return `restore-${createHash("sha256")
    .update(operator)
    .digest("hex")
    .slice(0, 48)}`;
}

function classifyError(error: unknown): {
  readonly code: string;
  readonly exitCode: Exclude<RestoreRecoveryCliExitCode, 0>;
  readonly usage: boolean;
} {
  if (
    error instanceof RestoreRecoveryCliUsageError ||
    error instanceof RestoreRecoveryInputError
  ) {
    return {
      code: "RESTORE_RECOVERY_CLI_USAGE_ERROR",
      exitCode: 2,
      usage: true,
    };
  }
  if (error instanceof RestoreIsolationConfigurationError) {
    return { code: error.code, exitCode: 3, usage: false };
  }
  if (error instanceof RestoreRecoveryTransactionTopologyError) {
    return { code: error.code, exitCode: 3, usage: false };
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,119}$/.test(error.code)
  ) {
    return { code: error.code, exitCode: 3, usage: false };
  }
  return {
    code: "RESTORE_RECOVERY_CLI_EXECUTION_FAILED",
    exitCode: 1,
    usage: false,
  };
}

function formatError(
  error: ReturnType<typeof classifyError>,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify({
      code: error.code,
      ...(error.usage ? { usage: formatRestoreRecoveryCliUsage() } : {}),
    });
  }
  return error.usage
    ? `${error.code}\n${formatRestoreRecoveryCliUsage()}`
    : error.code;
}

/**
 * Executes one explicitly-confirmed recovery batch against the isolated
 * restore database.  This entry point never starts HTTP, Socket.IO,
 * schedulers, a service worker, or notification delivery.
 */
export async function runRestoreRecoveryCli(
  argv: readonly string[],
  environment: RestoreRecoveryCliEnvironment,
  adapters: RestoreRecoveryCliAdapters = {},
): Promise<RestoreRecoveryCliExitCode> {
  const io: RestoreRecoveryCliIo = {
    stdout: adapters.io?.stdout ?? DEFAULT_IO.stdout,
    stderr: adapters.io?.stderr ?? DEFAULT_IO.stderr,
  };
  const wantsJson = argv.includes("--json");
  let connection: ConnectionHandle | undefined;
  let output: RestoreRecoveryReport | undefined;
  let failure: unknown;

  try {
    const arguments_ = parseRestoreRecoveryCliArguments(argv);
    assertRestoreIsolationConfiguration(environment);
    const uri = requireMongoUri(environment);
    connection = await (adapters.connect ?? defaultConnect)(uri, {
      ...CONNECTION_OPTIONS,
    });
    if (connection.databaseName !== arguments_.confirmDb) {
      throw new RestoreRecoveryCliUsageError(
        "--confirm-db must exactly match the connected database name.",
      );
    }
    assertRestoreIsolationDatabase(environment, connection.databaseName);
    const rawManifest = await (
      adapters.readAccountDeletionManifest ?? defaultReadAccountDeletionManifest
    )(arguments_.accountDeletionManifest);
    const accountDeletionManifest = parseRestoreAccountDeletionManifest(rawManifest);
    const runtime = await (adapters.loadRuntime ?? loadDefaultRuntime)();
    output = await runtime.createService().run({
      accountDeletionManifest,
      idempotencyKey: arguments_.idempotencyKey,
      correlationId: operatorCorrelationId(arguments_.operator),
    });
  } catch (error) {
    failure = error;
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
  }

  if (failure !== undefined) {
    const classified = classifyError(failure);
    io.stderr(formatError(classified, wantsJson));
    return classified.exitCode;
  }
  if (!output) {
    io.stderr("RESTORE_RECOVERY_CLI_EXECUTION_FAILED");
    return 1;
  }
  io.stdout(JSON.stringify(output));
  return output.status === "completed" ? 0 : 3;
}

if (require.main === module) {
  void runRestoreRecoveryCli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
