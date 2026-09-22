import { createHash } from "crypto";
import { TextDecoder } from "util";
import {
  isValidDisplayText,
  normalizeDisplayText,
  normalizeNullableDisplayText,
} from "@atcloud/shared-time/registration-profile";
import { isValidPersistedUserEmail } from "../../contracts/userEmail";

export const ALUMNI_ROSTER_CSV_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRows: 5_000,
  maxColumns: 64,
  maxCellCharacters: 2_000,
  maxHeaderCharacters: 100,
});

export const ALUMNI_ROSTER_COLUMNS = [
  "email",
  "firstName",
  "lastName",
  "programName",
  "cohortLabel",
  "programId",
] as const;

export type AlumniRosterColumn = (typeof ALUMNI_ROSTER_COLUMNS)[number];

export interface CanonicalAlumniRosterRow {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly programName: string;
  readonly cohortLabel: string | null;
  /** Explicit roster value only; no Program title lookup is performed here. */
  readonly programId: string | null;
}

export const ALUMNI_ROSTER_ROW_ISSUE_CODES = [
  "required",
  "invalid_email",
  "invalid_display_text",
  "invalid_program_id",
] as const;

export type AlumniRosterRowIssueCode =
  (typeof ALUMNI_ROSTER_ROW_ISSUE_CODES)[number];

export interface AlumniRosterRowIssue {
  readonly field: AlumniRosterColumn;
  readonly code: AlumniRosterRowIssueCode;
  readonly message: string;
}

export interface RetainedAlumniRosterRawRow {
  readonly rowNumber: number;
  readonly values: readonly string[];
}

export interface ParsedAlumniRosterRow {
  readonly rowNumber: number;
  readonly rowKey: string;
  readonly value: CanonicalAlumniRosterRow | null;
  readonly issues: readonly AlumniRosterRowIssue[];
}

export interface ParsedAlumniRoster {
  /** SHA-256 of the exact uploaded CSV bytes. */
  readonly checksum: string;
  readonly rawHeaders: readonly string[];
  readonly canonicalHeaders: readonly AlumniRosterColumn[];
  readonly rawRows: readonly RetainedAlumniRosterRawRow[];
  readonly rows: readonly ParsedAlumniRosterRow[];
}

export const ALUMNI_ROSTER_CSV_ERROR_CODES = [
  "CSV_INPUT_INVALID",
  "CSV_TOO_LARGE",
  "CSV_EMPTY",
  "CSV_INVALID_UTF8",
  "CSV_NUL_BYTE",
  "CSV_UNTERMINATED_QUOTE",
  "CSV_UNEXPECTED_QUOTE",
  "CSV_UNEXPECTED_CHARACTER_AFTER_QUOTE",
  "CSV_BARE_CR",
  "CSV_TOO_MANY_COLUMNS",
  "CSV_TOO_MANY_ROWS",
  "CSV_CELL_TOO_LONG",
  "CSV_ROW_WIDTH_MISMATCH",
  "CSV_HEADER_TOO_LONG",
  "CSV_UNKNOWN_HEADER",
  "CSV_DUPLICATE_HEADER",
  "CSV_MISSING_REQUIRED_HEADER",
  "CSV_CHECKSUM_INVALID",
  "CSV_RETAINED_ROW_INVALID",
  "CSV_DUPLICATE_ROW_NUMBER",
  "CSV_RETAINED_DATA_TOO_LARGE",
] as const;

export type AlumniRosterCsvErrorCode =
  (typeof ALUMNI_ROSTER_CSV_ERROR_CODES)[number];

export interface AlumniRosterCsvErrorContext {
  readonly rowNumber?: number;
  readonly columnNumber?: number;
  readonly field?: string;
}

export class AlumniRosterCsvError extends Error {
  readonly name = "AlumniRosterCsvError";

  constructor(
    public readonly code: AlumniRosterCsvErrorCode,
    message: string,
    public readonly context: AlumniRosterCsvErrorContext = {},
  ) {
    super(message);
  }
}

interface CsvRecord {
  readonly rowNumber: number;
  readonly values: string[];
}

const REQUIRED_COLUMNS = new Set<AlumniRosterColumn>([
  "email",
  "programName",
]);
const COLUMN_BY_NORMALIZED_HEADER = new Map<string, AlumniRosterColumn>(
  ALUMNI_ROSTER_COLUMNS.map((column) => [normalizeHeaderKey(column), column]),
);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
const MAX_EMAIL_CHARACTERS = 254;
const MAX_NAME_CODE_POINTS = 100;
const MAX_PROGRAM_NAME_CODE_POINTS = 160;
const MAX_COHORT_CODE_POINTS = 100;
const ROW_KEY_DOMAIN = "atcloud:alumni-roster-row:v1\0";

function csvError(
  code: AlumniRosterCsvErrorCode,
  message: string,
  context: AlumniRosterCsvErrorContext = {},
): never {
  throw new AlumniRosterCsvError(code, message, context);
}

function normalizeHeaderKey(value: string): string {
  return value.toLowerCase().replace(/[ _-]+/g, "");
}

function validateCellLength(
  value: string,
  rowNumber: number,
  columnNumber: number,
): void {
  if (value.length > ALUMNI_ROSTER_CSV_LIMITS.maxCellCharacters) {
    csvError(
      "CSV_CELL_TOO_LONG",
      `CSV cell exceeds ${ALUMNI_ROSTER_CSV_LIMITS.maxCellCharacters} characters.`,
      { rowNumber, columnNumber },
    );
  }
}

function parseCsvRecords(value: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = "";
  let lineNumber = 1;
  let recordStartLine = 1;
  let fieldStarted = false;
  let insideQuotes = false;
  let afterClosingQuote = false;

  const pushField = () => {
    validateCellLength(field, recordStartLine, row.length + 1);
    row.push(field);
    if (row.length > ALUMNI_ROSTER_CSV_LIMITS.maxColumns) {
      csvError(
        "CSV_TOO_MANY_COLUMNS",
        `CSV cannot contain more than ${ALUMNI_ROSTER_CSV_LIMITS.maxColumns} columns.`,
        { rowNumber: recordStartLine, columnNumber: row.length },
      );
    }
    field = "";
    fieldStarted = false;
    afterClosingQuote = false;
  };

  const pushRecord = () => {
    pushField();
    records.push({ rowNumber: recordStartLine, values: row });
    if (records.length > ALUMNI_ROSTER_CSV_LIMITS.maxRows + 1) {
      csvError(
        "CSV_TOO_MANY_ROWS",
        `CSV cannot contain more than ${ALUMNI_ROSTER_CSV_LIMITS.maxRows} data rows.`,
        { rowNumber: recordStartLine },
      );
    }
    row = [];
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;

    if (insideQuotes) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          insideQuotes = false;
          afterClosingQuote = true;
        }
        continue;
      }
      if (character === "\r") {
        if (value[index + 1] !== "\n") {
          csvError(
            "CSV_BARE_CR",
            "CSV uses a carriage return that is not followed by a line feed.",
            { rowNumber: lineNumber },
          );
        }
        field += "\r\n";
        index += 1;
        lineNumber += 1;
        continue;
      }
      if (character === "\n") {
        field += "\n";
        lineNumber += 1;
        continue;
      }
      field += character;
      continue;
    }

    if (afterClosingQuote) {
      if (character === ",") {
        pushField();
        continue;
      }
      if (character === "\r" || character === "\n") {
        if (character === "\r") {
          if (value[index + 1] !== "\n") {
            csvError(
              "CSV_BARE_CR",
              "CSV uses a carriage return that is not followed by a line feed.",
              { rowNumber: lineNumber },
            );
          }
          index += 1;
        }
        pushRecord();
        lineNumber += 1;
        recordStartLine = lineNumber;
        continue;
      }
      csvError(
        "CSV_UNEXPECTED_CHARACTER_AFTER_QUOTE",
        "CSV contains a character after a closing quote.",
        { rowNumber: lineNumber, columnNumber: row.length + 1 },
      );
    }

    if (character === '"') {
      if (fieldStarted) {
        csvError(
          "CSV_UNEXPECTED_QUOTE",
          "CSV contains a quote inside an unquoted field.",
          { rowNumber: lineNumber, columnNumber: row.length + 1 },
        );
      }
      fieldStarted = true;
      insideQuotes = true;
      continue;
    }
    if (character === ",") {
      pushField();
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r") {
        if (value[index + 1] !== "\n") {
          csvError(
            "CSV_BARE_CR",
            "CSV uses a carriage return that is not followed by a line feed.",
            { rowNumber: lineNumber },
          );
        }
        index += 1;
      }
      pushRecord();
      lineNumber += 1;
      recordStartLine = lineNumber;
      continue;
    }
    fieldStarted = true;
    field += character;
  }

  if (insideQuotes) {
    csvError(
      "CSV_UNTERMINATED_QUOTE",
      "CSV contains an unterminated quoted field.",
      { rowNumber: recordStartLine, columnNumber: row.length + 1 },
    );
  }
  if (row.length > 0 || fieldStarted || afterClosingQuote || field.length > 0) {
    pushRecord();
  }
  return records;
}

function canonicalizeHeaders(headers: readonly string[]): AlumniRosterColumn[] {
  if (headers.length === 0) {
    csvError("CSV_EMPTY", "CSV must contain a header row.");
  }
  if (headers.length > ALUMNI_ROSTER_CSV_LIMITS.maxColumns) {
    csvError(
      "CSV_TOO_MANY_COLUMNS",
      `CSV cannot contain more than ${ALUMNI_ROSTER_CSV_LIMITS.maxColumns} columns.`,
      { rowNumber: 1 },
    );
  }

  const canonical: AlumniRosterColumn[] = [];
  const seen = new Set<AlumniRosterColumn>();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    if (header.length > ALUMNI_ROSTER_CSV_LIMITS.maxHeaderCharacters) {
      csvError(
        "CSV_HEADER_TOO_LONG",
        `CSV header exceeds ${ALUMNI_ROSTER_CSV_LIMITS.maxHeaderCharacters} characters.`,
        { rowNumber: 1, columnNumber: index + 1 },
      );
    }
    const normalized = normalizeHeaderKey(header);
    const column = COLUMN_BY_NORMALIZED_HEADER.get(normalized);
    if (!column) {
      csvError("CSV_UNKNOWN_HEADER", "CSV contains an unknown header.", {
        rowNumber: 1,
        columnNumber: index + 1,
        field: header,
      });
    }
    if (seen.has(column)) {
      csvError("CSV_DUPLICATE_HEADER", "CSV contains a duplicate header.", {
        rowNumber: 1,
        columnNumber: index + 1,
        field: column,
      });
    }
    seen.add(column);
    canonical.push(column);
  }

  const missing = [...REQUIRED_COLUMNS].filter((column) => !seen.has(column));
  if (missing.length > 0) {
    csvError(
      "CSV_MISSING_REQUIRED_HEADER",
      "CSV is missing a required header.",
      { rowNumber: 1, field: missing[0] },
    );
  }
  return canonical;
}

function rowIssue(
  field: AlumniRosterColumn,
  code: AlumniRosterRowIssueCode,
  message: string,
): AlumniRosterRowIssue {
  return Object.freeze({ field, code, message });
}

function parseCanonicalRow(
  canonicalHeaders: readonly AlumniRosterColumn[],
  values: readonly string[],
): Readonly<{
  value: CanonicalAlumniRosterRow | null;
  issues: readonly AlumniRosterRowIssue[];
}> {
  const source = new Map<AlumniRosterColumn, string>();
  canonicalHeaders.forEach((header, index) => source.set(header, values[index]!));
  const issues: AlumniRosterRowIssue[] = [];

  const email = (source.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    issues.push(rowIssue("email", "required", "Email is required."));
  } else if (
    email.length > MAX_EMAIL_CHARACTERS ||
    !isValidPersistedUserEmail(email)
  ) {
    issues.push(
      rowIssue("email", "invalid_email", "Email must be a valid address."),
    );
  }

  const firstName = normalizeNullableDisplayText(source.get("firstName"));
  if (
    firstName !== null &&
    !isValidDisplayText(firstName, 1, MAX_NAME_CODE_POINTS)
  ) {
    issues.push(
      rowIssue(
        "firstName",
        "invalid_display_text",
        "First name must contain 1-100 characters.",
      ),
    );
  }

  const lastName = normalizeNullableDisplayText(source.get("lastName"));
  if (
    lastName !== null &&
    !isValidDisplayText(lastName, 1, MAX_NAME_CODE_POINTS)
  ) {
    issues.push(
      rowIssue(
        "lastName",
        "invalid_display_text",
        "Last name must contain 1-100 characters.",
      ),
    );
  }

  const rawProgramName = source.get("programName") ?? "";
  const programName = normalizeDisplayText(rawProgramName);
  if (!programName) {
    issues.push(
      rowIssue("programName", "required", "Program name is required."),
    );
  } else if (
    !isValidDisplayText(programName, 1, MAX_PROGRAM_NAME_CODE_POINTS)
  ) {
    issues.push(
      rowIssue(
        "programName",
        "invalid_display_text",
        "Program name must contain 1-160 characters.",
      ),
    );
  }

  const cohortLabel = normalizeNullableDisplayText(source.get("cohortLabel"));
  if (
    cohortLabel !== null &&
    !isValidDisplayText(cohortLabel, 1, MAX_COHORT_CODE_POINTS)
  ) {
    issues.push(
      rowIssue(
        "cohortLabel",
        "invalid_display_text",
        "Cohort label must contain 1-100 characters.",
      ),
    );
  }

  const rawProgramId = source.get("programId")?.trim().toLowerCase() ?? "";
  const programId = rawProgramId || null;
  if (programId !== null && !OBJECT_ID_PATTERN.test(programId)) {
    issues.push(
      rowIssue(
        "programId",
        "invalid_program_id",
        "Program id must be a 24-character hexadecimal ObjectId.",
      ),
    );
  }

  if (issues.length > 0) {
    return Object.freeze({ value: null, issues: Object.freeze(issues) });
  }
  return Object.freeze({
    value: Object.freeze({
      email,
      firstName,
      lastName,
      programName,
      cohortLabel,
      programId,
    }),
    issues: Object.freeze([]),
  });
}

function validateRetainedDataSize(
  headers: readonly string[],
  rawRows: readonly RetainedAlumniRosterRawRow[],
): void {
  let bytes = Buffer.byteLength(
    `{"headers":${JSON.stringify(headers)},"rows":[`,
    "utf8",
  );
  for (let index = 0; index < rawRows.length; index += 1) {
    const row = rawRows[index]!;
    if (index > 0) bytes += 1;
    bytes += Buffer.byteLength(
      JSON.stringify({ rowNumber: row.rowNumber, values: row.values }),
      "utf8",
    );
    if (bytes > ALUMNI_ROSTER_CSV_LIMITS.maxBytes) {
      csvError(
        "CSV_RETAINED_DATA_TOO_LARGE",
        "Retained CSV rows exceed the 8 MiB batch limit.",
      );
    }
  }
  bytes += 2;
  if (bytes > ALUMNI_ROSTER_CSV_LIMITS.maxBytes) {
    csvError(
      "CSV_RETAINED_DATA_TOO_LARGE",
      "Retained CSV rows exceed the 8 MiB batch limit.",
    );
  }
}

export function deriveAlumniRosterRowKey(
  checksum: string,
  rowNumber: number,
): string {
  if (!SHA256_HEX_PATTERN.test(checksum)) {
    csvError("CSV_CHECKSUM_INVALID", "Roster checksum must be SHA-256.");
  }
  if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) {
    csvError(
      "CSV_RETAINED_ROW_INVALID",
      "Retained roster rowNumber must be a positive safe integer.",
    );
  }
  return createHash("sha256")
    .update(ROW_KEY_DOMAIN, "utf8")
    .update(checksum, "utf8")
    .update("\0", "utf8")
    .update(String(rowNumber), "utf8")
    .digest("hex");
}

export function parseRetainedAlumniRoster(
  headers: readonly string[],
  rawRows: readonly RetainedAlumniRosterRawRow[],
  checksum: string,
): ParsedAlumniRoster {
  if (!Array.isArray(headers) || !Array.isArray(rawRows)) {
    csvError(
      "CSV_INPUT_INVALID",
      "Retained roster headers and rows must be arrays.",
    );
  }
  if (!SHA256_HEX_PATTERN.test(checksum)) {
    csvError("CSV_CHECKSUM_INVALID", "Roster checksum must be SHA-256.");
  }
  if (rawRows.length > ALUMNI_ROSTER_CSV_LIMITS.maxRows) {
    csvError(
      "CSV_TOO_MANY_ROWS",
      `CSV cannot contain more than ${ALUMNI_ROSTER_CSV_LIMITS.maxRows} data rows.`,
    );
  }
  if (headers.some((header) => typeof header !== "string")) {
    csvError("CSV_INPUT_INVALID", "Every retained roster header must be text.");
  }

  const copiedHeaders = headers.map((header) => header);
  const canonicalHeaders = canonicalizeHeaders(copiedHeaders);
  const seenRowNumbers = new Set<number>();
  const copiedRows: RetainedAlumniRosterRawRow[] = [];
  const parsedRows: ParsedAlumniRosterRow[] = [];

  for (const rawRow of rawRows) {
    if (
      !rawRow ||
      !Number.isSafeInteger(rawRow.rowNumber) ||
      rawRow.rowNumber < 1 ||
      !Array.isArray(rawRow.values) ||
      rawRow.values.some((value: unknown) => typeof value !== "string")
    ) {
      csvError(
        "CSV_RETAINED_ROW_INVALID",
        "Retained roster rows require a positive rowNumber and text values.",
      );
    }
    if (seenRowNumbers.has(rawRow.rowNumber)) {
      csvError(
        "CSV_DUPLICATE_ROW_NUMBER",
        "Retained roster row numbers must be unique.",
        { rowNumber: rawRow.rowNumber },
      );
    }
    seenRowNumbers.add(rawRow.rowNumber);
    if (rawRow.values.length !== copiedHeaders.length) {
      csvError(
        "CSV_ROW_WIDTH_MISMATCH",
        "Every CSV row must contain the same number of cells as the header.",
        { rowNumber: rawRow.rowNumber },
      );
    }
    const values = rawRow.values.map((value: string, index: number) => {
      if (value.includes("\u0000")) {
        csvError("CSV_NUL_BYTE", "CSV cannot contain NUL characters.", {
          rowNumber: rawRow.rowNumber,
          columnNumber: index + 1,
        });
      }
      validateCellLength(value, rawRow.rowNumber, index + 1);
      return value;
    });
    const copiedRow = Object.freeze({
      rowNumber: rawRow.rowNumber,
      values: Object.freeze(values),
    });
    copiedRows.push(copiedRow);

    const parsed = parseCanonicalRow(canonicalHeaders, values);
    parsedRows.push(
      Object.freeze({
        rowNumber: rawRow.rowNumber,
        rowKey: deriveAlumniRosterRowKey(checksum, rawRow.rowNumber),
        value: parsed.value,
        issues: parsed.issues,
      }),
    );
  }

  validateRetainedDataSize(copiedHeaders, copiedRows);
  return Object.freeze({
    checksum,
    rawHeaders: Object.freeze(copiedHeaders),
    canonicalHeaders: Object.freeze(canonicalHeaders),
    rawRows: Object.freeze(copiedRows),
    rows: Object.freeze(parsedRows),
  });
}

export function parseAlumniRosterCsv(buffer: Buffer): ParsedAlumniRoster {
  if (!Buffer.isBuffer(buffer)) {
    csvError("CSV_INPUT_INVALID", "Roster CSV input must be a Buffer.");
  }
  if (buffer.length > ALUMNI_ROSTER_CSV_LIMITS.maxBytes) {
    csvError(
      "CSV_TOO_LARGE",
      "Roster CSV cannot exceed 8 MiB.",
    );
  }
  if (buffer.length === 0) {
    csvError("CSV_EMPTY", "CSV must contain a header row.");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    csvError("CSV_INVALID_UTF8", "Roster CSV must be valid UTF-8.");
  }
  if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);
  if (decoded.includes("\u0000")) {
    csvError("CSV_NUL_BYTE", "CSV cannot contain NUL characters.");
  }

  const records = parseCsvRecords(decoded);
  if (records.length === 0) {
    csvError("CSV_EMPTY", "CSV must contain a header row.");
  }
  const [header, ...dataRows] = records;
  const checksum = createHash("sha256").update(buffer).digest("hex");
  return parseRetainedAlumniRoster(
    header!.values,
    dataRows.map((record) => ({
      rowNumber: record.rowNumber,
      values: record.values,
    })),
    checksum,
  );
}
