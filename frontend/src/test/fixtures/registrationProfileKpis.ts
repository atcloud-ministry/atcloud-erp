import type { RegistrationProfileKpis } from "../../services/api/analytics.api";

export function createRegistrationProfileKpis(): RegistrationProfileKpis {
  return {
    minimumGroupSize: 5,
    birthYearDecades: {
      buckets: [{ startYear: 1980, endYear: 1989, count: 6 }],
      suppressionApplied: true,
    },
    residenceCountries: {
      buckets: [{ countryCode: "US", count: 12 }],
      suppressionApplied: false,
    },
    residenceRegions: {
      buckets: [{ countryCode: "US", regionCode: "US-WA", count: 7 }],
      suppressionApplied: true,
    },
    residenceCities: {
      buckets: [
        {
          countryCode: "US",
          regionCode: "US-WA",
          city: "Seattle",
          count: 7,
        },
      ],
      suppressionApplied: true,
    },
    employmentStatuses: {
      buckets: [
        { employmentStatus: "employed", count: 8 },
        { employmentStatus: "self_employed", count: 5 },
      ],
      suppressionApplied: false,
    },
    companies: {
      buckets: [{ company: "Contoso", count: 5 }],
      suppressionApplied: true,
    },
    occupations: {
      buckets: [{ occupation: "Software Engineer", count: 6 }],
      suppressionApplied: true,
    },
  };
}
