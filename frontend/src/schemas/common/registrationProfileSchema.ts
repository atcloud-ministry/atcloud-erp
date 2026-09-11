import * as yup from "yup";
import {
  EMPLOYMENT_STATUSES,
  ISO_COUNTRY_CODES,
  MIN_BIRTH_YEAR,
  codePointLength,
  getCurrentUtcYear,
  isIsoSubdivisionCode,
  normalizeDisplayText,
} from "@atcloud/shared-time/registration-profile";
import {
  PHONE_COUNTRY_SELECT_OPTIONS,
  employmentStatusRequiresCompany,
  normalizePhoneToE164,
} from "../../utils/registrationProfile";

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const supportedPhoneCountries = PHONE_COUNTRY_SELECT_OPTIONS.map(
  ({ value }) => value,
);

function displayTextSchema() {
  return yup
    .string()
    .test(
      "single-line",
      "Use a single line without control characters",
      (value) => !value || !CONTROL_CHARACTER_PATTERN.test(value),
    )
    .test(
      "display-length",
      "Must be 100 characters or fewer",
      (value) =>
        !value || codePointLength(normalizeDisplayText(value)) <= 100,
    );
}

export const registrationProfileFormSchemaFields = {
  phoneCountryCode: yup
    .string()
    .required("Phone country is required")
    .test(
      "supported-phone-country",
      "Select a valid phone country",
      (value) => !value || supportedPhoneCountries.includes(value),
    ),
  phone: yup
    .string()
    .required("Phone is required")
    .test(
      "e164-phone",
      "Enter a valid phone number for the selected country",
      function validatePhone(value) {
        if (!value || !this.parent.phoneCountryCode) return true;
        return Boolean(
          normalizePhoneToE164(value, this.parent.phoneCountryCode),
        );
      },
    ),
  birthYear: yup
    .number()
    .transform((value, originalValue) =>
      originalValue === "" || originalValue === null ? undefined : value,
    )
    .typeError("Birth year must be a four-digit year")
    .integer("Birth year must be a whole year")
    .min(MIN_BIRTH_YEAR, `Birth year must be ${MIN_BIRTH_YEAR} or later`)
    .max(getCurrentUtcYear(), "Birth year cannot be in the future")
    .required("Birth year is required"),
  residenceCountryCode: yup
    .string()
    .required("Country of residence is required")
    .oneOf(
      ISO_COUNTRY_CODES as readonly string[],
      "Select a valid country of residence",
    ),
  residenceRegion: yup
    .string()
    .nullable()
    .when("residenceCountryCode", {
      is: "US",
      then: (schema) => schema.required("State is required for US residents"),
      otherwise: (schema) => schema.optional(),
    })
    .test(
      "region-country",
      "Select a region that matches the country of residence",
      function validateRegion(value) {
        if (!value) return true;
        return isIsoSubdivisionCode(
          value,
          this.parent.residenceCountryCode,
        );
      },
    ),
  residenceCity: displayTextSchema()
    .required("City is required")
    .test(
      "non-empty-city",
      "City is required",
      (value) => Boolean(value && normalizeDisplayText(value)),
    ),
  employmentStatus: yup
    .string()
    .required("Employment status is required")
    .oneOf(
      EMPLOYMENT_STATUSES as readonly string[],
      "Select a valid employment status",
    ),
  company: displayTextSchema()
    .nullable()
    .when("employmentStatus", {
      is: (value: unknown) => employmentStatusRequiresCompany(value),
      then: (schema) =>
        schema
          .required("Company is required for this employment status")
          .test(
            "non-empty-company",
            "Company is required for this employment status",
            (value) => Boolean(value && normalizeDisplayText(value)),
          ),
      otherwise: (schema) => schema.optional(),
    }),
  occupation: displayTextSchema().nullable().optional(),
} as const;

export const registrationProfileFormSchema = yup.object(
  registrationProfileFormSchemaFields,
);

export type RegistrationProfileFormValues = yup.InferType<
  typeof registrationProfileFormSchema
>;
