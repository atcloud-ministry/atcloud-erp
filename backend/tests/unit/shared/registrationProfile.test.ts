import { describe, expect, it } from "vitest";
import {
  ISO_COUNTRY_CODES,
  ISO_SUBDIVISION_CODES,
  codePointLength,
  isBirthYear,
  isE164Phone,
  isIsoCountryCode,
  isIsoSubdivisionCode,
  normalizeDisplayText,
  normalizeSearchText,
  validateRegistrationProfile,
} from "@atcloud/shared-time/registration-profile";

const NOW = new Date("2026-09-10T12:00:00.000Z");

const validInput = () => ({
  phone: "+12065550123",
  birthYear: 1988,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed",
  company: "Example Company",
  occupation: "Product Manager",
});

describe("registration profile shared contract", () => {
  it("contains the complete ISO 3166-1 alpha-2 country set", () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(249);
    expect(isIsoCountryCode("US")).toBe(true);
    expect(isIsoCountryCode("TW")).toBe(true);
    expect(isIsoCountryCode("ZZ")).toBe(false);
    expect(isIsoCountryCode("us")).toBe(false);
  });

  it("uses the complete ISO 3166-2 subdivision set", () => {
    expect(ISO_SUBDIVISION_CODES.length).toBeGreaterThan(5_000);
    expect(isIsoSubdivisionCode("CA-ON", "CA")).toBe(true);
    expect(isIsoSubdivisionCode("GB-ENG", "GB")).toBe(true);
    expect(isIsoSubdivisionCode("CA-ZZZ", "CA")).toBe(false);
    expect(isIsoSubdivisionCode("GB-ZZZ", "GB")).toBe(false);
  });

  it("validates canonical E.164 boundaries", () => {
    expect(isE164Phone("+12345678")).toBe(true);
    expect(isE164Phone("+123456789012345")).toBe(true);
    expect(isE164Phone("+1234567")).toBe(false);
    expect(isE164Phone("+1234567890123456")).toBe(false);
    expect(isE164Phone("+0123456789")).toBe(false);
    expect(isE164Phone("12065550123")).toBe(false);
  });

  it("validates birth year against the current UTC year", () => {
    expect(isBirthYear(1900, NOW)).toBe(true);
    expect(isBirthYear(2026, NOW)).toBe(true);
    expect(isBirthYear(1899, NOW)).toBe(false);
    expect(isBirthYear(2027, NOW)).toBe(false);
    expect(isBirthYear(2000.5, NOW)).toBe(false);
  });

  it("normalizes display text and search text deterministically", () => {
    const decomposed = "Jose\u0301\tSilva\nProduct—Manager";
    expect(normalizeDisplayText(decomposed)).toBe(
      "José Silva Product—Manager",
    );
    expect(normalizeSearchText(decomposed)).toBe(
      "jose silva product manager",
    );
    expect(normalizeSearchText(normalizeSearchText(decomposed))).toBe(
      "jose silva product manager",
    );
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(codePointLength("😀".repeat(100))).toBe(100);
  });

  it("normalizes a complete profile to canonical storage values", () => {
    const result = validateRegistrationProfile(
      {
        ...validInput(),
        phone: "  +12065550123  ",
        birthYear: "1988",
        residenceCity: "  San   José ",
        residenceRegion: " us-ca ",
        residenceCountryCode: " us ",
        employmentStatus: " EMPLOYED ",
        company: "  Acme   Corp ",
        occupation: " Software   Engineer ",
      },
      NOW,
    );

    expect(result).toEqual({
      success: true,
      value: {
        phone: "+12065550123",
        birthYear: 1988,
        residenceCity: "San José",
        residenceRegion: "US-CA",
        residenceCountryCode: "US",
        employmentStatus: "employed",
        company: "Acme Corp",
        occupation: "Software Engineer",
      },
    });
  });

  it("requires a recognized US subdivision for US residences", () => {
    const missing = validateRegistrationProfile(
      { ...validInput(), residenceRegion: null },
      NOW,
    );
    const unknown = validateRegistrationProfile(
      { ...validInput(), residenceRegion: "US-ZZ" },
      NOW,
    );

    expect(missing.success).toBe(false);
    expect(unknown.success).toBe(false);
    if (!missing.success) {
      expect(missing.issues).toContainEqual(
        expect.objectContaining({ field: "residenceRegion", code: "required" }),
      );
    }
    expect(isIsoSubdivisionCode("US-WA", "US")).toBe(true);
    expect(isIsoSubdivisionCode("CA-ON", "CA")).toBe(true);
    expect(isIsoSubdivisionCode("CA-ZZZ", "CA")).toBe(false);
    expect(isIsoSubdivisionCode("CA-ON", "US")).toBe(false);
  });

  it("allows an omitted region outside the US", () => {
    const result = validateRegistrationProfile(
      {
        ...validInput(),
        residenceCountryCode: "CA",
        residenceRegion: "",
      },
      NOW,
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.value.residenceRegion).toBeNull();
  });

  it("requires company only for employed and self-employed profiles", () => {
    for (const employmentStatus of ["employed", "self_employed"] as const) {
      const result = validateRegistrationProfile(
        { ...validInput(), employmentStatus, company: "" },
        NOW,
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ field: "company", code: "required" }),
        );
      }
    }

    const student = validateRegistrationProfile(
      {
        ...validInput(),
        employmentStatus: "student",
        company: "Discarded legacy value",
      },
      NOW,
    );
    expect(student.success).toBe(true);
    if (student.success) expect(student.value.company).toBeNull();
  });

  it("normalizes blank optional occupation to null", () => {
    const result = validateRegistrationProfile(
      { ...validInput(), occupation: "  " },
      NOW,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.occupation).toBeNull();
  });

  it("enforces the 100-code-point display limit", () => {
    const accepted = validateRegistrationProfile(
      { ...validInput(), residenceCity: "😀".repeat(100) },
      NOW,
    );
    const rejected = validateRegistrationProfile(
      { ...validInput(), residenceCity: "😀".repeat(101) },
      NOW,
    );

    expect(accepted.success).toBe(true);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.issues).toContainEqual(
        expect.objectContaining({ field: "residenceCity", code: "too_long" }),
      );
    }
  });

  it("rejects control characters in single-line display fields", () => {
    const result = validateRegistrationProfile(
      { ...validInput(), residenceCity: "San\nFrancisco" },
      NOW,
    );

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

  it("returns field-scoped issues for missing and malformed values", () => {
    const result = validateRegistrationProfile(
      {
        phone: 12065550123,
        birthYear: 2027,
        residenceCity: "",
        residenceRegion: 5,
        residenceCountryCode: "ZZ",
        employmentStatus: "contractor",
      },
      NOW,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(new Set(result.issues.map((issue) => issue.field))).toEqual(
        new Set([
          "phone",
          "birthYear",
          "residenceCity",
          "residenceRegion",
          "residenceCountryCode",
          "employmentStatus",
        ]),
      );
    }
  });

  it("classifies a nonnumeric birth year value as an invalid type", () => {
    const result = validateRegistrationProfile(
      { ...validInput(), birthYear: { year: 1988 } },
      NOW,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          field: "birthYear",
          code: "invalid_type",
        }),
      );
    }
  });
});
