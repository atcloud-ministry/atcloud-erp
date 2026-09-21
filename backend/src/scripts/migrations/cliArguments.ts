import {
  MIGRATION_ID_PATTERN,
  MIGRATION_ROLLBACK_REASON_CODES,
  type MigrationRollbackReasonCode,
} from "../../migrations/types";

export {
  MIGRATION_ROLLBACK_REASON_CODES,
  type MigrationRollbackReasonCode,
} from "../../migrations/types";

export const MIGRATION_COMMANDS = [
  "status",
  "dry-run",
  "apply",
  "resume",
  "rollback",
] as const;

export type MigrationCommand = (typeof MIGRATION_COMMANDS)[number];

interface ParsedReadArguments {
  readonly json: boolean;
}

interface ParsedWriteArguments {
  readonly json: boolean;
  readonly execute: boolean;
  readonly yes: boolean;
  readonly confirmDb?: string;
  readonly operator?: string;
}

export interface ParsedStatusArguments extends ParsedReadArguments {
  readonly command: "status";
}

export interface ParsedDryRunArguments extends ParsedReadArguments {
  readonly command: "dry-run";
  readonly to?: string;
}

export interface ParsedApplyArguments extends ParsedWriteArguments {
  readonly command: "apply";
  readonly to?: string;
}

export interface ParsedResumeArguments extends ParsedWriteArguments {
  readonly command: "resume";
  readonly migrationId?: string;
}

export interface ParsedRollbackArguments extends ParsedWriteArguments {
  readonly command: "rollback";
  readonly migrationId: string;
  readonly reasonCode: MigrationRollbackReasonCode;
}

export type ParsedMigrationArguments =
  | ParsedStatusArguments
  | ParsedDryRunArguments
  | ParsedApplyArguments
  | ParsedResumeArguments
  | ParsedRollbackArguments;

export type ParsedMigrationWriteArguments = Extract<
  ParsedMigrationArguments,
  { readonly command: "apply" | "resume" | "rollback" }
>;

export interface MigrationConfirmationContext {
  readonly databaseName: string;
}

export class UsageError extends Error {
  readonly name = "UsageError";
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
  }
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_OPERATOR_LENGTH = 120;
const MAX_DATABASE_NAME_LENGTH = 128;

const BOOLEAN_FLAGS = ["--json", "--execute", "--yes"] as const;
const VALUE_FLAGS = [
  "--to",
  "--confirm-db",
  "--operator",
  "--reason-code",
] as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
type ValueFlag = (typeof VALUE_FLAGS)[number];
type Flag = BooleanFlag | ValueFlag;

interface CommandSpecification {
  readonly booleanFlags: ReadonlySet<BooleanFlag>;
  readonly valueFlags: ReadonlySet<ValueFlag>;
}

interface RawArguments {
  readonly booleanFlags: ReadonlySet<BooleanFlag>;
  readonly values: ReadonlyMap<ValueFlag, string>;
  readonly positionals: readonly string[];
}

const STATUS_SPECIFICATION: CommandSpecification = {
  booleanFlags: new Set<BooleanFlag>(["--json"]),
  valueFlags: new Set<ValueFlag>(),
};

const DRY_RUN_SPECIFICATION: CommandSpecification = {
  booleanFlags: new Set<BooleanFlag>(["--json"]),
  valueFlags: new Set<ValueFlag>(["--to"]),
};

const APPLY_SPECIFICATION: CommandSpecification = {
  booleanFlags: new Set<BooleanFlag>(["--json", "--execute", "--yes"]),
  valueFlags: new Set<ValueFlag>(["--to", "--confirm-db", "--operator"]),
};

const RESUME_SPECIFICATION: CommandSpecification = {
  booleanFlags: new Set<BooleanFlag>(["--json", "--execute", "--yes"]),
  valueFlags: new Set<ValueFlag>(["--confirm-db", "--operator"]),
};

const ROLLBACK_SPECIFICATION: CommandSpecification = {
  booleanFlags: new Set<BooleanFlag>(["--json", "--execute", "--yes"]),
  valueFlags: new Set<ValueFlag>([
    "--confirm-db",
    "--operator",
    "--reason-code",
  ]),
};

function isMigrationCommand(value: string): value is MigrationCommand {
  return (MIGRATION_COMMANDS as readonly string[]).includes(value);
}

function isBooleanFlag(value: string): value is BooleanFlag {
  return (BOOLEAN_FLAGS as readonly string[]).includes(value);
}

function isValueFlag(value: string): value is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(value);
}

function safeFlagName(value: string): string {
  return /^--[a-z][a-z-]*$/.test(value) ? ` ${value}` : "";
}

function commandSpecification(command: MigrationCommand): CommandSpecification {
  switch (command) {
    case "status":
      return STATUS_SPECIFICATION;
    case "dry-run":
      return DRY_RUN_SPECIFICATION;
    case "apply":
      return APPLY_SPECIFICATION;
    case "resume":
      return RESUME_SPECIFICATION;
    case "rollback":
      return ROLLBACK_SPECIFICATION;
  }
}

function parseCommandTokens(
  tokens: readonly string[],
  specification: CommandSpecification,
): RawArguments {
  const seen = new Set<Flag>();
  const booleanFlags = new Set<BooleanFlag>();
  const values = new Map<ValueFlag, string>();
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (isBooleanFlag(token) && specification.booleanFlags.has(token)) {
      if (seen.has(token)) {
        throw new UsageError(`Duplicate option${safeFlagName(token)}.`);
      }
      seen.add(token);
      booleanFlags.add(token);
      continue;
    }

    if (isValueFlag(token) && specification.valueFlags.has(token)) {
      if (seen.has(token)) {
        throw new UsageError(`Duplicate option${safeFlagName(token)}.`);
      }

      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`Option${safeFlagName(token)} requires a value.`);
      }

      seen.add(token);
      values.set(token, value);
      index += 1;
      continue;
    }

    throw new UsageError(`Unknown option${safeFlagName(token)}.`);
  }

  return { booleanFlags, values, positionals };
}

function normalizeBoundedText(
  value: string,
  label: string,
  maxLength: number,
): string {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new UsageError(`${label} cannot contain control characters.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new UsageError(`${label} cannot be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new UsageError(`${label} exceeds its maximum length.`);
  }
  return normalized;
}

function normalizeMigrationId(value: string, label: string): string {
  if (!MIGRATION_ID_PATTERN.test(value)) {
    throw new UsageError(`${label} must be a valid migration ID.`);
  }
  return value;
}

function normalizeRollbackReasonCode(
  value: string,
): MigrationRollbackReasonCode {
  if (
    !(MIGRATION_ROLLBACK_REASON_CODES as readonly string[]).includes(value)
  ) {
    throw new UsageError("--reason-code is not an allowed rollback reason.");
  }
  return value as MigrationRollbackReasonCode;
}

function normalizeDatabaseName(value: string): string {
  const normalized = normalizeBoundedText(
    value,
    "--confirm-db",
    MAX_DATABASE_NAME_LENGTH,
  );
  if (normalized !== value) {
    throw new UsageError(
      "--confirm-db must exactly contain the database name.",
    );
  }
  if (normalized.includes("://")) {
    throw new UsageError("--confirm-db accepts a database name, not a URI.");
  }
  return normalized;
}

function requireNoPositionals(
  command: MigrationCommand,
  positionals: readonly string[],
): void {
  if (positionals.length !== 0) {
    throw new UsageError(`${command} does not accept positional arguments.`);
  }
}

function optionalValue(
  values: ReadonlyMap<ValueFlag, string>,
  flag: ValueFlag,
): string | undefined {
  return values.get(flag);
}

function writeArguments(raw: RawArguments): ParsedWriteArguments {
  const confirmDb = optionalValue(raw.values, "--confirm-db");
  const operator = optionalValue(raw.values, "--operator");

  return {
    json: raw.booleanFlags.has("--json"),
    execute: raw.booleanFlags.has("--execute"),
    yes: raw.booleanFlags.has("--yes"),
    ...(confirmDb === undefined
      ? {}
      : { confirmDb: normalizeDatabaseName(confirmDb) }),
    ...(operator === undefined
      ? {}
      : {
          operator: normalizeBoundedText(
            operator,
            "--operator",
            MAX_OPERATOR_LENGTH,
          ),
        }),
  };
}

export function parseMigrationCliArguments(
  argv: readonly string[],
): ParsedMigrationArguments {
  const commandToken = argv[0];
  if (commandToken === undefined) {
    throw new UsageError("A migration command is required.");
  }
  if (!isMigrationCommand(commandToken)) {
    throw new UsageError("Unknown migration command.");
  }

  const raw = parseCommandTokens(
    argv.slice(1),
    commandSpecification(commandToken),
  );

  switch (commandToken) {
    case "status": {
      requireNoPositionals(commandToken, raw.positionals);
      return {
        command: commandToken,
        json: raw.booleanFlags.has("--json"),
      };
    }
    case "dry-run": {
      requireNoPositionals(commandToken, raw.positionals);
      const to = optionalValue(raw.values, "--to");
      return {
        command: commandToken,
        json: raw.booleanFlags.has("--json"),
        ...(to === undefined
          ? {}
          : { to: normalizeMigrationId(to, "--to") }),
      };
    }
    case "apply": {
      requireNoPositionals(commandToken, raw.positionals);
      const to = optionalValue(raw.values, "--to");
      return {
        command: "apply",
        ...writeArguments(raw),
        ...(to === undefined
          ? {}
          : { to: normalizeMigrationId(to, "--to") }),
      };
    }
    case "resume": {
      if (raw.positionals.length > 1) {
        throw new UsageError("resume accepts at most one migration ID.");
      }
      const migrationId = raw.positionals[0];
      return {
        command: "resume",
        ...writeArguments(raw),
        ...(migrationId === undefined
          ? {}
          : {
              migrationId: normalizeMigrationId(
                migrationId,
                "resume migration ID",
              ),
            }),
      };
    }
    case "rollback": {
      if (raw.positionals.length !== 1) {
        throw new UsageError("rollback requires exactly one migration ID.");
      }
      const reasonCode = optionalValue(raw.values, "--reason-code");
      if (reasonCode === undefined) {
        throw new UsageError("rollback requires --reason-code.");
      }
      return {
        command: "rollback",
        ...writeArguments(raw),
        migrationId: normalizeMigrationId(
          raw.positionals[0],
          "rollback migration ID",
        ),
        reasonCode: normalizeRollbackReasonCode(reasonCode),
      };
    }
  }
}

export function isMigrationWriteArguments(
  arguments_: ParsedMigrationArguments,
): arguments_ is ParsedMigrationWriteArguments {
  return (
    arguments_.command === "apply" ||
    arguments_.command === "resume" ||
    arguments_.command === "rollback"
  );
}

export function assertMigrationWriteConfirmation(
  arguments_: ParsedMigrationArguments,
  context: MigrationConfirmationContext,
): void {
  if (!isMigrationWriteArguments(arguments_)) return;

  if (!arguments_.execute) {
    throw new UsageError(`${arguments_.command} requires --execute.`);
  }

  if (!arguments_.yes) {
    throw new UsageError(`${arguments_.command} requires --yes.`);
  }

  const databaseName = normalizeBoundedText(
    context.databaseName,
    "databaseName",
    MAX_DATABASE_NAME_LENGTH,
  );
  if (
    arguments_.confirmDb === undefined ||
    arguments_.confirmDb !== databaseName
  ) {
    throw new UsageError(
      "--confirm-db must exactly match the connected database name.",
    );
  }
}

export function formatMigrationUsage(): string {
  return [
    "Usage:",
    "  migration status [--json]",
    "  migration dry-run [--to ID] [--json]",
    "  migration apply [--to ID] --execute --yes --confirm-db DB --operator NAME [--json]",
    "  migration resume [ID] --execute --yes --confirm-db DB --operator NAME [--json]",
    "  migration rollback ID --reason-code CODE --execute --yes --confirm-db DB --operator NAME [--json]",
    "",
    "Every write requires --execute, --yes, an exact --confirm-db database name, and an explicit operator.",
    `Rollback reason codes: ${MIGRATION_ROLLBACK_REASON_CODES.join(", ")}.`,
  ].join("\n");
}
