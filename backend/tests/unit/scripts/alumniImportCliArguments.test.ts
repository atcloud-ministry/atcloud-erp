import { describe, expect, it } from "vitest";
import {
  AlumniImportCliUsageError,
  assertAlumniImportWriteConfirmation,
  parseAlumniImportCliArguments,
} from "../../../src/scripts/alumniImport/cliArguments";

const ACTOR_ID = "507f1f77bcf86cd799439011";
const BATCH_ID = "507f191e810c19729de860ea";
const CHECKSUM = "a".repeat(64);
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

function expectUsage(operation: () => unknown): void {
  expect(operation).toThrow(AlumniImportCliUsageError);
}

describe("alumni import CLI arguments", () => {
  it("parses inspection with an optional complete source expectation", () => {
    expect(
      parseAlumniImportCliArguments([
        "inspect",
        "--file",
        "/restricted/alumni.csv",
        "--expected-sha256",
        CHECKSUM,
        "--expected-row-count",
        "322",
        "--expected-unique-contacts",
        "320",
        "--json",
      ]),
    ).toEqual({
      command: "inspect",
      file: "/restricted/alumni.csv",
      expectation: {
        expectedChecksum: CHECKSUM,
        expectedRowCount: 322,
        expectedUniqueContactCount: 320,
      },
      json: true,
    });
    expectUsage(() =>
      parseAlumniImportCliArguments([
        "inspect",
        "--file",
        "/restricted/alumni.csv",
        "--expected-row-count",
        "322",
      ]),
    );
  });

  it("requires the full dry-run safety envelope", () => {
    const parsed = parseAlumniImportCliArguments([
      "dry-run",
      "--file",
      "/restricted/alumni.csv",
      "--expected-sha256",
      CHECKSUM,
      "--expected-row-count",
      "2",
      "--expected-unique-contacts",
      "1",
      "--actor-id",
      ACTOR_ID,
      "--idempotency-key",
      IDEMPOTENCY_KEY,
      "--confirm-db",
      "atcloud-production",
      "--operator",
      "release-20260919",
      "--execute",
      "--yes",
    ]);
    expect(parsed).toMatchObject({
      command: "dry-run",
      expectedRowCount: 2,
      expectedUniqueContactCount: 1,
      actorId: ACTOR_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      confirmDb: "atcloud-production",
      operator: "release-20260919",
      execute: true,
      yes: true,
    });
    expect(() =>
      assertAlumniImportWriteConfirmation(parsed, "atcloud-production"),
    ).not.toThrow();
  });

  it("allows a zero-contact cancellation while keeping row count positive", () => {
    const parsed = parseAlumniImportCliArguments([
      "cancel",
      "--batch-id",
      BATCH_ID,
      "--expected-revision",
      "0",
      "--expected-sha256",
      CHECKSUM,
      "--expected-row-count",
      "1",
      "--expected-unique-contacts",
      "0",
      "--reason-code",
      "data_validation_failed",
      "--actor-id",
      ACTOR_ID,
      "--idempotency-key",
      IDEMPOTENCY_KEY,
      "--confirm-db",
      "atcloud-production",
      "--operator",
      "release-20260919",
      "--execute",
      "--yes",
    ]);
    expect(parsed).toMatchObject({
      command: "cancel",
      expectedRowCount: 1,
      expectedUniqueContactCount: 0,
      expectedRevision: 0,
    });
  });

  it("rejects URI-shaped database confirmations and unsafe operators", () => {
    const base = [
      "dry-run",
      "--file",
      "/restricted/alumni.csv",
      "--expected-sha256",
      CHECKSUM,
      "--expected-row-count",
      "1",
      "--expected-unique-contacts",
      "1",
      "--actor-id",
      ACTOR_ID,
      "--idempotency-key",
      IDEMPOTENCY_KEY,
      "--execute",
      "--yes",
    ];
    expectUsage(() =>
      parseAlumniImportCliArguments([
        ...base,
        "--confirm-db",
        "mongodb://private/db",
        "--operator",
        "release-1",
      ]),
    );
    expectUsage(() =>
      parseAlumniImportCliArguments([
        ...base,
        "--confirm-db",
        "atcloud-production",
        "--operator",
        "Travis Fan",
      ]),
    );
  });

  it("rejects missing write confirmations and the wrong connected database", () => {
    const parsed = parseAlumniImportCliArguments([
      "dry-run",
      "--file",
      "/restricted/alumni.csv",
      "--expected-sha256",
      CHECKSUM,
      "--expected-row-count",
      "1",
      "--expected-unique-contacts",
      "1",
      "--actor-id",
      ACTOR_ID,
      "--idempotency-key",
      IDEMPOTENCY_KEY,
      "--confirm-db",
      "atcloud-production",
      "--operator",
      "release-1",
    ]);
    expectUsage(() =>
      assertAlumniImportWriteConfirmation(parsed, "atcloud-production"),
    );
    expectUsage(() =>
      assertAlumniImportWriteConfirmation(
        { ...parsed, execute: true, yes: true },
        "atcloud-staging",
      ),
    );
  });
});
