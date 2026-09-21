import { describe, expect, it } from "vitest";
import {
  AlumniImportQualificationError,
  AlumniImportQualificationService,
} from "../../../../src/services/alumni/AlumniImportQualificationService";

describe("AlumniImportQualificationService source inspection", () => {
  const service = new AlumniImportQualificationService({
    migrationReadiness: { assertReady: async () => undefined },
    transactionService: {
      assertTopologyCapability: async () => ({ supported: true }),
    },
  });

  it("counts invalid rows once while retaining the field-issue histogram", () => {
    const csv = Buffer.from(
      "email,programName\nnot-an-email,\nvalid@example.com,Program\n",
      "utf8",
    );
    const report = service.inspectSource(csv);

    expect(report.status).toBe("failed");
    expect(report.source).toMatchObject({ totalRows: 2, uniqueContacts: 1 });
    expect(report.rowIssues).toEqual([
      { code: "invalid_email", count: 1 },
      { code: "required", count: 1 },
    ]);
    expect(report.issues).toContainEqual({
      code: "ROSTER_ROW_INVALID",
      count: 1,
    });
    expect(JSON.stringify(report)).not.toContain("valid@example.com");
    expect(JSON.stringify(report)).not.toContain("not-an-email");
  });

  it("enforces exact checksum, row, and unique-contact expectations", () => {
    const csv = Buffer.from(
      [
        "email,programName",
        "one@example.com,Program One",
        "one@example.com,Program Two",
      ].join("\n"),
      "utf8",
    );
    const inspected = service.inspectSource(csv);
    expect(
      service.assertExpectedSource(csv, {
        checksum: inspected.source.checksum,
        totalRows: 2,
        uniqueContacts: 1,
      }).status,
    ).toBe("passed");
    expect(() =>
      service.assertExpectedSource(csv, {
        checksum: inspected.source.checksum,
        totalRows: 2,
        uniqueContacts: 2,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AlumniImportQualificationError>>({
        code: "ALUMNI_IMPORT_SOURCE_EXPECTATION_MISMATCH",
      }),
    );
  });

  it("rejects impossible expectation shapes before qualification", () => {
    expect(() =>
      service.inspectSource(Buffer.from("email,programName\n"), {
        checksum: "a".repeat(64),
        totalRows: 1,
        uniqueContacts: 2,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AlumniImportQualificationError>>({
        code: "ALUMNI_IMPORT_SOURCE_EXPECTATION_INVALID",
      }),
    );
  });
});
