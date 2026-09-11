import { describe, expect, it } from "vitest";
import { buildUserDemographics } from "../../../src/contracts/userAnalyticsContracts";

describe("buildUserDemographics", () => {
  it("publishes occupation groups at five while preserving completion totals", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => ({ occupation: "Engineer" })),
      ...Array.from({ length: 4 }, () => ({ occupation: "Designer" })),
      {},
    ];

    const result = buildUserDemographics(rows);

    expect(result.occupationAnalytics).toEqual({
      occupationStats: { Engineer: 5 },
      usersWithOccupation: 9,
      usersWithoutOccupation: 1,
      totalOccupationTypes: 1,
      topOccupations: [{ occupation: "Engineer", count: 5 }],
      occupationCompletionRate: 90,
    });
  });
});
