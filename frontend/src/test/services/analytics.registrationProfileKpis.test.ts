import { describe, expect, it } from "vitest";
import { decodeUserAnalytics } from "../../services/api/analytics.api";
import { createRegistrationProfileKpis } from "../fixtures/registrationProfileKpis";

function createUserAnalyticsPayload() {
  return {
    usersByRole: [],
    usersByAtCloudStatus: [],
    usersByChurch: [],
    registrationTrends: [],
    usersByOccupation: [],
    totalUsers: 25,
    activeUsers: 24,
    demographics: {
      roleStats: {
        total: 25,
        superAdmin: 1,
        administrators: 2,
        leaders: 3,
        guestExperts: 4,
        participants: 15,
        atCloudLeaders: 2,
      },
      churchAnalytics: {
        weeklyChurchStats: {},
        churchAddressStats: {},
        usersWithChurchInfo: 0,
        usersWithoutChurchInfo: 25,
        totalChurches: 0,
        totalChurchLocations: 0,
        churchParticipationRate: 0,
      },
      occupationAnalytics: {
        occupationStats: {},
        usersWithOccupation: 0,
        usersWithoutOccupation: 25,
        totalOccupationTypes: 0,
        topOccupations: [],
        occupationCompletionRate: 0,
      },
    },
    registrationProfileKpis: createRegistrationProfileKpis(),
  };
}

describe("registration profile KPI analytics contract", () => {
  it("decodes privacy-protected aggregate buckets", () => {
    const payload = createUserAnalyticsPayload();

    expect(
      decodeUserAnalytics(payload).registrationProfileKpis,
    ).toEqual(payload.registrationProfileKpis);
  });

  it("accepts the legacy response while frontend and backend roll out", () => {
    const payload = createUserAnalyticsPayload();
    const legacyPayload: Record<string, unknown> = { ...payload };
    delete legacyPayload.registrationProfileKpis;

    expect(
      decodeUserAnalytics(legacyPayload).registrationProfileKpis,
    ).toBeUndefined();
  });

  it.each(["phone", "birthYear"])(
    "rejects an unexpected private %s field",
    (privateField) => {
      const payload = createUserAnalyticsPayload();
      Object.assign(payload.registrationProfileKpis, {
        [privateField]: privateField === "phone" ? "+12065550123" : 1987,
      });

      expect(() => decodeUserAnalytics(payload)).toThrow(
        /data\.registrationProfileKpis/,
      );
    },
  );

  it("rejects a bucket below the approved privacy threshold", () => {
    const payload = createUserAnalyticsPayload();
    payload.registrationProfileKpis.companies.buckets[0].count = 4;

    expect(() => decodeUserAnalytics(payload)).toThrow(
      /companies\.buckets\[0\]\.count/,
    );
  });

  it("rejects invalid ISO country and subdivision codes", () => {
    const invalidCountry = createUserAnalyticsPayload();
    Object.assign(
      invalidCountry.registrationProfileKpis.residenceCountries.buckets[0],
      { countryCode: "ZZ" },
    );

    expect(() => decodeUserAnalytics(invalidCountry)).toThrow(
      /residenceCountries\.buckets\[0\]\.countryCode/,
    );

    const mismatchedRegion = createUserAnalyticsPayload();
    Object.assign(
      mismatchedRegion.registrationProfileKpis.residenceRegions.buckets[0],
      { regionCode: "CA-BC" },
    );

    expect(() => decodeUserAnalytics(mismatchedRegion)).toThrow(
      /residenceRegions\.buckets\[0\]\.regionCode/,
    );
  });

  it("rejects invalid employment status and decade buckets", () => {
    const invalidEmployment = createUserAnalyticsPayload();
    Object.assign(
      invalidEmployment.registrationProfileKpis.employmentStatuses
        .buckets[0],
      { employmentStatus: "contractor" },
    );

    expect(() => decodeUserAnalytics(invalidEmployment)).toThrow(
      /employmentStatuses\.buckets\[0\]\.employmentStatus/,
    );

    const invalidDecade = createUserAnalyticsPayload();
    invalidDecade.registrationProfileKpis.birthYearDecades.buckets[0].startYear =
      1987;

    expect(() => decodeUserAnalytics(invalidDecade)).toThrow(
      /birthYearDecades\.buckets\[0\]/,
    );
  });
});
