import request from "supertest";
import app from "../../src/app";
import User from "../../src/models/User";
import type { RegistrationProfileFields } from "@atcloud/shared-time/registration-profile";
import { TEST_REGISTRATION_PROFILE } from "./registrationProfileFixture";

type TestGender = "male" | "female";

export interface CreateTestUserOptions
  extends Partial<RegistrationProfileFields> {
  username?: string;
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  gender?: TestGender;
  isAtCloudLeader?: boolean;
  roleInAtCloud?: string;
  acceptTerms?: boolean;
  role?: string; // e.g. "Administrator" | "Super Admin" | etc.
  verified?: boolean;
}

export interface TestRegistrationPayload extends RegistrationProfileFields {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
  gender: TestGender;
  isAtCloudLeader: boolean;
  roleInAtCloud?: string;
  acceptTerms: boolean;
}

const uniqueId = () => Math.random().toString(36).slice(2, 8);

export function buildTestRegistrationPayload(
  opts: CreateTestUserOptions = {},
): TestRegistrationPayload {
  const password = opts.password ?? "TestPass123!";
  const isAtCloudLeader = opts.isAtCloudLeader ?? false;
  const residenceCountryCode =
    opts.residenceCountryCode ??
    TEST_REGISTRATION_PROFILE.residenceCountryCode;
  const residenceRegion =
    opts.residenceRegion !== undefined
      ? opts.residenceRegion
      : residenceCountryCode.toUpperCase() === "US"
        ? TEST_REGISTRATION_PROFILE.residenceRegion
        : null;
  const payload: TestRegistrationPayload = {
    ...TEST_REGISTRATION_PROFILE,
    username: opts.username ?? `user_${uniqueId()}`,
    email: opts.email ?? `${uniqueId()}@example.com`,
    password,
    confirmPassword: password,
    firstName: opts.firstName ?? "Test",
    lastName: opts.lastName ?? "User",
    gender: opts.gender ?? "male",
    isAtCloudLeader,
    acceptTerms: opts.acceptTerms ?? true,
    phone: opts.phone ?? TEST_REGISTRATION_PROFILE.phone,
    birthYear: opts.birthYear ?? TEST_REGISTRATION_PROFILE.birthYear,
    residenceCity:
      opts.residenceCity ?? TEST_REGISTRATION_PROFILE.residenceCity,
    residenceRegion,
    residenceCountryCode,
    employmentStatus:
      opts.employmentStatus ?? TEST_REGISTRATION_PROFILE.employmentStatus,
    company:
      opts.company === undefined ? TEST_REGISTRATION_PROFILE.company : opts.company,
    occupation:
      opts.occupation === undefined
        ? TEST_REGISTRATION_PROFILE.occupation
        : opts.occupation,
  };

  if (isAtCloudLeader || opts.roleInAtCloud) {
    payload.roleInAtCloud = opts.roleInAtCloud ?? "Test Co-worker";
  }

  return payload;
}

/**
 * Registers a user via API (ensuring all middleware flows) then optionally elevates role & verification.
 * Returns the issued access token.
 */
export async function createAndLoginTestUser(opts: CreateTestUserOptions = {}) {
  const { role, verified = true } = opts;
  const base = buildTestRegistrationPayload(opts);

  await request(app).post("/api/auth/register").send(base).expect(201);

  // Elevate role & verify if needed
  if (verified || role) {
    await User.findOneAndUpdate(
      { email: base.email },
      {
        ...(verified ? { isVerified: true } : {}),
        ...(role ? { role } : {}),
      }
    );
  }

  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: base.email, password: base.password })
    .expect(200);

  // Get user ID from database
  const user = await User.findOne({ email: base.email });

  return {
    token: loginRes.body.data.accessToken as string,
    email: base.email,
    username: base.username,
    password: base.password,
    userId: user?._id.toString() || "",
    user,
    registrationPayload: base,
  };
}

export async function createAdminToken() {
  const { token } = await createAndLoginTestUser({ role: "Administrator" });
  return token;
}
