import { describe, expect, it } from "vitest";
import { registrationProfileFormSchema } from "../../schemas/common/registrationProfileSchema";

const validProfile = {
  phoneCountryCode: "US",
  phone: "(415) 555-2671",
  birthYear: 1990,
  residenceCountryCode: "US",
  residenceRegion: "US-CA",
  residenceCity: "San Francisco",
  employmentStatus: "employed",
  company: "Example Co",
  occupation: "Engineer",
};

describe("registrationProfileFormSchema", () => {
  it("accepts a complete profile and casts a four-digit birth year", async () => {
    const result = await registrationProfileFormSchema.validate({
      ...validProfile,
      birthYear: "1990",
    });

    expect(result.birthYear).toBe(1990);
  });

  it("requires an explicit phone country for a national number", async () => {
    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        phoneCountryCode: "",
      }),
    ).rejects.toThrow("Phone country is required");
  });

  it("requires a US state and validates it against the residence country", async () => {
    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        residenceRegion: "",
      }),
    ).rejects.toThrow("State is required for US residents");

    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        residenceRegion: "CA-ON",
      }),
    ).rejects.toThrow("matches the country of residence");
  });

  it("requires company only for employed and self-employed users", async () => {
    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        company: "",
      }),
    ).rejects.toThrow("Company is required");

    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        employmentStatus: "retired",
        company: "",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects future birth years and multiline display values", async () => {
    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        birthYear: new Date().getUTCFullYear() + 1,
      }),
    ).rejects.toThrow("cannot be in the future");

    await expect(
      registrationProfileFormSchema.validate({
        ...validProfile,
        residenceCity: "San\nFrancisco",
      }),
    ).rejects.toThrow("single line");
  });
});
