import { describe, expect, it } from "vitest";
import {
  buildRegistrationProfileKpis,
  REGISTRATION_KPI_MINIMUM_GROUP_SIZE,
  type RegistrationProfileKpiSource,
} from "../../../src/contracts/registrationProfileKpiContracts";
import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function profile(
  overrides: Partial<RegistrationProfileKpiSource> = {},
): RegistrationProfileKpiSource {
  return {
    ...TEST_REGISTRATION_PROFILE,
    isActive: true,
    birthYearBsonType: "int",
    ...overrides,
  };
}

function repeat(
  count: number,
  overrides: Partial<RegistrationProfileKpiSource> = {},
): RegistrationProfileKpiSource[] {
  return Array.from({ length: count }, () => profile(overrides));
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      keys.add(key);
      collectKeys(item, keys);
    });
  }
  return keys;
}

describe("buildRegistrationProfileKpis", () => {
  it("reports groups of five and suppresses groups of four", () => {
    const reportable = repeat(5, {
      birthYear: 1984,
      residenceCity: "Seattle",
      residenceRegion: "US-WA",
      residenceCountryCode: "US",
      employmentStatus: "employed",
      company: "Acme",
      occupation: "Engineer",
    });
    const suppressed = repeat(4, {
      birthYear: 1994,
      residenceCity: "Vancouver",
      residenceRegion: "CA-BC",
      residenceCountryCode: "CA",
      employmentStatus: "self_employed",
      company: "Small Studio",
      occupation: "Designer",
    });
    const invalidWouldReachFive = profile({
      ...suppressed[0],
      isActive: true,
      phone: "not-e164",
    });
    const inactiveWouldReachSix = profile({
      ...suppressed[0],
      isActive: false,
    });

    const result = buildRegistrationProfileKpis(
      [
        ...reportable,
        ...suppressed,
        invalidWouldReachFive,
        inactiveWouldReachSix,
      ],
      NOW,
    );

    expect(result.minimumGroupSize).toBe(
      REGISTRATION_KPI_MINIMUM_GROUP_SIZE,
    );
    expect(result.birthYearDecades).toEqual({
      buckets: [{ startYear: 1980, endYear: 1989, count: 5 }],
      suppressionApplied: true,
    });
    expect(result.residenceCountries).toEqual({
      buckets: [{ countryCode: "US", count: 5 }],
      suppressionApplied: true,
    });
    expect(result.residenceRegions).toEqual({
      buckets: [{ countryCode: "US", regionCode: "US-WA", count: 5 }],
      suppressionApplied: true,
    });
    expect(result.residenceCities).toEqual({
      buckets: [
        {
          countryCode: "US",
          regionCode: "US-WA",
          city: "Seattle",
          count: 5,
        },
      ],
      suppressionApplied: true,
    });
    expect(result.employmentStatuses).toEqual({
      buckets: [{ employmentStatus: "employed", count: 5 }],
      suppressionApplied: true,
    });
    expect(result.companies).toEqual({
      buckets: [{ company: "Acme", count: 5 }],
      suppressionApplied: true,
    });
    expect(result.occupations).toEqual({
      buckets: [{ occupation: "Engineer", count: 5 }],
      suppressionApplied: true,
    });

    const keys = collectKeys(result);
    expect(keys.has("phone")).toBe(false);
    expect(keys.has("birthYear")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("not-e164");
    expect(JSON.stringify(result)).not.toContain("1984");
    expect(JSON.stringify(result)).not.toContain("1994");
  });

  it("does not invent region, company, or occupation buckets", () => {
    const result = buildRegistrationProfileKpis(
      repeat(5, {
        birthYear: 2001,
        residenceCity: "London",
        residenceRegion: null,
        residenceCountryCode: "GB",
        employmentStatus: "student",
        company: null,
        occupation: null,
      }),
      NOW,
    );

    expect(result.birthYearDecades.buckets).toEqual([
      { startYear: 2000, endYear: 2009, count: 5 },
    ]);
    expect(result.residenceCountries.buckets).toEqual([
      { countryCode: "GB", count: 5 },
    ]);
    expect(result.residenceCities.buckets).toEqual([
      {
        countryCode: "GB",
        regionCode: null,
        city: "London",
        count: 5,
      },
    ]);
    expect(result.residenceRegions).toEqual({
      buckets: [],
      suppressionApplied: false,
    });
    expect(result.companies).toEqual({
      buckets: [],
      suppressionApplied: false,
    });
    expect(result.occupations).toEqual({
      buckets: [],
      suppressionApplied: false,
    });
  });

  it.each([
    ["string birth year", { birthYear: "1990", birthYearBsonType: "string" }],
    ["non-Int32 birth year", { birthYear: 1990, birthYearBsonType: "double" }],
    ["unnormalized phone", { phone: " +12065550123 " }],
    ["unnormalized city", { residenceCity: " Seattle " }],
    ["unnormalized country", { residenceCountryCode: "us" }],
    ["unnormalized region", { residenceRegion: "us-wa" }],
    ["unnormalized employment", { employmentStatus: " employed " }],
    ["unnormalized company", { company: " AtCloud Test " }],
    ["unnormalized occupation", { occupation: " Tester " }],
  ] as const)("excludes a %s row from the five-person threshold", (_, dirty) => {
    const result = buildRegistrationProfileKpis(
      [...repeat(4), profile(dirty as Partial<RegistrationProfileKpiSource>)],
      NOW,
    );

    for (const distribution of [
      result.birthYearDecades,
      result.residenceCountries,
      result.residenceRegions,
      result.residenceCities,
      result.employmentStatuses,
      result.companies,
      result.occupations,
    ]) {
      expect(distribution.buckets).toEqual([]);
    }
  });

  it("sorts reportable buckets deterministically", () => {
    const result = buildRegistrationProfileKpis(
      [
        ...repeat(6, {
          birthYear: 1995,
          residenceCity: "Toronto",
          residenceRegion: "CA-ON",
          residenceCountryCode: "CA",
          company: "Zulu Corp",
          occupation: "Writer",
        }),
        ...repeat(6, {
          birthYear: 1975,
          residenceCity: "London",
          residenceRegion: null,
          residenceCountryCode: "GB",
          company: "Alpha Corp",
          occupation: "Analyst",
        }),
        ...repeat(7, {
          birthYear: 1985,
          residenceCity: "Seattle",
          residenceRegion: "US-WA",
          residenceCountryCode: "US",
          company: "Middle Corp",
          occupation: "Manager",
        }),
      ],
      NOW,
    );

    expect(result.birthYearDecades.buckets.map(({ startYear }) => startYear)).toEqual([
      1970,
      1980,
      1990,
    ]);
    expect(result.residenceCountries.buckets.map(({ countryCode }) => countryCode)).toEqual([
      "US",
      "CA",
      "GB",
    ]);
    expect(result.companies.buckets.map(({ company }) => company)).toEqual([
      "Middle Corp",
      "Alpha Corp",
      "Zulu Corp",
    ]);
    expect(result.occupations.buckets.map(({ occupation }) => occupation)).toEqual([
      "Manager",
      "Analyst",
      "Writer",
    ]);
  });
});
