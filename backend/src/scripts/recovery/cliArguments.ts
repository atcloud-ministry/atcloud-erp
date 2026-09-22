export const RESTORE_QUALIFICATION_CLI_COMMANDS = [
  "inspect",
  "verify",
] as const;

export type RestoreQualificationCliCommand =
  (typeof RESTORE_QUALIFICATION_CLI_COMMANDS)[number];

interface CommonArguments {
  readonly command: RestoreQualificationCliCommand;
  readonly confirmDb: string;
  readonly json: boolean;
}

export interface RestoreQualificationInspectArguments extends CommonArguments {
  readonly command: "inspect";
}

export interface RestoreQualificationVerifyArguments extends CommonArguments {
  readonly command: "verify";
  readonly manifest: string;
}

export type RestoreQualificationCliArguments =
  | RestoreQualificationInspectArguments
  | RestoreQualificationVerifyArguments;

export class RestoreQualificationCliUsageError extends Error {
  readonly name = "RestoreQualificationCliUsageError";

  constructor(message: string) {
    super(message);
  }
}

const BOOLEAN_FLAGS = new Set(["--json"]);
const VALUE_FLAGS = new Set(["--confirm-db", "--manifest"]);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function usageError(message: string): never {
  throw new RestoreQualificationCliUsageError(message);
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

function assertAllowed(
  booleans: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  allowedValues: readonly string[],
): void {
  for (const flag of booleans) {
    if (flag !== "--json") usageError(`Option ${flag} is not allowed here.`);
  }
  const allowed = new Set(allowedValues);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) usageError(`Option ${flag} is not allowed here.`);
  }
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

export function parseRestoreQualificationCliArguments(
  argv: readonly string[],
): RestoreQualificationCliArguments {
  const [command, ...tokens] = argv;
  if (
    !(RESTORE_QUALIFICATION_CLI_COMMANDS as readonly (string | undefined)[]).includes(
      command,
    )
  ) {
    usageError("A valid restore-qualification command is required.");
  }
  const parsed = parseTokens(tokens);
  const json = parsed.booleans.has("--json");
  switch (command) {
    case "inspect":
      assertAllowed(parsed.booleans, parsed.values, ["--confirm-db"]);
      return Object.freeze({
        command,
        json,
        confirmDb: databaseName(parsed.values),
      });
    case "verify":
      assertAllowed(parsed.booleans, parsed.values, [
        "--confirm-db",
        "--manifest",
      ]);
      return Object.freeze({
        command,
        json,
        confirmDb: databaseName(parsed.values),
        manifest: boundedText(
          required(parsed.values, "--manifest"),
          "--manifest",
          1_024,
        ),
      });
  }
  return usageError("A valid restore-qualification command is required.");
}

export function formatRestoreQualificationCliUsage(): string {
  return [
    "recovery-qualification inspect --confirm-db RESTORE_DB [--json]",
    "recovery-qualification verify --confirm-db RESTORE_DB --manifest PATH [--json]",
  ].join("\n");
}
