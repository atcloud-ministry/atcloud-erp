import { describe, expect, it } from "vitest";
import {
  alumniDisplayName,
  alumniGeneralLocation,
  buildAlumniProfileSearchProjection,
} from "../../../../src/services/alumni/AlumniProfileProjectionService";

describe("AlumniProfileProjectionService", () => {
  it("derives privacy-minimal display values with deterministic fallbacks", () => {
    expect(
      alumniDisplayName({ firstName: "Amy", lastName: "Chen", username: "amy" }),
    ).toBe("Amy Chen");
    expect(alumniDisplayName({ username: " alumni-user " })).toBe("alumni-user");
    expect(alumniDisplayName({})).toBe("Member");

    expect(
      alumniGeneralLocation({
        residenceCity: " Seattle ",
        residenceRegion: "US-WA",
        residenceCountryCode: "US",
      }),
    ).toBe("Seattle");
    expect(alumniGeneralLocation({ residenceRegion: "US-WA" })).toBe("US-WA");
    expect(alumniGeneralLocation({ residenceCountryCode: "US" })).toBe("US");
  });

  it("builds one normalized, accent-insensitive projection from all sources", () => {
    const projection = buildAlumniProfileSearchProjection({
      user: {
        firstName: "Élodie",
        lastName: "Nguyễn",
        company: "Café Cloud",
        occupation: "Product Manager",
        residenceCity: "Montréal",
        residenceRegion: "CA-QC",
        residenceCountryCode: "CA",
      },
      profile: {
        professionalHeadline: "AI Strategy",
        industry: "Technology",
        skills: ["Node.js", "NODE.JS", "Développement"],
        bio: "Directory biography is searchable.",
      },
      affiliations: [
        { programName: "EMBA", cohortLabel: "2026" },
        { programName: "Leadership", cohortLabel: "2026" },
      ],
    });

    expect(projection.displayNameKey).toBe("elodie nguyen");
    expect(projection.companyKey).toBe("cafe cloud");
    expect(projection.generalLocationKey).toBe("montreal");
    expect(projection.skillKeys).toEqual(["node js", "developpement"]);
    expect(projection.cohortKeys).toEqual([
      "emba",
      "2026",
      "emba 2026",
      "leadership",
      "leadership 2026",
    ]);
    expect(projection.searchText).toContain("emba");
    expect(projection.searchText).toContain("leadership");
    expect(projection.searchText).not.toContain("ca qc");
    expect(projection.searchText).not.toContain("directory biography is searchable");
  });

  it("caps skills and total search text without dropping affiliation keys", () => {
    const projection = buildAlumniProfileSearchProjection({
      user: { firstName: "A", lastName: "Member" },
      profile: {
        skills: Array.from({ length: 30 }, (_, index) => `Skill ${index}`),
        bio: "x".repeat(8_000),
      },
      affiliations: Array.from({ length: 70 }, (_, index) => ({
        programName: `Program ${index} ${"p".repeat(190)}`,
        cohortLabel: `Cohort ${index}`,
      })),
    });

    expect(projection.skillKeys).toHaveLength(20);
    expect(projection.cohortKeys).toHaveLength(140);
    expect(projection.cohortKeys).toContain("cohort 69");
    expect(Array.from(projection.searchText)).toHaveLength(4_000);
  });
});
