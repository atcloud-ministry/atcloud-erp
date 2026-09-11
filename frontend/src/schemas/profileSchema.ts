import * as yup from "yup";
import { registrationProfileFormSchemaFields } from "./common/registrationProfileSchema";

const atCloudRoleSchema = yup.string().when("isAtCloudLeader", {
  is: (value: unknown) => value === "Yes" || value === true,
  then: (schema) =>
    schema.required(
      "Role in @Cloud is required when you are an @Cloud Co-worker",
    ),
  otherwise: (schema) => schema.optional(),
});

const identitySchemaFields = {
  username: yup
    .string()
    .required("Username is required")
    .min(3, "Username must be at least 3 characters"),
  firstName: yup.string().required("First name is required"),
  lastName: yup.string().required("Last name is required"),
  gender: yup
    .string()
    .required("Gender is required")
    .oneOf(["male", "female"], "Please select a valid gender"),
  email: yup.string().email("Invalid email").required("Email is required"),
} as const;

const registrationProfileDraftSchemaFields = {
  phoneCountryCode: yup.mixed().optional(),
  phone: yup.mixed().optional(),
  birthYear: yup.mixed().optional(),
  residenceCountryCode: yup.mixed().optional(),
  residenceRegion: yup.mixed().optional(),
  residenceCity: yup.mixed().optional(),
  employmentStatus: yup.mixed().optional(),
  company: yup.mixed().optional(),
  occupation: yup.mixed().optional(),
} as const;

const selfProfileFields = {
  roleInAtCloud: atCloudRoleSchema,
  isAtCloudLeader: yup
    .string()
    .required("Please specify if you are an @Cloud Co-worker")
    .oneOf(["Yes", "No"], "Please select Yes or No"),
  weeklyChurch: yup.string().optional(),
  churchAddress: yup.string().optional(),
} as const;

// Strict registration-profile validation is applied when a complete profile is
// saved or when an existing user deliberately edits one of the eight fields.
export const profileSchema = yup.object({
  ...identitySchemaFields,
  ...registrationProfileFormSchemaFields,
  ...selfProfileFields,
});

export type ProfileFormData = yup.InferType<typeof profileSchema>;

export const profileEditSchema = yup.object({
  ...identitySchemaFields,
  ...registrationProfileDraftSchemaFields,
  ...selfProfileFields,
});

export const adminProfileSchema = yup.object({
  ...registrationProfileFormSchemaFields,
  isAtCloudLeader: yup.boolean().required(),
  roleInAtCloud: atCloudRoleSchema,
});

export type AdminProfileFormData = yup.InferType<typeof adminProfileSchema>;

export const adminProfileEditSchema = yup.object({
  ...registrationProfileDraftSchemaFields,
  isAtCloudLeader: yup.boolean().required(),
  roleInAtCloud: atCloudRoleSchema,
});

export interface UserData extends ProfileFormData {
  id: string;
  avatar: string | null;
  systemAuthorizationLevel: string;
}
