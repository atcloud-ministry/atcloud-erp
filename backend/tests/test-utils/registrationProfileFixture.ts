import type { RegistrationProfileFields } from "@atcloud/shared-time/registration-profile";

/** Canonical profile fields for tests whose focus is not registration-profile validation. */
export const TEST_REGISTRATION_PROFILE = Object.freeze({
  phone: "+12065550123",
  birthYear: 1990,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed" as const,
  company: "AtCloud Test",
  occupation: "Tester",
} satisfies RegistrationProfileFields);
