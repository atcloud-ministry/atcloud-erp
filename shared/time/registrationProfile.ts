import {
  ISO_COUNTRY_CODES,
  ISO_SUBDIVISION_CODES,
} from "./iso3166Codes.js";
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

export {
  ISO_3166_DATASET_VERSION,
  ISO_COUNTRY_CODES,
  ISO_SUBDIVISION_CODES,
} from "./iso3166Codes.js";

export const EMPLOYMENT_STATUSES = [
  "employed",
  "self_employed",
  "student",
  "not_currently_employed",
  "retired",
] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const REGISTRATION_PROFILE_FIELDS = [
  "phone",
  "birthYear",
  "residenceCity",
  "residenceRegion",
  "residenceCountryCode",
  "employmentStatus",
  "company",
  "occupation",
] as const;

export type RegistrationProfileField =
  (typeof REGISTRATION_PROFILE_FIELDS)[number];

/** Canonical values saved for a new registration after validation. */
export interface RegistrationProfileFields {
  phone: string;
  birthYear: number;
  residenceCity: string;
  residenceRegion: string | null;
  residenceCountryCode: IsoCountryCode;
  employmentStatus: EmploymentStatus;
  company: string | null;
  occupation: string | null;
}

/** Existing users may omit fields until the profile-completion flow is finished. */
export type StoredRegistrationProfileFields =
  Partial<RegistrationProfileFields>;

export type RegistrationProfileInput = Partial<
  Record<RegistrationProfileField, unknown>
>;

export type RegistrationProfileValidationCode =
  | "required"
  | "invalid_type"
  | "invalid_format"
  | "out_of_range"
  | "too_long";

export interface RegistrationProfileValidationIssue {
  field: RegistrationProfileField;
  code: RegistrationProfileValidationCode;
  message: string;
}

export type RegistrationProfileValidationResult =
  | { success: true; value: RegistrationProfileFields }
  | { success: false; issues: RegistrationProfileValidationIssue[] };

export const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
export const MIN_BIRTH_YEAR = 1900;
export const PROFILE_DISPLAY_TEXT_MAX_CODE_POINTS = 100;

export type IsoCountryCode = (typeof ISO_COUNTRY_CODES)[number];

const ISO_COUNTRY_CODE_SET: ReadonlySet<string> = new Set(ISO_COUNTRY_CODES);
const ISO_SUBDIVISION_CODE_SET: ReadonlySet<string> = new Set(
  ISO_SUBDIVISION_CODES,
);
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function isEmploymentStatus(value: unknown): value is EmploymentStatus {
  return (
    typeof value === "string" &&
    (EMPLOYMENT_STATUSES as readonly string[]).includes(value)
  );
}

export function isE164Phone(value: unknown): value is string {
  if (typeof value !== "string" || !E164_PHONE_PATTERN.test(value)) return false;
  const parsed = parsePhoneNumberFromString(value);
  return parsed?.number === value && parsed.isValid();
}

/** Convert a selected country's national number or a full international number to E.164. */
export function normalizePhoneToE164(
  value: unknown,
  countryCode?: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input) return null;
  const defaultCountry =
    typeof countryCode === "string" &&
    isSupportedCountry(countryCode as CountryCode)
      ? (countryCode as CountryCode)
      : undefined;
  if (!input.startsWith("+") && !defaultCountry) return null;
  const parsed = parsePhoneNumberFromString(input, {
    defaultCountry,
    extract: false,
  });
  return parsed?.isValid() && !parsed.ext && isE164Phone(parsed.number)
    ? parsed.number
    : null;
}

export function getCurrentUtcYear(now = new Date()): number {
  return now.getUTCFullYear();
}

export function isBirthYear(value: unknown, now = new Date()): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_BIRTH_YEAR &&
    value <= getCurrentUtcYear(now)
  );
}

export function normalizeDisplayText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function normalizeNullableDisplayText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeDisplayText(value);
  return normalized.length > 0 ? normalized : null;
}

/** Normalize a biography without collapsing its paragraph breaks. */
export function normalizeNullableMultilineDisplayText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) =>
      line.replace(/[\t\p{Zs}]+/gu, " ").replace(/^ +| +$/gu, ""),
    )
    .join("\n")
    .replace(/^\n+|\n+$/gu, "");
  return normalized.length > 0 ? normalized : null;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function isValidDisplayText(
  value: unknown,
  minimumCodePoints = 1,
  maximumCodePoints = PROFILE_DISPLAY_TEXT_MAX_CODE_POINTS,
): value is string {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  const length = codePointLength(value);
  return length >= minimumCodePoints && length <= maximumCodePoints;
}

export function isValidMultilineDisplayText(
  value: unknown,
  minimumCodePoints = 1,
  maximumCodePoints = 2_000,
): value is string {
  if (
    typeof value !== "string" ||
    CONTROL_CHARACTER_PATTERN.test(value.replace(/\n/gu, ""))
  ) {
    return false;
  }
  const length = codePointLength(value);
  return length >= minimumCodePoints && length <= maximumCodePoints;
}

export function normalizeSearchText(value: string): string {
  return normalizeDisplayText(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeCountryCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isIsoCountryCode(value: unknown): value is IsoCountryCode {
  return typeof value === "string" && ISO_COUNTRY_CODE_SET.has(value);
}

export function normalizeSubdivisionCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isIsoSubdivisionCode(
  value: unknown,
  countryCode: unknown,
): value is string {
  if (
    typeof value !== "string" ||
    !isIsoCountryCode(countryCode) ||
    !value.startsWith(`${countryCode}-`)
  ) {
    return false;
  }
  return ISO_SUBDIVISION_CODE_SET.has(value);
}

export function employmentRequiresCompany(
  value: EmploymentStatus,
): boolean {
  return value === "employed" || value === "self_employed";
}

function addTextIssue(
  issues: RegistrationProfileValidationIssue[],
  field: "residenceCity" | "company" | "occupation",
  rawValue: unknown,
  required: boolean,
): string | null {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    if (required) {
      issues.push({ field, code: "required", message: `${field} is required` });
    }
    return null;
  }
  if (typeof rawValue !== "string") {
    issues.push({
      field,
      code: "invalid_type",
      message: `${field} must be a string`,
    });
    return null;
  }
  if (CONTROL_CHARACTER_PATTERN.test(rawValue)) {
    issues.push({
      field,
      code: "invalid_format",
      message: `${field} must contain display text on one line`,
    });
    return null;
  }
  const value = normalizeDisplayText(rawValue);
  if (value.length === 0) {
    if (required) {
      issues.push({ field, code: "required", message: `${field} is required` });
    }
    return null;
  }
  if (codePointLength(value) > PROFILE_DISPLAY_TEXT_MAX_CODE_POINTS) {
    issues.push({
      field,
      code: "too_long",
      message: `${field} must be at most 100 characters`,
    });
    return null;
  }
  return value;
}

export function validateRegistrationProfile(
  input: RegistrationProfileInput,
  now = new Date(),
): RegistrationProfileValidationResult {
  const issues: RegistrationProfileValidationIssue[] = [];

  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (
    input.phone === undefined ||
    input.phone === null ||
    (typeof input.phone === "string" && phone === "")
  ) {
    issues.push({ field: "phone", code: "required", message: "Phone is required." });
  } else if (typeof input.phone !== "string") {
    issues.push({
      field: "phone",
      code: "invalid_type",
      message: "Enter a valid phone number.",
    });
  } else if (!isE164Phone(phone)) {
    issues.push({
      field: "phone",
      code: "invalid_format",
      message: "Enter a valid phone number, including its country code.",
    });
  }

  let birthYear = Number.NaN;
  if (
    input.birthYear === undefined ||
    input.birthYear === null ||
    input.birthYear === ""
  ) {
    issues.push({
      field: "birthYear",
      code: "required",
      message: "birthYear is required",
    });
  } else if (
    typeof input.birthYear !== "number" &&
    typeof input.birthYear !== "string"
  ) {
    issues.push({
      field: "birthYear",
      code: "invalid_type",
      message: "birthYear must be a number or four-digit string",
    });
  } else {
    birthYear =
      typeof input.birthYear === "number"
        ? input.birthYear
        : /^\d{4}$/.test(input.birthYear.trim())
          ? Number(input.birthYear.trim())
          : Number.NaN;
  }
  if (
    input.birthYear !== undefined &&
    input.birthYear !== null &&
    input.birthYear !== "" &&
    (typeof input.birthYear === "number" ||
      typeof input.birthYear === "string") &&
    !isBirthYear(birthYear, now)
  ) {
    issues.push({
      field: "birthYear",
      code: "out_of_range",
      message: `birthYear must be an integer from ${MIN_BIRTH_YEAR} to ${getCurrentUtcYear(now)}`,
    });
  }

  const countryCandidate =
    typeof input.residenceCountryCode === "string"
      ? normalizeCountryCode(input.residenceCountryCode)
      : "";
  if (
    input.residenceCountryCode === undefined ||
    input.residenceCountryCode === null ||
    (typeof input.residenceCountryCode === "string" && countryCandidate === "")
  ) {
    issues.push({
      field: "residenceCountryCode",
      code: "required",
      message: "residenceCountryCode is required",
    });
  } else if (typeof input.residenceCountryCode !== "string") {
    issues.push({
      field: "residenceCountryCode",
      code: "invalid_type",
      message: "residenceCountryCode must be a string",
    });
  } else if (!isIsoCountryCode(countryCandidate)) {
    issues.push({
      field: "residenceCountryCode",
      code: "invalid_format",
      message: "residenceCountryCode must be an ISO 3166-1 alpha-2 code",
    });
  }

  const city = addTextIssue(issues, "residenceCity", input.residenceCity, true);

  const regionCandidate =
    typeof input.residenceRegion === "string"
      ? normalizeSubdivisionCode(input.residenceRegion)
      : null;
  const regionMissing = regionCandidate === null || regionCandidate === "";
  if (
    input.residenceRegion !== undefined &&
    input.residenceRegion !== null &&
    typeof input.residenceRegion !== "string"
  ) {
    issues.push({
      field: "residenceRegion",
      code: "invalid_type",
      message: "residenceRegion must be a string or null",
    });
  } else if (countryCandidate === "US" && regionMissing) {
    issues.push({
      field: "residenceRegion",
      code: "required",
      message: "residenceRegion is required for US residences",
    });
  } else if (
    !regionMissing &&
    !isIsoSubdivisionCode(regionCandidate, countryCandidate)
  ) {
    issues.push({
      field: "residenceRegion",
      code: "invalid_format",
      message: "residenceRegion must match the selected country",
    });
  }

  const employmentCandidate =
    typeof input.employmentStatus === "string"
      ? input.employmentStatus.trim().toLowerCase()
      : "";
  if (
    input.employmentStatus === undefined ||
    input.employmentStatus === null ||
    (typeof input.employmentStatus === "string" && employmentCandidate === "")
  ) {
    issues.push({
      field: "employmentStatus",
      code: "required",
      message: "employmentStatus is required",
    });
  } else if (typeof input.employmentStatus !== "string") {
    issues.push({
      field: "employmentStatus",
      code: "invalid_type",
      message: "employmentStatus must be a string",
    });
  } else if (!isEmploymentStatus(employmentCandidate)) {
    issues.push({
      field: "employmentStatus",
      code: "invalid_format",
      message: "employmentStatus is invalid",
    });
  }

  const requiresCompany = isEmploymentStatus(employmentCandidate)
    ? employmentRequiresCompany(employmentCandidate)
    : false;
  const submittedCompany = requiresCompany
    ? addTextIssue(issues, "company", input.company, true)
    : null;
  const company = requiresCompany ? submittedCompany : null;
  const occupation = addTextIssue(
    issues,
    "occupation",
    input.occupation,
    false,
  );

  if (
    issues.length > 0 ||
    !isIsoCountryCode(countryCandidate) ||
    !isEmploymentStatus(employmentCandidate) ||
    !isBirthYear(birthYear, now) ||
    city === null
  ) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      phone,
      birthYear,
      residenceCity: city,
      residenceRegion: regionMissing ? null : regionCandidate,
      residenceCountryCode: countryCandidate,
      employmentStatus: employmentCandidate,
      company,
      occupation,
    },
  };
}
