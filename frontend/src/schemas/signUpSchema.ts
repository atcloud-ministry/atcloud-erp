import * as yup from "yup";
import { passwordValidation } from "./common/passwordValidation";
import { registrationProfileFormSchemaFields } from "./common/registrationProfileSchema";

export const signUpSchema = yup.object({
  username: yup
    .string()
    .required("Username is required")
    .min(3, "Username must be at least 3 characters")
    .max(20, "Username must be less than 20 characters")
    .transform((v) => (typeof v === "string" ? v.toLowerCase().trim() : v))
    .test(
      "start-letter",
      "Username must start with a letter",
      (v) => !v || /^[a-z]/.test(v),
    )
    .matches(
      /^[a-z0-9_]+$/,
      "Username can only contain lowercase letters, numbers, and underscores",
    )
    .test(
      "no-double-underscore",
      "Username cannot contain consecutive underscores",
      (v) => !v || !/__/.test(v),
    )
    .test(
      "no-edge-underscore",
      "Username cannot start or end with an underscore",
      (v) => !v || !/^_|_$/.test(v),
    ),

  password: passwordValidation.password,

  confirmPassword: passwordValidation.confirmPassword("password"),

  firstName: yup.string().required("First name is required"),
  lastName: yup.string().required("Last name is required"),
  gender: yup
    .string()
    .required("Gender is required")
    .oneOf(["male", "female"], "Please select a valid gender"),
  email: yup
    .string()
    .email("Invalid email address")
    .required("Email is required"),
  ...registrationProfileFormSchemaFields,

  isAtCloudLeader: yup
    .string()
    .required("Please select if you are an @Cloud Co-worker"),
  roleInAtCloud: yup.string().when("isAtCloudLeader", {
    is: "true",
    then: (schema) => schema.required("Please describe your role in @Cloud"),
    otherwise: (schema) => schema.optional(),
  }),

  weeklyChurch: yup.string().optional(),
  churchAddress: yup.string().optional(),
});

export type SignUpFormData = yup.InferType<typeof signUpSchema>;
