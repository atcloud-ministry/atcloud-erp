import { describe, expect, it } from "vitest";
import {
  MIGRATION_ROLLBACK_REASON_CODES,
  UsageError,
  assertMigrationWriteConfirmation,
  formatMigrationUsage,
  isMigrationWriteArguments,
  parseMigrationCliArguments,
  type ParsedMigrationArguments,
} from "../../../../src/scripts/migrations/cliArguments";

const MIGRATION_A = "20260909_001_alumni-profile";
const MIGRATION_B = "20260909_002_help-outcomes";
const MIGRATION_C = "20260909_003_chat-room";
const ROLLBACK_REASON_CODE = "POSTCONDITION_FAILED" as const;

function expectUsageError(operation: () => unknown, message: RegExp): void {
  try {
    operation();
    throw new Error("Expected a UsageError");
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toMatch(message);
  }
}

describe("migration CLI argument parsing", () => {
  it("parses status and dry-run read commands", () => {
    expect(parseMigrationCliArguments(["status"])).toEqual({
      command: "status",
      json: false,
    });
    expect(
      parseMigrationCliArguments([
        "dry-run",
        "--to",
        MIGRATION_A,
        "--json",
      ]),
    ).toEqual({
      command: "dry-run",
      to: MIGRATION_A,
      json: true,
    });
  });

  it("parses apply with its complete option set independent of option order", () => {
    expect(
      parseMigrationCliArguments([
        "apply",
        "--operator",
        "  Travis Fan  ",
        "--json",
        "--execute",
        "--to",
        MIGRATION_B,
        "--confirm-db",
        "atcloud-production",
        "--yes",
      ]),
    ).toEqual({
      command: "apply",
      to: MIGRATION_B,
      execute: true,
      yes: true,
      confirmDb: "atcloud-production",
      operator: "Travis Fan",
      json: true,
    });
  });

  it("parses apply write-confirmation defaults", () => {
    expect(parseMigrationCliArguments(["apply"])).toEqual({
      command: "apply",
      execute: false,
      yes: false,
      json: false,
    });
  });

  it("parses resume with zero or one positional migration ID", () => {
    expect(parseMigrationCliArguments(["resume", "--execute"])).toEqual({
      command: "resume",
      execute: true,
      yes: false,
      json: false,
    });
    expect(
      parseMigrationCliArguments([
        "resume",
        MIGRATION_C,
        "--execute",
        "--operator",
        "Release operator",
      ]),
    ).toEqual({
      command: "resume",
      migrationId: MIGRATION_C,
      execute: true,
      yes: false,
      operator: "Release operator",
      json: false,
    });
  });

  it("parses rollback with its required ID and reason", () => {
    expect(
      parseMigrationCliArguments([
        "rollback",
        MIGRATION_C,
        "--reason-code",
        ROLLBACK_REASON_CODE,
        "--execute",
        "--yes",
        "--confirm-db",
        "atcloud-production",
        "--operator",
        "Travis Fan",
        "--json",
      ]),
    ).toEqual({
      command: "rollback",
      migrationId: MIGRATION_C,
      reasonCode: ROLLBACK_REASON_CODE,
      execute: true,
      yes: true,
      confirmDb: "atcloud-production",
      operator: "Travis Fan",
      json: true,
    });
  });

  it("rejects a missing or unknown command without echoing its value", () => {
    expectUsageError(
      () => parseMigrationCliArguments([]),
      /migration command is required/i,
    );

    const secretLikeValue = "mongodb://user:password@example.invalid/db";
    try {
      parseMigrationCliArguments([secretLikeValue]);
      throw new Error("Expected a UsageError");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).not.toContain(secretLikeValue);
      expect((error as Error).message).toBe("Unknown migration command.");
    }
  });

  it.each([
    ["status", "--execute"],
    ["dry-run", "--operator"],
    ["apply", "--reason-code"],
    ["resume", "--to"],
    ["rollback", "--to"],
    ["status", "--unknown"],
    ["status", "--to"],
  ])("rejects options outside the %s contract", (command, option) => {
    expectUsageError(
      () => parseMigrationCliArguments([command, option, "value"]),
      /unknown option/i,
    );
  });

  it.each([
    ["status", "--json", "--json"],
    ["apply", "--execute", "--execute"],
    ["apply", "--to", MIGRATION_A, "--to", MIGRATION_B],
    [
      "rollback",
      MIGRATION_A,
      "--reason-code",
      ROLLBACK_REASON_CODE,
      "--reason-code",
      "OPERATOR_REQUEST",
    ],
  ])("rejects duplicate flags", (...argv) => {
    expectUsageError(
      () => parseMigrationCliArguments(argv),
      /duplicate option/i,
    );
  });

  it.each([
    ["dry-run", "--to"],
    ["apply", "--operator"],
    ["apply", "--confirm-db", "--execute"],
    ["rollback", MIGRATION_A, "--reason-code", "--execute"],
  ])("rejects missing flag values", (...argv) => {
    expectUsageError(
      () => parseMigrationCliArguments(argv),
      /requires a value/i,
    );
  });

  it("rejects extra or missing positional arguments", () => {
    expectUsageError(
      () => parseMigrationCliArguments(["status", "extra"]),
      /does not accept positional/i,
    );
    expectUsageError(
      () => parseMigrationCliArguments(["apply", "extra"]),
      /does not accept positional/i,
    );
    expectUsageError(
      () => parseMigrationCliArguments(["resume", MIGRATION_A, MIGRATION_B]),
      /at most one migration ID/i,
    );
    expectUsageError(
      () =>
        parseMigrationCliArguments([
          "rollback",
          "--reason-code",
          ROLLBACK_REASON_CODE,
        ]),
      /exactly one migration ID/i,
    );
    expectUsageError(
      () =>
        parseMigrationCliArguments([
          "rollback",
          MIGRATION_A,
          MIGRATION_B,
          "--reason-code",
          ROLLBACK_REASON_CODE,
        ]),
      /exactly one migration ID/i,
    );
  });

  it("requires a rollback reason", () => {
    expectUsageError(
      () => parseMigrationCliArguments(["rollback", MIGRATION_A]),
      /requires --reason-code/i,
    );
  });

  it.each([
    ["dry-run", "--to", "contains spaces"],
    ["dry-run", "--to", " surrounded-by-space "],
    ["apply", "--to", "-starts-with-dash"],
    ["resume", "invalid/id"],
    [
      "rollback",
      "invalid/id",
      "--reason-code",
      ROLLBACK_REASON_CODE,
    ],
  ])("rejects invalid migration IDs", (...argv) => {
    expectUsageError(
      () => parseMigrationCliArguments(argv),
      /migration ID|requires a value/i,
    );
  });

  it.each([
    ["apply", "--operator", "   "],
    ["apply", "--operator", "name\n"],
    ["apply", "--operator", "name\nsecond-line"],
  ])("rejects empty or control-character text", (...argv) => {
    expectUsageError(
      () => parseMigrationCliArguments(argv),
      /cannot be empty|control characters/i,
    );
  });

  it("enforces the operator maximum length", () => {
    expect(
      parseMigrationCliArguments([
        "apply",
        "--operator",
        "o".repeat(120),
      ]),
    ).toMatchObject({ operator: "o".repeat(120) });
    expectUsageError(
      () =>
        parseMigrationCliArguments([
          "apply",
          "--operator",
          "o".repeat(121),
        ]),
      /maximum length/i,
    );
  });

  it("accepts only allowlisted rollback reason codes", () => {
    for (const reasonCode of MIGRATION_ROLLBACK_REASON_CODES) {
      expect(
        parseMigrationCliArguments([
          "rollback",
          MIGRATION_A,
          "--reason-code",
          reasonCode,
        ]),
      ).toMatchObject({ reasonCode });
    }

    expectUsageError(
      () =>
        parseMigrationCliArguments([
          "rollback",
          MIGRATION_A,
          "--reason-code",
          "private free-text reason",
        ]),
      /not an allowed rollback reason/i,
    );
    expectUsageError(
      () =>
        parseMigrationCliArguments([
          "rollback",
          MIGRATION_A,
          "--reason",
          "legacy reason",
        ]),
      /unknown option/i,
    );
  });

  it("accepts only a database name for --confirm-db", () => {
    const secretLikeValue = "mongodb://user:password@example.invalid/db";
    try {
      parseMigrationCliArguments(["apply", "--confirm-db", secretLikeValue]);
      throw new Error("Expected a UsageError");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).not.toContain(secretLikeValue);
      expect((error as Error).message).toMatch(/database name, not a URI/i);
    }

    expectUsageError(
      () =>
        parseMigrationCliArguments([
          "apply",
          "--confirm-db",
          " atcloud-production ",
        ]),
      /exactly contain the database name/i,
    );
  });

  it("provides a discriminant and write-command type guard", () => {
    const parsed: ParsedMigrationArguments = parseMigrationCliArguments([
      "resume",
    ]);

    expect(parsed.command).toBe("resume");
    expect(isMigrationWriteArguments(parsed)).toBe(true);
    expect(
      isMigrationWriteArguments(parseMigrationCliArguments(["dry-run"])),
    ).toBe(false);
  });
});

describe("migration write confirmation", () => {
  const database = {
    databaseName: "atcloud-production",
  } as const;
  const writeCommands = [
    ["apply"],
    ["resume", MIGRATION_A],
    [
      "rollback",
      MIGRATION_A,
      "--reason-code",
      ROLLBACK_REASON_CODE,
    ],
  ] as const;

  it("does not require write confirmation for status or dry-run", () => {
    expect(() =>
      assertMigrationWriteConfirmation(
        parseMigrationCliArguments(["status"]),
        database,
      ),
    ).not.toThrow();
    expect(() =>
      assertMigrationWriteConfirmation(
        parseMigrationCliArguments(["dry-run"]),
        database,
      ),
    ).not.toThrow();
  });

  it.each(writeCommands)(
    "requires --execute for every write command",
    (...argv) => {
      expectUsageError(
        () =>
          assertMigrationWriteConfirmation(
            parseMigrationCliArguments(argv),
            database,
          ),
        /requires --execute/i,
      );
    },
  );

  it.each(writeCommands)("requires --yes for every write command", (...argv) => {
    expectUsageError(
      () =>
        assertMigrationWriteConfirmation(
          parseMigrationCliArguments([
            ...argv,
            "--execute",
            "--confirm-db",
            database.databaseName,
          ]),
          database,
        ),
      /requires --yes/i,
    );
  });

  it.each(writeCommands)(
    "requires --confirm-db for every write command",
    (...argv) => {
      expectUsageError(
        () =>
          assertMigrationWriteConfirmation(
            parseMigrationCliArguments([...argv, "--execute", "--yes"]),
            database,
          ),
        /must exactly match/i,
      );
    },
  );

  it("rejects a database-name mismatch without printing either name", () => {
    const wrongDatabase = "secret-wrong-database";
    try {
      assertMigrationWriteConfirmation(
        parseMigrationCliArguments([
          "apply",
          "--execute",
          "--yes",
          "--confirm-db",
          wrongDatabase,
        ]),
        database,
      );
      throw new Error("Expected a UsageError");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).not.toContain(wrongDatabase);
      expect((error as Error).message).not.toContain(database.databaseName);
    }
  });

  it.each(writeCommands)("accepts a fully confirmed write", (...argv) => {
    expect(() =>
      assertMigrationWriteConfirmation(
        parseMigrationCliArguments([
          ...argv,
          "--execute",
          "--yes",
          "--confirm-db",
          database.databaseName,
        ]),
        database,
      ),
    ).not.toThrow();
  });
});

describe("migration usage", () => {
  it("documents every command and never contains a connection URI", () => {
    const usage = formatMigrationUsage();

    for (const command of [
      "status",
      "dry-run",
      "apply",
      "resume",
      "rollback",
    ]) {
      expect(usage).toContain(`migration ${command}`);
    }
    expect(usage).toContain("--execute");
    expect(usage).toContain("--yes");
    expect(usage).toContain("--confirm-db DB");
    expect(usage).toContain("--operator NAME");
    expect(usage).toContain("--reason-code CODE");
    for (const reasonCode of MIGRATION_ROLLBACK_REASON_CODES) {
      expect(usage).toContain(reasonCode);
    }
    expect(usage).not.toContain("mongodb://");
    expect(usage).not.toContain("MONGODB_URI");
  });
});
