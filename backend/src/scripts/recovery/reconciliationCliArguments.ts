export const RESTORE_RECOVERY_CLI_COMMANDS = ["execute"] as const;

export type RestoreRecoveryCliCommand =
  (typeof RESTORE_RECOVERY_CLI_COMMANDS)[number];

export interface RestoreRecoveryExecuteArguments {
  readonly command: "execute";
  readonly confirmDb: string;
  readonly operator: string;
  readonly idempotencyKey: string;
  readonly accountDeletionManifest: string;
  readonly execute: true;
  readonly yes: true;
  readonly json: boolean;
}

export type RestoreRecoveryCliArguments = RestoreRecoveryExecuteArguments;

export class RestoreRecoveryCliUsageError extends Error {
  readonly name = "RestoreRecoveryCliUsageError";

  constructor(message: string) {
    super(message);
  }
}

const BOOLEAN_FLAGS = new Set(["--execute", "--yes", "--json"]);
const VALUE_FLAGS = new Set([
  "--confirm-db",
  "--operator",
  "--idempotency-key",
  "--account-deletion-manifest",
]);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usageError(message: string): never {
  throw new RestoreRecoveryCliUsageError(message);
}

function parseTokens(tokens: readonly string[]): {
  readonly booleans: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
} {
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

function boundedText(value: string, label: string, maximum: number): string {
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

function databaseName(values: ReadonlyMap<string, string>): string {
  const value = boundedText(
    required(values, "--confirm-db"),
    "--confirm-db",
    128,
  );
  if (value.includes("://")) {
    usageError("--confirm-db must be a database name, not a URI.");
  }
  return value;
}

function operator(values: ReadonlyMap<string, string>): string {
  const value = boundedText(required(values, "--operator"), "--operator", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    usageError("--operator is invalid.");
  }
  return value;
}

function idempotencyKey(values: ReadonlyMap<string, string>): string {
  const value = boundedText(
    required(values, "--idempotency-key"),
    "--idempotency-key",
    64,
  );
  if (!UUID_PATTERN.test(value)) usageError("--idempotency-key must be a UUID.");
  return value.toLowerCase();
}

function assertAllowed(
  booleans: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
): void {
  const allowedBooleans = new Set(["--execute", "--yes", "--json"]);
  const allowedValues = new Set([
    "--confirm-db",
    "--operator",
    "--idempotency-key",
    "--account-deletion-manifest",
  ]);
  for (const flag of booleans) {
    if (!allowedBooleans.has(flag)) usageError(`Option ${flag} is not allowed here.`);
  }
  for (const flag of values.keys()) {
    if (!allowedValues.has(flag)) usageError(`Option ${flag} is not allowed here.`);
  }
}

/** Parses only the explicitly-confirmed destructive restore-recovery command. */
export function parseRestoreRecoveryCliArguments(
  argv: readonly string[],
): RestoreRecoveryCliArguments {
  const [command, ...tokens] = argv;
  if (command !== "execute") {
    usageError("The restore-recovery execute command is required.");
  }
  const parsed = parseTokens(tokens);
  assertAllowed(parsed.booleans, parsed.values);
  if (!parsed.booleans.has("--execute") || !parsed.booleans.has("--yes")) {
    usageError("Both --execute and --yes are required.");
  }
  return Object.freeze({
    command: "execute" as const,
    confirmDb: databaseName(parsed.values),
    operator: operator(parsed.values),
    idempotencyKey: idempotencyKey(parsed.values),
    accountDeletionManifest: boundedText(
      required(parsed.values, "--account-deletion-manifest"),
      "--account-deletion-manifest",
      1_024,
    ),
    execute: true as const,
    yes: true as const,
    json: parsed.booleans.has("--json"),
  });
}

export function formatRestoreRecoveryCliUsage(): string {
  return [
    "recovery-reconcile execute --confirm-db RESTORE_DB --operator RELEASE_CODE \\",
    "  --idempotency-key UUID --account-deletion-manifest PATH --execute --yes [--json]",
  ].join("\n");
}
