import { describe, expect, it } from "vitest";
import {
  COUNTRY_SELECT_OPTIONS,
  getRegistrationProfileIssueLabels,
  getRegistrationProfileIssues,
  getSubdivisionOptions,
  hasRegistrationProfileFieldChanges,
  inferPhoneCountry,
  isRegistrationProfileComplete,
  normalizePhoneToE164,
  prepareRegistrationProfileSubmission,
} from "../../utils/registrationProfile";

describe("registration profile form utilities", () => {
  it("provides display names while retaining ISO codes as option values", () => {
    expect(COUNTRY_SELECT_OPTIONS).toContainEqual({
      value: "US",
      label: "United States of America",
    });
    expect(getSubdivisionOptions("US")).toContainEqual({
      value: "US-CA",
      label: "California",
    });
  });

  it("normalizes a national phone number to E.164 with the selected country", () => {
    expect(normalizePhoneToE164("(415) 555-2671", "US")).toBe(
      "+14155552671",
    );
    expect(inferPhoneCountry("+14155552671")).toBe("US");
  });

  it("does not guess a country for a national phone number", () => {
    expect(normalizePhoneToE164("4155552671", "")).toBeNull();
  });

  it("detects profile completeness and only meaningful changes to the eight persisted fields", () => {
    const persisted = {
      phone: "+14155552671",
      birthYear: 1990,
      residenceCountryCode: "US",
      residenceRegion: "US-CA",
      residenceCity: "San Francisco",
      employmentStatus: "employed",
      company: "Example Co",
      occupation: null,
    };

    expect(isRegistrationProfileComplete(persisted)).toBe(true);
    expect(
      hasRegistrationProfileFieldChanges(
        { ...persisted, birthYear: "1990", occupation: "" },
        persisted,
      ),
    ).toBe(false);
    expect(
      hasRegistrationProfileFieldChanges(
        { ...persisted, residenceCity: "Seattle" },
        persisted,
      ),
    ).toBe(true);
    const formOnlyChange = { ...persisted, phoneCountryCode: "CA" };
    expect(
      hasRegistrationProfileFieldChanges(formOnlyChange, persisted),
    ).toBe(false);
  });

  it("returns de-duplicated human labels for fields that need attention", () => {
    const issues = getRegistrationProfileIssues({
      phone: "not-a-phone",
      birthYear: "",
      residenceCountryCode: "US",
      residenceRegion: "",
      residenceCity: "",
      employmentStatus: "employed",
      company: "",
      occupation: "",
    });

    expect(getRegistrationProfileIssueLabels(issues)).toEqual([
      "Phone",
      "Birth year",
      "City",
      "State / province / region",
      "Company or organization",
    ]);
  });

  it("returns the canonical eight-field payload and clears inapplicable values", () => {
    const result = prepareRegistrationProfileSubmission(
      {
        phoneCountryCode: "US",
        phone: "415 555 2671",
        birthYear: "1990",
        residenceCountryCode: "CA",
        residenceRegion: "",
        residenceCity: "  Montréal  ",
        employmentStatus: "student",
        company: "Must be cleared",
        occupation: "  Graduate   Student ",
      },
      new Date("2026-09-10T00:00:00.000Z"),
    );

    expect(result).toEqual({
      success: true,
      value: {
        phone: "+14155552671",
        birthYear: 1990,
        residenceCountryCode: "CA",
        residenceRegion: null,
        residenceCity: "Montréal",
        employmentStatus: "student",
        company: null,
        occupation: "Graduate Student",
      },
    });
  });

  it("rejects multiline display fields instead of silently folding lines", () => {
    const result = prepareRegistrationProfileSubmission({
      phoneCountryCode: "US",
      phone: "4155552671",
      birthYear: 1990,
      residenceCountryCode: "US",
      residenceRegion: "US-CA",
      residenceCity: "San\nFrancisco",
      employmentStatus: "employed",
      company: "Example Co",
      occupation: "Engineer",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          field: "residenceCity",
          code: "invalid_format",
        }),
      );
    }
  });
});
