import {
  E164_PHONE_PATTERN,
  EMPLOYMENT_STATUSES,
  REGISTRATION_PROFILE_FIELDS,
  employmentRequiresCompany,
  validateRegistrationProfile,
  type EmploymentStatus,
  type RegistrationProfileInput,
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
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (E164_PHONE_PATTERN.test(input)) return input;
  if (!input || !isSupportedPhoneCountry(countryCode)) return null;

  const parsed = parsePhoneNumberFromString(input, countryCode);
  return parsed && E164_PHONE_PATTERN.test(parsed.number) ? parsed.number : null;
}

export function inferPhoneCountry(value: unknown): CountryCode | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return parsePhoneNumberFromString(value.trim())?.country ?? null;
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
