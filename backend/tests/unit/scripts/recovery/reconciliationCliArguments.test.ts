import { describe, expect, it } from "vitest";
import {
  parseRestoreRecoveryCliArguments,
  RestoreRecoveryCliUsageError,
} from "../../../../src/scripts/recovery/reconciliationCliArguments";

const VALID_ARGUMENTS = [
  "execute",
  "--confirm-db",
  "atcloud-restore-test",
  "--operator",
  "release-2026-09",
  "--idempotency-key",
  "11111111-1111-4111-8111-111111111111",
  "--account-deletion-manifest",
  "/restricted/account-deletions.json",
  "--execute",
  "--yes",
] as const;

function expectUsage(argv: readonly string[]): void {
  expect(() => parseRestoreRecoveryCliArguments(argv)).toThrow(
    RestoreRecoveryCliUsageError,
  );
}

describe("restore recovery CLI arguments", () => {
  it("requires exact destructive-operation gates and normalizes the idempotency key", () => {
    expect(parseRestoreRecoveryCliArguments(VALID_ARGUMENTS)).toEqual({
      command: "execute",
      confirmDb: "atcloud-restore-test",
      operator: "release-2026-09",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      accountDeletionManifest: "/restricted/account-deletions.json",
      execute: true,
      yes: true,
      json: false,
    });
    expect(
      parseRestoreRecoveryCliArguments([
        ...VALID_ARGUMENTS,
        "--json",
      ]),
    ).toMatchObject({ json: true });
    expectUsage(VALID_ARGUMENTS.filter((value) => value !== "--execute"));
    expectUsage(VALID_ARGUMENTS.filter((value) => value !== "--yes"));
  });

  it("rejects unsafe database, operator, idempotency, and manifest inputs", () => {
    expectUsage(
      VALID_ARGUMENTS.map((value) =>
        value === "atcloud-restore-test"
          ? "mongodb://private-user:private-password@example.invalid/restore"
          : value,
      ),
    );
    expectUsage(
      VALID_ARGUMENTS.map((value) =>
        value === "release-2026-09" ? "Travis Smith" : value,
      ),
    );
    expectUsage(
      VALID_ARGUMENTS.map((value) =>
        value === "11111111-1111-4111-8111-111111111111" ? "not-a-uuid" : value,
      ),
    );
    expectUsage([
      ...VALID_ARGUMENTS,
      "--operator",
      "second-release-code",
    ]);
    expectUsage([
      ...VALID_ARGUMENTS,
      "--unknown-flag",
    ]);
  });
});
