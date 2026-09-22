import { describe, expect, it } from "vitest";
import {
  parseRestoreQualificationCliArguments,
  RestoreQualificationCliUsageError,
} from "../../../../src/scripts/recovery/cliArguments";

function expectUsage(operation: () => unknown): void {
  expect(operation).toThrow(RestoreQualificationCliUsageError);
}

describe("restore qualification CLI arguments", () => {
  it("requires an exact database name for inspection", () => {
    expect(
      parseRestoreQualificationCliArguments([
        "inspect",
        "--confirm-db",
        "atcloud-restore-test",
        "--json",
      ]),
    ).toEqual({
      command: "inspect",
      confirmDb: "atcloud-restore-test",
      json: true,
    });

    expectUsage(() =>
      parseRestoreQualificationCliArguments([
        "inspect",
        "--confirm-db",
        "mongodb://private-user:private-password@example.invalid/restore",
      ]),
    );
  });

  it("requires a bounded manifest path only for verification", () => {
    expect(
      parseRestoreQualificationCliArguments([
        "verify",
        "--confirm-db",
        "atcloud-restore-test",
        "--manifest",
        "/restricted/restore-manifest.json",
      ]),
    ).toEqual({
      command: "verify",
      confirmDb: "atcloud-restore-test",
      manifest: "/restricted/restore-manifest.json",
      json: false,
    });

    expectUsage(() =>
      parseRestoreQualificationCliArguments([
        "inspect",
        "--confirm-db",
        "atcloud-restore-test",
        "--manifest",
        "/restricted/restore-manifest.json",
      ]),
    );
    expectUsage(() =>
      parseRestoreQualificationCliArguments([
        "verify",
        "--confirm-db",
        "atcloud-restore-test",
      ]),
    );
  });
});
