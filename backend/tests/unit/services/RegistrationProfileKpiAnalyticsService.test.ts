import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/models", () => ({
  User: {
    aggregate: vi.fn(),
  },
}));

import { User } from "../../../src/models";
import RegistrationProfileKpiAnalyticsService from "../../../src/services/RegistrationProfileKpiAnalyticsService";
import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";

describe("RegistrationProfileKpiAnalyticsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads only active users and only the fields needed to build KPIs", async () => {
    vi.mocked(User.aggregate).mockResolvedValue(
      Array.from({ length: 5 }, () => ({
        ...TEST_REGISTRATION_PROFILE,
        isActive: true,
        birthYearBsonType: "int",
      })),
    );

    const result =
      await RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis(
        new Date("2026-09-11T12:00:00.000Z"),
      );

    expect(User.aggregate).toHaveBeenCalledWith([
      { $match: { isActive: true } },
      {
        $project: {
          _id: 0,
          isActive: 1,
          phone: 1,
          birthYear: 1,
          birthYearBsonType: { $type: "$birthYear" },
          residenceCity: 1,
          residenceRegion: 1,
          residenceCountryCode: 1,
          employmentStatus: 1,
          company: 1,
          occupation: 1,
        },
      },
    ]);
    expect(result.birthYearDecades.buckets).toEqual([
      { startYear: 1990, endYear: 1999, count: 5 },
    ]);
  });
});
