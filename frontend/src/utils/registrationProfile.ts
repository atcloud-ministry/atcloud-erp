import {
  EMPLOYMENT_STATUSES,
  REGISTRATION_PROFILE_FIELDS,
  employmentRequiresCompany,
  normalizePhoneToE164 as normalizeSharedPhoneToE164,
  validateRegistrationProfile,
  type EmploymentStatus,
  type RegistrationProfileInput,
  type RegistrationProfileValidationIssue,
  type RegistrationProfileValidationResult,
} from "@atcloud/shared-time/registration-profile";
import {
  ISO_COUNTRY_OPTIONS,
  ISO_SUBDIVISION_OPTIONS,
} from "@atcloud/shared-time/registration-profile-options";
import {
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

export const COUNTRY_SELECT_OPTIONS = ISO_COUNTRY_OPTIONS.map(({ code, name }) => ({
  value: code,
  label: name,
}));

export const PHONE_COUNTRY_SELECT_OPTIONS = ISO_COUNTRY_OPTIONS.flatMap(
  ({ code, name }) => {
    if (!isSupportedCountry(code as CountryCode)) return [];
    return [
      {
        value: code,
        label: `${name} (+${getCountryCallingCode(code as CountryCode)})`,
      },
    ];
  },
);

export const EMPLOYMENT_STATUS_OPTIONS: readonly {
  value: EmploymentStatus;
  label: string;
}[] = [
  { value: "employed", label: "Employed" },
  { value: "self_employed", label: "Self-employed" },
  { value: "student", label: "Student" },
  { value: "not_currently_employed", label: "Not currently employed" },
  { value: "retired", label: "Retired" },
];

const subdivisionsByCountry = new Map<string, { value: string; label: string }[]>();

for (const { code, countryCode, name } of ISO_SUBDIVISION_OPTIONS) {
  const options = subdivisionsByCountry.get(countryCode) ?? [];
  options.push({ value: code, label: name });
  subdivisionsByCountry.set(countryCode, options);
}

export function getSubdivisionOptions(
  countryCode: string | null | undefined,
): readonly { value: string; label: string }[] {
  return countryCode ? (subdivisionsByCountry.get(countryCode) ?? []) : [];
}

export function isSupportedPhoneCountry(
  value: unknown,
): value is CountryCode {
  return typeof value === "string" && isSupportedCountry(value as CountryCode);
}

export function normalizePhoneToE164(
  value: unknown,
  countryCode: unknown,
): string | null {
  return normalizeSharedPhoneToE164(value, countryCode);
}

export function inferPhoneCountry(value: unknown): CountryCode | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return parsePhoneNumberFromString(value.trim())?.country ?? null;
}

export function getDefaultPhoneCountry(
  phone: unknown,
  residenceCountryCode?: unknown,
): CountryCode {
  const inferred = inferPhoneCountry(phone);
  if (inferred) return inferred;
  return isSupportedPhoneCountry(residenceCountryCode)
    ? residenceCountryCode
    : "US";
}

export interface RegistrationProfileFormInput extends RegistrationProfileInput {
  phoneCountryCode?: unknown;
}

export function prepareRegistrationProfileSubmission(
  input: RegistrationProfileFormInput,
  now = new Date(),
): RegistrationProfileValidationResult {
  const normalizedPhone = normalizePhoneToE164(
    input.phone,
    input.phoneCountryCode,
  );

  return validateRegistrationProfile(
    {
      phone: normalizedPhone ?? input.phone,
      birthYear: input.birthYear,
      residenceCity: input.residenceCity,
      residenceRegion: input.residenceRegion,
      residenceCountryCode: input.residenceCountryCode,
      employmentStatus: input.employmentStatus,
      company: input.company,
      occupation: input.occupation,
    },
    now,
  );
}

export function employmentStatusRequiresCompany(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (EMPLOYMENT_STATUSES as readonly string[]).includes(value) &&
    employmentRequiresCompany(value as EmploymentStatus)
  );
}

export function isRegistrationProfileComplete(
  input: RegistrationProfileInput,
  now = new Date(),
): boolean {
  return validateRegistrationProfile(input, now).success;
}

export const REGISTRATION_PROFILE_FIELD_LABELS = {
  phone: "Phone",
  birthYear: "Birth year",
  residenceCity: "City",
  residenceRegion: "State / province / region",
  residenceCountryCode: "Country of residence",
  employmentStatus: "Employment status",
  company: "Company or organization",
  occupation: "Occupation",
} as const satisfies Record<
  (typeof REGISTRATION_PROFILE_FIELDS)[number],
  string
>;

export function getRegistrationProfileIssues(
  input: RegistrationProfileInput,
  now = new Date(),
): RegistrationProfileValidationIssue[] {
  const result = validateRegistrationProfile(input, now);
  return result.success ? [] : result.issues;
}

export function getRegistrationProfileIssueLabels(
  issues: readonly RegistrationProfileValidationIssue[],
): string[] {
  return Array.from(
    new Set(
      issues.map((issue) => REGISTRATION_PROFILE_FIELD_LABELS[issue.field]),
    ),
  );
}

function comparableRegistrationValue(
  field: (typeof REGISTRATION_PROFILE_FIELDS)[number],
  value: unknown,
): string {
  if (value === undefined || value === null) return "";
  if (field === "birthYear") return String(value).trim();
  return typeof value === "string" ? value : String(value);
}

export function hasRegistrationProfileFieldChanges(
  current: RegistrationProfileInput,
  persisted: RegistrationProfileInput,
): boolean {
  return REGISTRATION_PROFILE_FIELDS.some(
    (field) =>
      comparableRegistrationValue(field, current[field]) !==
      comparableRegistrationValue(field, persisted[field]),
  );
}
