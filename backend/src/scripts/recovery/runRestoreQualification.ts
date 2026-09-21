import { lstat, readFile } from "node:fs/promises";
import mongoose, { type ConnectOptions } from "mongoose";
import {
  assertRestoreIsolationDatabase,
  assertRestoreIsolationConfiguration,
  RestoreIsolationConfigurationError,
  type RestoreIsolationEnvironment,
} from "../../config/restoreIsolation";
import {
  RestoreQualificationInputError,
  RestoreQualificationService,
  type RestoreQualificationReport,
} from "../../services/operations/RestoreQualificationService";
import {
  formatRestoreQualificationCliUsage,
  parseRestoreQualificationCliArguments,
  RestoreQualificationCliUsageError,
} from "./cliArguments";

const CONNECTION_OPTIONS: Readonly<ConnectOptions> = Object.freeze({
  autoCreate: false,
  autoIndex: false,
  bufferCommands: false,
  connectTimeoutMS: 10_000,
  maxPoolSize: 5,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  appName: "atcloud-restore-qualification-cli",
});
const MAX_MANIFEST_FILE_BYTES = 2 * 1024 * 1024;

type RestoreQualificationCliExitCode = 0 | 1 | 2 | 3;

export interface RestoreQualificationCliEnvironment
  extends RestoreIsolationEnvironment {
  readonly MONGODB_URI?: string;
  readonly [key: string]: string | undefined;
}

export interface RestoreQualificationCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

interface ConnectionHandle {
  readonly databaseName: string;
  close(): Promise<void>;
}

interface RestoreQualificationCliRuntime {
  readonly createService: () => Pick<
    RestoreQualificationService,
    "inspect" | "verify"
  >;
}

export interface RestoreQualificationCliAdapters {
  readonly io?: Partial<RestoreQualificationCliIo>;
  readonly connect?: (
    uri: string,
    options: ConnectOptions,
  ) => Promise<ConnectionHandle>;
  readonly readManifest?: (path: string) => Promise<unknown>;
  readonly loadRuntime?: () => Promise<RestoreQualificationCliRuntime>;
}

const DEFAULT_IO: RestoreQualificationCliIo = {
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
      throw new RestoreQualificationCliUsageError(
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

async function defaultReadManifest(path: string): Promise<unknown> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new RestoreQualificationCliUsageError(
      "The restore manifest cannot be read.",
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_MANIFEST_FILE_BYTES
  ) {
    throw new RestoreQualificationCliUsageError(
      "The restore manifest must be a regular file no larger than 2 MiB.",
    );
  }
  let text: string;
  try {
    text = (await readFile(path)).toString("utf8");
  } catch {
    throw new RestoreQualificationCliUsageError(
      "The restore manifest cannot be read.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RestoreQualificationCliUsageError(
      "The restore manifest must contain JSON.",
    );
  }
}

async function loadDefaultRuntime(): Promise<RestoreQualificationCliRuntime> {
  return Object.freeze({
    createService: () => new RestoreQualificationService(mongoose.connection),
  });
}

function requireMongoUri(environment: RestoreQualificationCliEnvironment): string {
  const value = environment.MONGODB_URI;
  if (!value || value.trim() !== value || value.length > 4_096) {
    throw new RestoreQualificationCliUsageError(
      "MONGODB_URI must be supplied through the environment.",
    );
  }
  return value;
}

function classifyError(error: unknown): {
  readonly code: string;
  readonly exitCode: Exclude<RestoreQualificationCliExitCode, 0>;
  readonly usage: boolean;
} {
  if (
    error instanceof RestoreQualificationCliUsageError ||
    error instanceof RestoreQualificationInputError
  ) {
    return {
      code: "RESTORE_QUALIFICATION_CLI_USAGE_ERROR",
      exitCode: 2,
      usage: true,
    };
  }
  if (error instanceof RestoreIsolationConfigurationError) {
    return {
      code: error.code,
      exitCode: 3,
      usage: false,
    };
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
    code: "RESTORE_QUALIFICATION_CLI_EXECUTION_FAILED",
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
      ...(error.usage ? { usage: formatRestoreQualificationCliUsage() } : {}),
    });
  }
  return error.usage
    ? `${error.code}\n${formatRestoreQualificationCliUsage()}`
    : error.code;
}

/**
 * Executes a read-only qualification against an isolated restore database.
 * It deliberately does not start HTTP, Socket.IO, schedulers, model index
 * initialization, the durable outbox worker, or any delivery handler.
 */
export async function runRestoreQualificationCli(
  argv: readonly string[],
  environment: RestoreQualificationCliEnvironment,
  adapters: RestoreQualificationCliAdapters = {},
): Promise<RestoreQualificationCliExitCode> {
  const io: RestoreQualificationCliIo = {
    stdout: adapters.io?.stdout ?? DEFAULT_IO.stdout,
    stderr: adapters.io?.stderr ?? DEFAULT_IO.stderr,
  };
  const wantsJson = argv.includes("--json");
  let connection: ConnectionHandle | undefined;
  let output: RestoreQualificationReport | undefined;
  let failure: unknown;

  try {
    const arguments_ = parseRestoreQualificationCliArguments(argv);
    assertRestoreIsolationConfiguration(environment);
    const uri = requireMongoUri(environment);
    connection = await (adapters.connect ?? defaultConnect)(uri, {
      ...CONNECTION_OPTIONS,
    });
    if (connection.databaseName !== arguments_.confirmDb) {
      throw new RestoreQualificationCliUsageError(
        "--confirm-db must exactly match the connected database name.",
      );
    }
    assertRestoreIsolationDatabase(environment, connection.databaseName);
    const runtime = await (adapters.loadRuntime ?? loadDefaultRuntime)();
    const service = runtime.createService();
    output =
      arguments_.command === "inspect"
        ? await service.inspect()
        : await service.verify(
            await (adapters.readManifest ?? defaultReadManifest)(
              arguments_.manifest,
            ),
          );
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
    io.stderr("RESTORE_QUALIFICATION_CLI_EXECUTION_FAILED");
    return 1;
  }
  io.stdout(JSON.stringify(output));
  return output.status === "passed" ? 0 : 3;
}

if (require.main === module) {
  void runRestoreQualificationCli(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
  );
}
