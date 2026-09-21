import { describe, it, expect } from "vitest";
import {
  profileSchema,
  type ProfileFormData,
} from "../../schemas/profileSchema";

function baseValid(): ProfileFormData {
  return {
    username: "alice01",
    firstName: "Alice",
    lastName: "Lee",
    gender: "female",
    email: "alice@example.com",
    phoneCountryCode: "US",
    phone: "+14155552671",
    birthYear: 1990,
    residenceCountryCode: "US",
    residenceRegion: "US-CA",
    residenceCity: "San Francisco",
    employmentStatus: "employed",
    isAtCloudLeader: "No",
    roleInAtCloud: "",
    occupation: "Product Manager",
    company: "Example Corp",
    weeklyChurch: "",
    churchAddress: "",
  };
}

describe("profileSchema", () => {
  it("accepts a valid baseline profile with No @Cloud Co-worker", async () => {
    const value = await profileSchema.validate(baseValid());
    expect(value.username).toBe("alice01");
  });

  it("requires username, firstName, lastName, gender, and email", async () => {
    const invalid = {
      ...baseValid(),
      username: "",
      firstName: "",
      lastName: "",
      gender: "",
      email: "not-an-email",
    } as any;
    await expect(profileSchema.validate(invalid)).rejects.toThrow();
  });

  it("requires roleInAtCloud when isAtCloudLeader is Yes", async () => {
    const data = {
      ...baseValid(),
      isAtCloudLeader: "Yes" as const,
      roleInAtCloud: "",
    };
    await expect(profileSchema.validate(data)).rejects.toThrow(
      /Role in @Cloud is required/
    );
  });

  it("passes when isAtCloudLeader is Yes and roleInAtCloud is provided", async () => {
    const data = {
      ...baseValid(),
      isAtCloudLeader: "Yes" as const,
      roleInAtCloud: "Event Director",
    };
    const value = await profileSchema.validate(data);
    expect(value.roleInAtCloud).toBe("Event Director");
  });

  it("requires the registration-profile fields when an existing user saves", async () => {
    const data = {
      ...baseValid(),
      phone: "",
      birthYear: undefined,
      residenceCity: "",
      employmentStatus: "",
    } as unknown as ProfileFormData;

    await expect(
      profileSchema.validate(data, { abortEarly: false }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        "Phone is required",
        "Birth year is required",
        "City is required",
        "Select a valid employment status",
      ]),
    });
  });

  it("requires a US state and company for employed users", async () => {
    const data = {
      ...baseValid(),
      residenceRegion: "",
      company: "",
    };

    await expect(
      profileSchema.validate(data, { abortEarly: false }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        "State is required for US residents",
        "Company is required for this employment status",
      ]),
    });
  });

  it("accepts an optional region and clears company requirements for a retired user", async () => {
    const value = await profileSchema.validate({
      ...baseValid(),
      residenceCountryCode: "GB",
      residenceRegion: null,
      employmentStatus: "retired",
      company: null,
    });

    expect(value.residenceRegion).toBeNull();
    expect(value.company).toBeNull();
  });
});
