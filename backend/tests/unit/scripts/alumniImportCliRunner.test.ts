import type { ConnectOptions } from "mongoose";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAlumniImportCli } from "../../../src/scripts/alumniImport/runAlumniImport";

const SECRET_URI =
  "mongodb+srv://private-user:private-password@example.invalid/atcloud-production";
const ACTOR_ID = "507f1f77bcf86cd799439011";
const BATCH_ID = "507f191e810c19729de860ea";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";
const CSV = Buffer.from(
  "email,programName\nprivate@example.com,Private Program\n",
  "utf8",
);

const COUNTS = Object.freeze({
  totalRows: 1,
  validRows: 1,
  invalidRows: 0,
  matchedRows: 0,
  unmatchedRows: 1,
  ambiguousRows: 0,
  approvedRows: 0,
  rejectedRows: 0,
  appliedRows: 0,
  invitationsCreated: 0,
  affiliationsCreated: 0,
});

function qualificationReport(checksum: string) {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "alumni_import_qualification" as const,
    status: "passed" as const,
    source: Object.freeze({
      checksum,
      bytes: CSV.length,
      totalRows: 1,
      uniqueContacts: 1,
    }),
    batch: Object.freeze({
      id: BATCH_ID,
      status: "review_ready",
      revision: 0,
      checksum,
      counts: COUNTS,
    }),
    verification: Object.freeze({
      sourceChecksumMatches: true,
      sourceRowCountMatches: true,
      sourceUniqueContactCountMatches: true,
      batchChecksumMatches: true,
      rawHeadersMatch: true,
      rawRowsMatch: true,
      rowKeysMatch: true,
      countInvariantsHold: true,
      accountMatchingMatches: true,
    }),
    programMapping: Object.freeze({
      linkedRows: 0,
      externalRows: 1,
      missingProgramRows: 0,
      mismatchedProgramNameRows: 0,
    }),
    affiliations: Object.freeze({
      totalRecords: 0,
      formatErrorRecords: 0,
      affiliationKeyMismatchRecords: 0,
      programAffiliationKeyMismatchRecords: 0,
      duplicateIdentityGroups: 0,
      duplicateIdentityRecords: 0,
    }),
    rowIssues: Object.freeze([]),
    issues: Object.freeze([]),
  });
}

function harness(checksum: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(
    async (_uri: string, _options: ConnectOptions) => ({
      databaseName: "atcloud-production",
      close,
    }),
  );
  const qualification = {
    inspectSource: vi.fn(() => ({
      schemaVersion: 1 as const,
      kind: "alumni_import_source_inspection" as const,
      status: "passed" as const,
      source: {
        checksum,
        bytes: CSV.length,
        totalRows: 1,
        uniqueContacts: 1,
      },
      rowIssues: [],
      issues: [],
    })),
    assertExpectedSource: vi.fn(() => undefined),
    assertOperatorActor: vi.fn(async () => ({
      id: ACTOR_ID,
      role: "Administrator",
    })),
    assertOperationalGates: vi.fn(async () => undefined),
    assertCancellationGates: vi.fn(async () => undefined),
    verifyBatch: vi.fn(async () => qualificationReport(checksum)),
  };
  const imports = {
    dryRun: vi.fn(async () => ({
      replayed: false,
      batchId: BATCH_ID,
      status: "review_ready" as const,
      revision: 0,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      matchedRows: 0,
      unmatchedRows: 1,
      ambiguousRows: 0,
    })),
    cancel: vi.fn(async () => ({
      replayed: false,
      batchId: BATCH_ID,
      status: "cancelled" as const,
      revision: 1,
      terminalAt: "2030-09-19T00:00:00.000Z",
      rawDataPurgeAt: "2030-10-19T00:00:00.000Z",
      purgeAt: "2031-03-19T00:00:00.000Z",
    })),
  };
  return {
    stdout,
    stderr,
    close,
    connect,
    qualification,
    imports,
    adapters: {
      io: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
      readFile: vi.fn(async () => CSV),
      connect,
      loadRuntime: vi.fn(async () => ({ qualification, imports })),
    },
  };
}

describe("runAlumniImportCli", () => {
  it("inspects a source without opening MongoDB and emits no source PII", async () => {
    const checksum = "a".repeat(64);
    const test = harness(checksum);
    const exitCode = await runAlumniImportCli(
      ["inspect", "--file", "/restricted/alumni.csv", "--json"],
      {},
      test.adapters,
    );

    expect(exitCode).toBe(0);
    expect(test.connect).not.toHaveBeenCalled();
    expect(test.stderr).toEqual([]);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      kind: "alumni_import_source_inspection",
      source: { totalRows: 1, uniqueContacts: 1 },
    });
    expect(test.stdout.join("\n")).not.toContain("private@example.com");
    expect(test.stdout.join("\n")).not.toContain("Private Program");
  });

  it("runs a confirmed dry-run through actor, gate, system audit, and verify", async () => {
    const checksum = "b".repeat(64);
    const test = harness(checksum);
    const exitCode = await runAlumniImportCli(
      [
        "dry-run",
        "--file",
        "/restricted/alumni.csv",
        "--expected-sha256",
        checksum,
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
        "--execute",
        "--yes",
        "--json",
      ],
      {
        MONGODB_URI: SECRET_URI,
        ALUMNI_IMPORT_OPERATOR: "release-20260919",
      },
      test.adapters,
    );

    expect(exitCode).toBe(0);
    expect(test.connect).toHaveBeenCalledOnce();
    expect(test.connect.mock.calls[0]![0]).toBe(SECRET_URI);
    expect(test.connect.mock.calls[0]![1]).toMatchObject({
      autoCreate: false,
      autoIndex: false,
      bufferCommands: false,
      appName: "atcloud-alumni-import-cli",
    });
    expect(
      test.qualification.assertOperatorActor.mock.invocationCallOrder[0],
    ).toBeLessThan(
      test.qualification.assertOperationalGates.mock.invocationCallOrder[0]!,
    );
    expect(test.imports.dryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        auditSource: "system",
        operator: "release-20260919",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );
    expect(test.qualification.verifyBatch).toHaveBeenCalledWith({
      batchId: BATCH_ID,
      csv: CSV,
      expectation: {
        checksum,
        totalRows: 1,
        uniqueContacts: 1,
      },
    });
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.stdout.join("\n")).not.toContain(SECRET_URI);
    expect(test.stdout.join("\n")).not.toContain("private@example.com");
  });

  it("uses the cancellation-only gate and accepts zero unique contacts", async () => {
    const checksum = "c".repeat(64);
    const test = harness(checksum);
    const exitCode = await runAlumniImportCli(
      [
        "cancel",
        "--batch-id",
        BATCH_ID,
        "--expected-revision",
        "0",
        "--expected-sha256",
        checksum,
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
      ],
      { MONGODB_URI: SECRET_URI },
      test.adapters,
    );

    expect(exitCode).toBe(0);
    expect(test.qualification.assertCancellationGates).toHaveBeenCalledOnce();
    expect(test.qualification.assertOperationalGates).not.toHaveBeenCalled();
    expect(test.imports.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUniqueContactCount: 0,
        auditSource: "system",
        operator: "release-20260919",
      }),
    );
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      kind: "alumni_import_cancellation",
      batch: { uniqueContacts: 0 },
    });
  });

  it("fails write preflight before connecting and never emits secrets", async () => {
    const checksum = "d".repeat(64);
    const test = harness(checksum);
    const exitCode = await runAlumniImportCli(
      [
        "dry-run",
        "--file",
        "/restricted/alumni.csv",
        "--expected-sha256",
        checksum,
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
        "release-20260919",
        "--json",
      ],
      { MONGODB_URI: SECRET_URI },
      test.adapters,
    );

    expect(exitCode).toBe(2);
    expect(test.connect).not.toHaveBeenCalled();
    expect(test.stdout).toEqual([]);
    expect(test.stderr.join("\n")).not.toContain(SECRET_URI);
  });

  it("uses exit 3 when the transaction readiness gate is unavailable", async () => {
    const checksum = "f".repeat(64);
    const test = harness(checksum);
    test.qualification.assertOperationalGates.mockRejectedValueOnce(
      Object.assign(new Error("topology details must stay private"), {
        code: "MONGO_TRANSACTIONS_UNAVAILABLE",
      }),
    );
    const exitCode = await runAlumniImportCli(
      [
        "verify",
        "--batch-id",
        BATCH_ID,
        "--file",
        "/restricted/alumni.csv",
        "--expected-sha256",
        checksum,
        "--expected-row-count",
        "1",
        "--expected-unique-contacts",
        "1",
        "--actor-id",
        ACTOR_ID,
        "--confirm-db",
        "atcloud-production",
        "--json",
      ],
      { MONGODB_URI: SECRET_URI },
      test.adapters,
    );

    expect(exitCode).toBe(3);
    expect(test.stdout).toEqual([]);
    expect(JSON.parse(test.stderr[0]!)).toEqual({
      code: "MONGO_TRANSACTIONS_UNAVAILABLE",
    });
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("rejects a source larger than 8 MiB before reading it", async () => {
    const checksum = "e".repeat(64);
    const test = harness(checksum);
    const directory = await mkdtemp(join(tmpdir(), "alumni-import-cli-"));
    const sourcePath = join(directory, "oversized.csv");
    const handle = await open(sourcePath, "w");
    await handle.truncate(8 * 1024 * 1024 + 1);
    await handle.close();
    const adapters = { ...test.adapters, readFile: undefined };
    try {
      const exitCode = await runAlumniImportCli(
        ["inspect", "--file", sourcePath, "--json"],
        {},
        adapters,
      );
      expect(exitCode).toBe(2);
      expect(test.qualification.inspectSource).not.toHaveBeenCalled();
      expect(test.stderr).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
