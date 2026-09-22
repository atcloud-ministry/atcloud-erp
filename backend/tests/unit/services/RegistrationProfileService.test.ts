import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistrationProfileFields } from "@atcloud/shared-time/registration-profile";
import { User } from "../../../src/models";
import {
  REGISTRATION_PROFILE_READ_PROJECTION,
  RegistrationProfileNotReadyError,
  RegistrationProfileUserNotFoundError,
  applyCanonicalRegistrationProfile,
  assertRegistrationProfileReadyForAlumniPublish,
  assertRegistrationProfileReadyForAlumniPublishByUserId,
  containsRegistrationProfileUpdate,
  getRegistrationProfileReadiness,
  getRegistrationProfileReadinessByUserId,
  validateMergedRegistrationProfile,
} from "../../../src/services/RegistrationProfileService";

const COMPLETE_PROFILE = {
  phone: "+12065550123",
  birthYear: 1990,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed" as const,
  company: "Example Company",
  occupation: "Engineer",
} satisfies RegistrationProfileFields;

describe("RegistrationProfileService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges a partial edit with persisted values and canonicalizes it", () => {
    const result = validateMergedRegistrationProfile(COMPLETE_PROFILE, {
      residenceCity: " San   José ",
      residenceCountryCode: "ca",
      residenceRegion: "ca-on",
    });

    expect(result).toEqual({
      success: true,
      value: {
        ...COMPLETE_PROFILE,
        residenceCity: "San José",
        residenceCountryCode: "CA",
        residenceRegion: "CA-ON",
      },
    });
  });

  it("detects only deliberate registration-profile edits", () => {
    expect(containsRegistrationProfileUpdate({ homeAddress: "Legacy" })).toBe(
      false,
    );
    expect(containsRegistrationProfileUpdate({ occupation: "Engineer" })).toBe(
      true,
    );
  });

  it("applies canonical values and clears the legacy address", () => {
    const target: Record<string, unknown> = { homeAddress: "Legacy" };
    applyCanonicalRegistrationProfile(target, COMPLETE_PROFILE);
    expect(target).toMatchObject(COMPLETE_PROFILE);
    expect(target.homeAddress).toBeUndefined();
  });

  it("reports readiness and provides a reusable Alumni publish guard", () => {
    expect(getRegistrationProfileReadiness(COMPLETE_PROFILE).ready).toBe(true);
    expect(() =>
      assertRegistrationProfileReadyForAlumniPublish(COMPLETE_PROFILE),
    ).not.toThrow();

    const incomplete = { ...COMPLETE_PROFILE, birthYear: undefined };
    const readiness = getRegistrationProfileReadiness(incomplete);
    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "birthYear", code: "required" }),
      ]),
    );
    expect(() =>
      assertRegistrationProfileReadyForAlumniPublish(incomplete),
    ).toThrow(RegistrationProfileNotReadyError);
  });

  it("reports an impossible stored number with a person-facing readiness issue", () => {
    const readiness = getRegistrationProfileReadiness({
      ...COMPLETE_PROFILE,
      phone: "+11234567890",
    });
    expect(readiness).toEqual({
      ready: false,
      issues: [
        {
          field: "phone",
          code: "invalid_format",
          message: "Enter a valid phone number, including its country code.",
        },
      ],
    });
  });

  it("loads every required field including hidden birthYear for publish readiness", async () => {
    const lean = vi.fn().mockResolvedValue(COMPLETE_PROFILE);
    const select = vi.fn().mockReturnValue({ lean });
    vi.spyOn(User, "findById").mockReturnValue({ select } as never);

    await expect(
      getRegistrationProfileReadinessByUserId("user-1"),
    ).resolves.toEqual({ ready: true, issues: [] });
    expect(select).toHaveBeenCalledWith(REGISTRATION_PROFILE_READ_PROJECTION);
    expect(REGISTRATION_PROFILE_READ_PROJECTION).toContain("+birthYear");
    for (const field of Object.keys(COMPLETE_PROFILE)) {
      expect(REGISTRATION_PROFILE_READ_PROJECTION).toContain(field);
    }
  });

  it("uses the storage-backed values when enforcing the publish guard", async () => {
    const lean = vi
      .fn()
      .mockResolvedValue({ ...COMPLETE_PROFILE, birthYear: undefined });
    const select = vi.fn().mockReturnValue({ lean });
    vi.spyOn(User, "findById").mockReturnValue({ select } as never);

    await expect(
      assertRegistrationProfileReadyForAlumniPublishByUserId("user-2"),
    ).rejects.toMatchObject({
      name: "RegistrationProfileNotReadyError",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "birthYear", code: "required" }),
      ]),
    });
  });

  it("distinguishes a missing user from an incomplete profile", async () => {
    const lean = vi.fn().mockResolvedValue(null);
    const select = vi.fn().mockReturnValue({ lean });
    vi.spyOn(User, "findById").mockReturnValue({ select } as never);

    await expect(
      getRegistrationProfileReadinessByUserId("missing-user"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RegistrationProfileUserNotFoundError>>({
        name: "RegistrationProfileUserNotFoundError",
        userId: "missing-user",
      }),
    );
  });
});
