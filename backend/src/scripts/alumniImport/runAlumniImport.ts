import { readFile, stat } from "node:fs/promises";
import mongoose, { type ConnectOptions } from "mongoose";
import type {
  AlumniImportSourceExpectation,
  AlumniImportSourceInspectionReport,
  AlumniImportQualificationReport,
  AlumniImportQualificationService,
} from "../../services/alumni/AlumniImportQualificationService";
import type { AlumniImportService } from "../../services/alumni/AlumniImportService";
import {
  AlumniImportCliUsageError,
  assertAlumniImportWriteConfirmation,
  formatAlumniImportCliUsage,
  isAlumniImportWriteArguments,
  parseAlumniImportCliArguments,
  type AlumniImportCliArguments,
} from "./cliArguments";

const CONNECTION_OPTIONS: Readonly<ConnectOptions> = Object.freeze({
  autoCreate: false,
  autoIndex: false,
  bufferCommands: false,
  connectTimeoutMS: 10_000,
  maxPoolSize: 5,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  appName: "atcloud-alumni-import-cli",
});
const SAFE_OPERATOR_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;

type AlumniImportCliExitCode = 0 | 1 | 2 | 3;

export interface AlumniImportCliEnvironment {
  readonly MONGODB_URI?: string;
  readonly ALUMNI_IMPORT_OPERATOR?: string;
  readonly [key: string]: string | undefined;
}

export interface AlumniImportCliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

interface AlumniImportCliRuntime {
  readonly qualification: Pick<
    AlumniImportQualificationService,
    | "inspectSource"
    | "assertExpectedSource"
    | "assertOperatorActor"
    | "assertOperationalGates"
    | "assertCancellationGates"
    | "verifyBatch"
  >;
  readonly imports: Pick<AlumniImportService, "dryRun" | "cancel">;
}

interface ConnectionHandle {
  readonly databaseName: string;
  close(): Promise<void>;
}

export interface AlumniImportCliAdapters {
  readonly io?: Partial<AlumniImportCliIo>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly connect?: (
    uri: string,
    options: ConnectOptions,
  ) => Promise<ConnectionHandle>;
  readonly loadRuntime?: () => Promise<AlumniImportCliRuntime>;
}

interface CancelOutput {
  readonly schemaVersion: 1;
  readonly kind: "alumni_import_cancellation";
  readonly status: "passed";
  readonly batch: {
    readonly id: string;
    readonly status: "cancelled";
    readonly revision: number;
    readonly checksum: string;
    readonly totalRows: number;
    readonly uniqueContacts: number;
  };
  readonly retention: {
    readonly terminalAt: string;
    readonly rawDataPurgeAt: string;
    readonly purgeAt: string;
  };
  readonly replayed: boolean;
}

const DEFAULT_IO: AlumniImportCliIo = {
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
      throw new AlumniImportCliUsageError(
        "The connected database name is unavailable.",
      );
    }
    return {
      databaseName,
      close: async () => {
        await mongoose.disconnect();
      },
    };
  } catch (error) {
    try {
      await mongoose.disconnect();
    } catch {
      // Preserve the original connection failure without leaking connection data.
    }
    throw error;
  }
}

async function defaultReadFile(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_SOURCE_FILE_BYTES) {
    throw new AlumniImportCliUsageError(
      "The roster source must be a regular file no larger than 8 MiB.",
    );
  }
  return readFile(path);
}

async function loadDefaultRuntime(): Promise<AlumniImportCliRuntime> {
  const [{ alumniImportQualificationService }, { alumniImportService }] =
    await Promise.all([
      import("../../services/alumni/AlumniImportQualificationService"),
      import("../../services/alumni/AlumniImportService"),
    ]);
  return {
    qualification: alumniImportQualificationService,
    imports: alumniImportService,
  };
}

function sourceExpectation(
  arguments_: Extract<
    AlumniImportCliArguments,
    { command: "dry-run" | "verify" | "cancel" }
  >,
): AlumniImportSourceExpectation {
  return {
    checksum: arguments_.expectedChecksum,
    totalRows: arguments_.expectedRowCount,
    uniqueContacts: arguments_.expectedUniqueContactCount,
  };
}

function requireMongoUri(environment: AlumniImportCliEnvironment): string {
  const uri = environment.MONGODB_URI;
  if (!uri || uri.trim() !== uri || uri.length > 4_096) {
    throw new AlumniImportCliUsageError(
      "MONGODB_URI must be supplied through the environment.",
    );
  }
  return uri;
}

function resolveOperator(
  arguments_: Extract<
    AlumniImportCliArguments,
    { command: "dry-run" | "cancel" }
  >,
  environment: AlumniImportCliEnvironment,
): string {
  const value = arguments_.operator ?? environment.ALUMNI_IMPORT_OPERATOR;
  if (!value || !SAFE_OPERATOR_PATTERN.test(value)) {
    throw new AlumniImportCliUsageError(
      "A non-PII operator identifier is required.",
    );
  }
  return value;
}

function classifyError(error: unknown): {
  readonly code: string;
  readonly exitCode: 1 | 2 | 3;
  readonly usage: boolean;
} {
  if (error instanceof AlumniImportCliUsageError) {
    return { code: "ALUMNI_IMPORT_CLI_USAGE_ERROR", exitCode: 2, usage: true };
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,119}$/.test(error.code)
  ) {
    const gateFailure =
      error.code === "MONGO_TRANSACTIONS_UNAVAILABLE" ||
      error.code.includes("MISMATCH") ||
      error.code.includes("CONFLICT") ||
      error.code.includes("NOT_READY") ||
      error.code.includes("UNAUTHORIZED") ||
      error.code.includes("INDEX_MISSING");
    return { code: error.code, exitCode: gateFailure ? 3 : 1, usage: false };
  }
  return {
    code: "ALUMNI_IMPORT_CLI_EXECUTION_FAILED",
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
      ...(error.usage ? { usage: formatAlumniImportCliUsage() } : {}),
    });
  }
  return error.usage
    ? `${error.code}\n${formatAlumniImportCliUsage()}`
    : error.code;
}

function connectionRequired(
  value: AlumniImportCliArguments,
): value is Exclude<AlumniImportCliArguments, { command: "inspect" }> {
  return value.command !== "inspect";
}

/**
 * Runs the production alumni-import qualification command. All emitted success
 * payloads are aggregate DTOs and never contain roster cells or user PII.
 */
export async function runAlumniImportCli(
  argv: readonly string[],
  environment: AlumniImportCliEnvironment,
  adapters: AlumniImportCliAdapters = {},
): Promise<AlumniImportCliExitCode> {
  const io: AlumniImportCliIo = {
    stdout: adapters.io?.stdout ?? DEFAULT_IO.stdout,
    stderr: adapters.io?.stderr ?? DEFAULT_IO.stderr,
  };
  const wantsJson = argv.includes("--json");
  let connection: ConnectionHandle | undefined;
  let output:
    | AlumniImportSourceInspectionReport
    | AlumniImportQualificationReport
    | CancelOutput
    | undefined;
  let exitCode: AlumniImportCliExitCode = 0;
  let failure: unknown;

  try {
    const arguments_ = parseAlumniImportCliArguments(argv);
    const operator = isAlumniImportWriteArguments(arguments_)
      ? resolveOperator(arguments_, environment)
      : undefined;
    if (isAlumniImportWriteArguments(arguments_)) {
      assertAlumniImportWriteConfirmation(arguments_, arguments_.confirmDb);
    }
    const runtime = await (adapters.loadRuntime ?? loadDefaultRuntime)();
    if (arguments_.command === "inspect") {
      const csv = await (adapters.readFile ?? defaultReadFile)(arguments_.file);
      output = runtime.qualification.inspectSource(
        csv,
        arguments_.expectation
          ? {
              checksum: arguments_.expectation.expectedChecksum,
              totalRows: arguments_.expectation.expectedRowCount,
              uniqueContacts:
                arguments_.expectation.expectedUniqueContactCount,
            }
          : undefined,
      );
      exitCode = output.status === "passed" ? 0 : 3;
    } else if (connectionRequired(arguments_)) {
      const uri = requireMongoUri(environment);
      connection = await (adapters.connect ?? defaultConnect)(uri, {
        ...CONNECTION_OPTIONS,
      });
      if (arguments_.confirmDb !== connection.databaseName) {
        throw new AlumniImportCliUsageError(
          "--confirm-db must exactly match the connected database name.",
        );
      }
      assertAlumniImportWriteConfirmation(arguments_, connection.databaseName);
      const actor = await runtime.qualification.assertOperatorActor(
        arguments_.actorId,
      );
      if (arguments_.command === "cancel") {
        await runtime.qualification.assertCancellationGates();
      } else {
        await runtime.qualification.assertOperationalGates();
      }

      if (arguments_.command === "dry-run") {
        const csv = await (adapters.readFile ?? defaultReadFile)(arguments_.file);
        const expected = sourceExpectation(arguments_);
        runtime.qualification.assertExpectedSource(csv, expected);
        const result = await runtime.imports.dryRun({
          csv,
          actor,
          idempotencyKey: arguments_.idempotencyKey,
          auditSource: "system",
          operator: operator!,
        });
        output = await runtime.qualification.verifyBatch({
          batchId: result.batchId,
          csv,
          expectation: expected,
        });
        exitCode = output.status === "passed" ? 0 : 3;
      } else if (arguments_.command === "verify") {
        const csv = await (adapters.readFile ?? defaultReadFile)(arguments_.file);
        output = await runtime.qualification.verifyBatch({
          batchId: arguments_.batchId,
          csv,
          expectation: sourceExpectation(arguments_),
        });
        exitCode = output.status === "passed" ? 0 : 3;
      } else {
        const result = await runtime.imports.cancel({
          batchId: arguments_.batchId,
          expectedRevision: arguments_.expectedRevision,
          expectedChecksum: arguments_.expectedChecksum,
          expectedRowCount: arguments_.expectedRowCount,
          expectedUniqueContactCount:
            arguments_.expectedUniqueContactCount,
          reasonCode: arguments_.reasonCode,
          actor,
          idempotencyKey: arguments_.idempotencyKey,
          auditSource: "system",
          operator: operator!,
        });
        output = Object.freeze({
          schemaVersion: 1 as const,
          kind: "alumni_import_cancellation" as const,
          status: "passed" as const,
          batch: Object.freeze({
            id: result.batchId,
            status: result.status,
            revision: result.revision,
            checksum: arguments_.expectedChecksum,
            totalRows: arguments_.expectedRowCount,
            uniqueContacts: arguments_.expectedUniqueContactCount,
          }),
          retention: Object.freeze({
            terminalAt: result.terminalAt,
            rawDataPurgeAt: result.rawDataPurgeAt,
            purgeAt: result.purgeAt,
          }),
          replayed: result.replayed,
        });
      }
    }
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
    io.stderr("ALUMNI_IMPORT_CLI_EXECUTION_FAILED");
    return 1;
  }
  io.stdout(JSON.stringify(output));
  return exitCode;
}

if (require.main === module) {
  void runAlumniImportCli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
