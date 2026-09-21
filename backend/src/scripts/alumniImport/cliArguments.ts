import {
  ALUMNI_IMPORT_CANCEL_REASON_CODES,
  type AlumniImportCancelReasonCode,
} from "../../contracts/alumniRosterFlow";

export const ALUMNI_IMPORT_CLI_COMMANDS = [
  "inspect",
  "dry-run",
  "verify",
  "cancel",
] as const;

export type AlumniImportCliCommand =
  (typeof ALUMNI_IMPORT_CLI_COMMANDS)[number];

interface CommonArguments {
  readonly command: AlumniImportCliCommand;
  readonly json: boolean;
}

interface SourceExpectationArguments {
  readonly expectedChecksum: string;
  readonly expectedRowCount: number;
  readonly expectedUniqueContactCount: number;
}

interface DatabaseArguments {
  readonly actorId: string;
  readonly confirmDb: string;
}

interface WriteArguments extends DatabaseArguments {
  readonly execute: boolean;
  readonly yes: boolean;
  readonly idempotencyKey: string;
  readonly operator?: string;
}

export interface InspectArguments extends CommonArguments {
  readonly command: "inspect";
  readonly file: string;
  readonly expectation?: SourceExpectationArguments;
}

export interface DryRunArguments
  extends CommonArguments,
    SourceExpectationArguments,
    WriteArguments {
  readonly command: "dry-run";
  readonly file: string;
}

export interface VerifyArguments
  extends CommonArguments,
    SourceExpectationArguments,
    DatabaseArguments {
  readonly command: "verify";
  readonly file: string;
  readonly batchId: string;
}

export interface CancelArguments
  extends CommonArguments,
    SourceExpectationArguments,
    WriteArguments {
  readonly command: "cancel";
  readonly batchId: string;
  readonly expectedRevision: number;
  readonly reasonCode: AlumniImportCancelReasonCode;
}

export type AlumniImportCliArguments =
  | InspectArguments
  | DryRunArguments
  | VerifyArguments
  | CancelArguments;

export type AlumniImportWriteArguments = DryRunArguments | CancelArguments;

export class AlumniImportCliUsageError extends Error {
  readonly name = "AlumniImportCliUsageError";

  constructor(message: string) {
    super(message);
  }
}

const BOOLEAN_FLAGS = new Set(["--json", "--execute", "--yes"]);
const VALUE_FLAGS = new Set([
  "--file",
  "--expected-sha256",
  "--expected-row-count",
  "--expected-unique-contacts",
  "--actor-id",
  "--idempotency-key",
  "--confirm-db",
  "--operator",
  "--batch-id",
  "--expected-revision",
  "--reason-code",
]);
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_OPERATOR_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function usageError(message: string): never {
  throw new AlumniImportCliUsageError(message);
}

function parseTokens(tokens: readonly string[]) {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (BOOLEAN_FLAGS.has(token)) {
      if (booleans.has(token) || values.has(token)) {
        usageError(`Duplicate option ${token}.`);
      }
      booleans.add(token);
      continue;
    }
    if (!VALUE_FLAGS.has(token)) usageError(`Unknown option ${token}.`);
    if (booleans.has(token) || values.has(token)) {
      usageError(`Duplicate option ${token}.`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      usageError(`Option ${token} requires a value.`);
    }
    values.set(token, value);
    index += 1;
  }
  return { booleans, values };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) usageError(`Option ${flag} is required.`);
  return value;
}

function boundedText(
  value: string,
  label: string,
  maximum: number,
): string {
  if (
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) {
    usageError(`${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) usageError(`${label} must be positive.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) usageError(`${label} must be safe.`);
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) usageError(`${label} must be non-negative.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) usageError(`${label} must be safe.`);
  return parsed;
}

function expectation(values: ReadonlyMap<string, string>): SourceExpectationArguments {
  const expectedChecksum = required(values, "--expected-sha256");
  if (!SHA256_PATTERN.test(expectedChecksum)) {
    usageError("--expected-sha256 must be a lowercase SHA-256 digest.");
  }
  const expectedRowCount = positiveInteger(
    required(values, "--expected-row-count"),
    "--expected-row-count",
  );
  const expectedUniqueContactCount = nonNegativeInteger(
    required(values, "--expected-unique-contacts"),
    "--expected-unique-contacts",
  );
  if (expectedUniqueContactCount > expectedRowCount) {
    usageError("--expected-unique-contacts cannot exceed row count.");
  }
  return {
    expectedChecksum,
    expectedRowCount,
    expectedUniqueContactCount,
  };
}

function optionalExpectation(
  values: ReadonlyMap<string, string>,
): SourceExpectationArguments | undefined {
  const flags = [
    "--expected-sha256",
    "--expected-row-count",
    "--expected-unique-contacts",
  ];
  const present = flags.filter((flag) => values.has(flag));
  if (present.length === 0) return undefined;
  if (present.length !== flags.length) {
    usageError("Source expectation options must be supplied together.");
  }
  return expectation(values);
}

function databaseArguments(values: ReadonlyMap<string, string>): DatabaseArguments {
  const actorId = required(values, "--actor-id").toLowerCase();
  if (!OBJECT_ID_PATTERN.test(actorId)) {
    usageError("--actor-id must be a 24-character ObjectId.");
  }
  const confirmDb = boundedText(
    required(values, "--confirm-db"),
    "--confirm-db",
    128,
  );
  if (confirmDb.includes("://")) {
    usageError("--confirm-db must be a database name, not a URI.");
  }
  return {
    actorId,
    confirmDb,
  };
}

function writeArguments(
  booleans: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
): WriteArguments {
  const idempotencyKey = required(values, "--idempotency-key").toLowerCase();
  if (!UUID_PATTERN.test(idempotencyKey)) {
    usageError("--idempotency-key must be a UUID.");
  }
  const operatorValue = values.get("--operator");
  if (operatorValue !== undefined && !SAFE_OPERATOR_PATTERN.test(operatorValue)) {
    usageError("--operator must be a non-PII operational identifier.");
  }
  return {
    ...databaseArguments(values),
    execute: booleans.has("--execute"),
    yes: booleans.has("--yes"),
    idempotencyKey,
    ...(operatorValue ? { operator: operatorValue } : {}),
  };
}

function assertAllowed(
  booleans: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  allowedBooleans: readonly string[],
  allowedValues: readonly string[],
): void {
  const booleanSet = new Set(allowedBooleans);
  const valueSet = new Set(allowedValues);
  for (const flag of booleans) {
    if (!booleanSet.has(flag)) usageError(`Option ${flag} is not allowed here.`);
  }
  for (const flag of values.keys()) {
    if (!valueSet.has(flag)) usageError(`Option ${flag} is not allowed here.`);
  }
}

export function parseAlumniImportCliArguments(
  argv: readonly string[],
): AlumniImportCliArguments {
  const [command, ...tokens] = argv;
  if (!(ALUMNI_IMPORT_CLI_COMMANDS as readonly (string | undefined)[]).includes(command)) {
    usageError("A valid alumni-import command is required.");
  }
  const parsed = parseTokens(tokens);
  const json = parsed.booleans.has("--json");
  switch (command) {
    case "inspect": {
      assertAllowed(parsed.booleans, parsed.values, ["--json"], [
        "--file",
        "--expected-sha256",
        "--expected-row-count",
        "--expected-unique-contacts",
      ]);
      const expected = optionalExpectation(parsed.values);
      return Object.freeze({
        command,
        json,
        file: boundedText(required(parsed.values, "--file"), "--file", 1_024),
        ...(expected ? { expectation: expected } : {}),
      });
    }
    case "dry-run": {
      assertAllowed(parsed.booleans, parsed.values, ["--json", "--execute", "--yes"], [
        "--file",
        "--expected-sha256",
        "--expected-row-count",
        "--expected-unique-contacts",
        "--actor-id",
        "--idempotency-key",
        "--confirm-db",
        "--operator",
      ]);
      return Object.freeze({
        command,
        json,
        file: boundedText(required(parsed.values, "--file"), "--file", 1_024),
        ...expectation(parsed.values),
        ...writeArguments(parsed.booleans, parsed.values),
      });
    }
    case "verify": {
      assertAllowed(parsed.booleans, parsed.values, ["--json"], [
        "--file",
        "--expected-sha256",
        "--expected-row-count",
        "--expected-unique-contacts",
        "--actor-id",
        "--confirm-db",
        "--batch-id",
      ]);
      const batchId = required(parsed.values, "--batch-id").toLowerCase();
      if (!OBJECT_ID_PATTERN.test(batchId)) {
        usageError("--batch-id must be a 24-character ObjectId.");
      }
      return Object.freeze({
        command,
        json,
        file: boundedText(required(parsed.values, "--file"), "--file", 1_024),
        batchId,
        ...expectation(parsed.values),
        ...databaseArguments(parsed.values),
      });
    }
    case "cancel": {
      assertAllowed(parsed.booleans, parsed.values, ["--json", "--execute", "--yes"], [
        "--expected-sha256",
        "--expected-row-count",
        "--expected-unique-contacts",
        "--actor-id",
        "--idempotency-key",
        "--confirm-db",
        "--operator",
        "--batch-id",
        "--expected-revision",
        "--reason-code",
      ]);
      const batchId = required(parsed.values, "--batch-id").toLowerCase();
      if (!OBJECT_ID_PATTERN.test(batchId)) {
        usageError("--batch-id must be a 24-character ObjectId.");
      }
      const reasonCode = required(parsed.values, "--reason-code");
      if (!(ALUMNI_IMPORT_CANCEL_REASON_CODES as readonly string[]).includes(reasonCode)) {
        usageError("--reason-code is invalid.");
      }
      return Object.freeze({
        command,
        json,
        batchId,
        expectedRevision: nonNegativeInteger(
          required(parsed.values, "--expected-revision"),
          "--expected-revision",
        ),
        reasonCode: reasonCode as AlumniImportCancelReasonCode,
        ...expectation(parsed.values),
        ...writeArguments(parsed.booleans, parsed.values),
      });
    }
  }
  return usageError("A valid alumni-import command is required.");
}

export function isAlumniImportWriteArguments(
  value: AlumniImportCliArguments,
): value is AlumniImportWriteArguments {
  return value.command === "dry-run" || value.command === "cancel";
}

export function assertAlumniImportWriteConfirmation(
  value: AlumniImportCliArguments,
  databaseName: string,
): void {
  if (!isAlumniImportWriteArguments(value)) return;
  if (!value.execute || !value.yes) {
    usageError("Write commands require --execute and --yes.");
  }
  if (value.confirmDb !== databaseName) {
    usageError("--confirm-db must exactly match the connected database name.");
  }
}

export function formatAlumniImportCliUsage(): string {
  return [
    "alumni-import inspect --file PATH [--expected-sha256 SHA --expected-row-count N --expected-unique-contacts N] [--json]",
    "alumni-import dry-run --file PATH --expected-sha256 SHA --expected-row-count N --expected-unique-contacts N --actor-id ID --idempotency-key UUID --confirm-db DB --operator CODE --execute --yes [--json]",
    "alumni-import verify --file PATH --batch-id ID --expected-sha256 SHA --expected-row-count N --expected-unique-contacts N --actor-id ID --confirm-db DB [--json]",
    "alumni-import cancel --batch-id ID --expected-revision N --expected-sha256 SHA --expected-row-count N --expected-unique-contacts N --reason-code CODE --actor-id ID --idempotency-key UUID --confirm-db DB --operator CODE --execute --yes [--json]",
  ].join("\n");
}
