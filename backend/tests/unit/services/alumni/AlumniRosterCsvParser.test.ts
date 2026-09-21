import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  ALUMNI_ROSTER_CSV_LIMITS,
  AlumniRosterCsvError,
  deriveAlumniRosterRowKey,
  parseAlumniRosterCsv,
  parseRetainedAlumniRoster,
} from "../../../../src/services/alumni/AlumniRosterCsvParser";

function csv(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function checksum(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function captureError(operation: () => unknown): AlumniRosterCsvError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AlumniRosterCsvError);
    return error as AlumniRosterCsvError;
  }
  throw new Error("Expected AlumniRosterCsvError");
}

describe("AlumniRosterCsvParser", () => {
  it("parses UTF-8 BOM, CRLF, normalized headers, and quoted fields", () => {
    const input = csv(
      "\ufeffE-Mail,First Name,LAST_NAME,Program-Name,cohort_label,PROGRAM ID\r\n" +
        ' ALUMNA@Example.COM ," Amy  ","Chen, PhD","EMBA ""Leadership""", 2022 ,507F1F77BCF86CD799439011\r\n',
    );

    const result = parseAlumniRosterCsv(input);

    expect(result.checksum).toBe(checksum(input));
    expect(result.canonicalHeaders).toEqual([
      "email",
      "firstName",
      "lastName",
      "programName",
      "cohortLabel",
      "programId",
    ]);
    expect(result.rawRows).toEqual([
      {
        rowNumber: 2,
        values: [
          " ALUMNA@Example.COM ",
          " Amy  ",
          "Chen, PhD",
          'EMBA "Leadership"',
          " 2022 ",
          "507F1F77BCF86CD799439011",
        ],
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      value: {
        email: "alumna@example.com",
        firstName: "Amy",
        lastName: "Chen, PhD",
        programName: 'EMBA "Leadership"',
        cohortLabel: "2022",
        programId: "507f1f77bcf86cd799439011",
      },
      issues: [],
    });
    expect(result.rows[0]!.rowKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports reordered required headers and supplies null optional values", () => {
    const result = parseAlumniRosterCsv(
      csv("Program Name,email\n  EMBA   Alumni  ,PERSON@example.com"),
    );

    expect(result.rows[0]!.value).toEqual({
      email: "person@example.com",
      firstName: null,
      lastName: null,
      programName: "EMBA Alumni",
      cohortLabel: null,
      programId: null,
    });
  });

  it("returns deterministic row issues instead of rejecting the whole roster", () => {
    const result = parseAlumniRosterCsv(
      csv(
        "email,programName,firstName,programId\n" +
          "not-an-email, ,Amy,not-an-object-id\n" +
          ",EMBA,Bob,\n",
      ),
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      value: null,
      issues: [
        { field: "email", code: "invalid_email" },
        { field: "programName", code: "required" },
        { field: "programId", code: "invalid_program_id" },
      ],
    });
    expect(result.rows[1]).toMatchObject({
      rowNumber: 3,
      value: null,
      issues: [{ field: "email", code: "required" }],
    });
  });

  it.each(["person+tag@example.com", "person@example.info"])(
    "rejects %s when it cannot satisfy the persisted User email contract",
    (email) => {
      const result = parseAlumniRosterCsv(
        csv(`email,programName\n${email},EMBA`),
      );

      expect(result.rows[0]).toMatchObject({
        value: null,
        issues: [{ field: "email", code: "invalid_email" }],
      });
    },
  );

  it.each([
    {
      name: "unknown header",
      input: "email,programName,company\na@example.com,EMBA,Example",
      code: "CSV_UNKNOWN_HEADER",
    },
    {
      name: "normalized duplicate header",
      input: "email,e-mail,programName\na@example.com,a@example.com,EMBA",
      code: "CSV_DUPLICATE_HEADER",
    },
    {
      name: "missing required header",
      input: "email,firstName\na@example.com,Amy",
      code: "CSV_MISSING_REQUIRED_HEADER",
    },
  ])("rejects $name", ({ input, code }) => {
    expect(captureError(() => parseAlumniRosterCsv(csv(input))).code).toBe(code);
  });

  it.each([
    {
      name: "unterminated quote",
      input: 'email,programName\n"a@example.com,EMBA',
      code: "CSV_UNTERMINATED_QUOTE",
    },
    {
      name: "quote in an unquoted field",
      input: 'email,programName\na"@example.com,EMBA',
      code: "CSV_UNEXPECTED_QUOTE",
    },
    {
      name: "text after a closing quote",
      input: 'email,programName\n"a@example.com"x,EMBA',
      code: "CSV_UNEXPECTED_CHARACTER_AFTER_QUOTE",
    },
    {
      name: "bare carriage return",
      input: "email,programName\ra@example.com,EMBA",
      code: "CSV_BARE_CR",
    },
    {
      name: "ragged row",
      input: "email,programName\na@example.com",
      code: "CSV_ROW_WIDTH_MISMATCH",
    },
  ])("rejects malformed CSV: $name", ({ input, code }) => {
    expect(captureError(() => parseAlumniRosterCsv(csv(input))).code).toBe(code);
  });

  it("accepts quoted line breaks while retaining the record's starting line", () => {
    const result = parseAlumniRosterCsv(
      csv(
        "email,programName,firstName\r\n" +
          'a@example.com,EMBA,"Amy\r\nChen"\r\n' +
          "b@example.com,EMBA,Bob",
      ),
    );

    expect(result.rawRows[0]).toEqual({
      rowNumber: 2,
      values: ["a@example.com", "EMBA", "Amy\r\nChen"],
    });
    expect(result.rows[0]!.value?.firstName).toBe("Amy Chen");
    expect(result.rows[1]!.rowNumber).toBe(4);
  });

  it("rejects invalid UTF-8 and NUL characters", () => {
    const invalidUtf8 = Buffer.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0xff]);
    expect(captureError(() => parseAlumniRosterCsv(invalidUtf8)).code).toBe(
      "CSV_INVALID_UTF8",
    );
    expect(
      captureError(() =>
        parseAlumniRosterCsv(csv("email,programName\na@example.com,EM\0BA")),
      ).code,
    ).toBe("CSV_NUL_BYTE");
  });

  it("enforces byte, row, column, and cell bounds", () => {
    expect(
      captureError(() =>
        parseAlumniRosterCsv(
          Buffer.alloc(ALUMNI_ROSTER_CSV_LIMITS.maxBytes + 1, 0x61),
        ),
      ).code,
    ).toBe("CSV_TOO_LARGE");

    const tooManyRows = [
      "email,programName",
      ...Array.from(
        { length: ALUMNI_ROSTER_CSV_LIMITS.maxRows + 1 },
        (_, index) => `person${index}@example.com,EMBA`,
      ),
    ].join("\n");
    expect(
      captureError(() => parseAlumniRosterCsv(csv(tooManyRows))).code,
    ).toBe("CSV_TOO_MANY_ROWS");

    const tooManyColumns = Array.from(
      { length: ALUMNI_ROSTER_CSV_LIMITS.maxColumns + 1 },
      (_, index) => `header${index}`,
    ).join(",");
    expect(
      captureError(() => parseAlumniRosterCsv(csv(tooManyColumns))).code,
    ).toBe("CSV_TOO_MANY_COLUMNS");

    const longCell = "a".repeat(
      ALUMNI_ROSTER_CSV_LIMITS.maxCellCharacters + 1,
    );
    expect(
      captureError(() =>
        parseAlumniRosterCsv(
          csv(`email,programName\na@example.com,${longCell}`),
        ),
      ).code,
    ).toBe("CSV_CELL_TOO_LONG");
  });

  it("re-normalizes retained rows and reproduces CSV row keys", () => {
    const input = csv(
      "email,programName,programId\nA@example.com, EMBA ,507F1F77BCF86CD799439011",
    );
    const parsedCsv = parseAlumniRosterCsv(input);
    const rerun = parseRetainedAlumniRoster(
      parsedCsv.rawHeaders,
      parsedCsv.rawRows,
      parsedCsv.checksum,
    );

    expect(rerun).toEqual(parsedCsv);
    expect(rerun.rows[0]!.rowKey).toBe(
      deriveAlumniRosterRowKey(parsedCsv.checksum, 2),
    );
    expect(deriveAlumniRosterRowKey(parsedCsv.checksum, 3)).not.toBe(
      rerun.rows[0]!.rowKey,
    );
    expect(deriveAlumniRosterRowKey("f".repeat(64), 2)).not.toBe(
      rerun.rows[0]!.rowKey,
    );
  });

  it("rejects corrupt retained input before re-normalizing", () => {
    const validHeaders = ["email", "programName"];
    const validRow = {
      rowNumber: 2,
      values: ["a@example.com", "EMBA"],
    };

    expect(
      captureError(() =>
        parseRetainedAlumniRoster(validHeaders, [validRow], "not-a-checksum"),
      ).code,
    ).toBe("CSV_CHECKSUM_INVALID");
    expect(
      captureError(() =>
        parseRetainedAlumniRoster(
          validHeaders,
          [validRow, validRow],
          "a".repeat(64),
        ),
      ).code,
    ).toBe("CSV_DUPLICATE_ROW_NUMBER");
  });

  it("bounds the retained representation used by reruns", () => {
    const largeRows = Array.from({ length: 4_200 }, (_, index) => ({
      rowNumber: index + 2,
      values: [`person${index}@example.com`, "a".repeat(2_000)],
    }));

    expect(
      captureError(() =>
        parseRetainedAlumniRoster(
          ["email", "programName"],
          largeRows,
          "a".repeat(64),
        ),
      ).code,
    ).toBe("CSV_RETAINED_DATA_TOO_LARGE");
  });
});
