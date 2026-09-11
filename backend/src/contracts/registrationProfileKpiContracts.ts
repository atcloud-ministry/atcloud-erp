import {
  REGISTRATION_PROFILE_FIELDS,
  validateRegistrationProfile,
  type EmploymentStatus,
  type IsoCountryCode,
  type RegistrationProfileFields,
  type RegistrationProfileInput,
} from "@atcloud/shared-time/registration-profile";

export const REGISTRATION_KPI_MINIMUM_GROUP_SIZE = 5 as const;

export interface KpiDimensionDTO<TBucket> {
  buckets: TBucket[];
  suppressionApplied: boolean;
}

export interface BirthYearDecadeBucketDTO {
  startYear: number;
  endYear: number;
  count: number;
}

export interface ResidenceCountryBucketDTO {
  countryCode: IsoCountryCode;
  count: number;
}

export interface ResidenceRegionBucketDTO {
  countryCode: IsoCountryCode;
  regionCode: string;
  count: number;
}

export interface ResidenceCityBucketDTO {
  countryCode: IsoCountryCode;
  regionCode: string | null;
  city: string;
  count: number;
}

export interface EmploymentStatusBucketDTO {
  employmentStatus: EmploymentStatus;
  count: number;
}

export interface CompanyBucketDTO {
  company: string;
  count: number;
}

export interface OccupationBucketDTO {
  occupation: string;
  count: number;
}

export interface RegistrationProfileKpisDTO {
  minimumGroupSize: typeof REGISTRATION_KPI_MINIMUM_GROUP_SIZE;
  birthYearDecades: KpiDimensionDTO<BirthYearDecadeBucketDTO>;
  residenceCountries: KpiDimensionDTO<ResidenceCountryBucketDTO>;
  residenceRegions: KpiDimensionDTO<ResidenceRegionBucketDTO>;
  residenceCities: KpiDimensionDTO<ResidenceCityBucketDTO>;
  employmentStatuses: KpiDimensionDTO<EmploymentStatusBucketDTO>;
  companies: KpiDimensionDTO<CompanyBucketDTO>;
  occupations: KpiDimensionDTO<OccupationBucketDTO>;
}

export type RegistrationProfileKpiSource = RegistrationProfileInput & {
  isActive?: unknown;
  birthYearBsonType?: unknown;
};

type CountedBucket<TBucket> = {
  bucket: TBucket;
  count: number;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCountThenKey<TBucket>(
  key: (bucket: TBucket) => string,
): (left: CountedBucket<TBucket>, right: CountedBucket<TBucket>) => number {
  return (left, right) =>
    right.count - left.count || compareText(key(left.bucket), key(right.bucket));
}

function countBucket<TBucket>(
  counts: Map<string, CountedBucket<TBucket>>,
  key: string,
  bucket: TBucket,
): void {
  const existing = counts.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  counts.set(key, { bucket, count: 1 });
}

function publishDimension<TBucket>(
  counts: Map<string, CountedBucket<TBucket>>,
  compare: (
    left: CountedBucket<TBucket>,
    right: CountedBucket<TBucket>,
  ) => number,
): KpiDimensionDTO<TBucket & { count: number }> {
  const counted = [...counts.values()];
  return {
    buckets: counted
      .filter(({ count }) => count >= REGISTRATION_KPI_MINIMUM_GROUP_SIZE)
      .sort(compare)
      .map(({ bucket, count }) => ({ ...bucket, count })),
    suppressionApplied: counted.some(
      ({ count }) => count < REGISTRATION_KPI_MINIMUM_GROUP_SIZE,
    ),
  };
}

function isCanonicalStoredProfile(
  row: RegistrationProfileKpiSource,
  profile: RegistrationProfileFields,
): boolean {
  if (row.birthYearBsonType !== "int") return false;

  return REGISTRATION_PROFILE_FIELDS.every(
    (field) => row[field] === profile[field],
  );
}

/**
 * Builds a response-safe KPI DTO. Source rows and exact private values never
 * leave this boundary; only reportable aggregate buckets are returned.
 */
export function buildRegistrationProfileKpis(
  rows: readonly RegistrationProfileKpiSource[],
  now = new Date(),
): RegistrationProfileKpisDTO {
  const birthYearDecades = new Map<
    string,
    CountedBucket<Omit<BirthYearDecadeBucketDTO, "count">>
  >();
  const residenceCountries = new Map<
    string,
    CountedBucket<Omit<ResidenceCountryBucketDTO, "count">>
  >();
  const residenceRegions = new Map<
    string,
    CountedBucket<Omit<ResidenceRegionBucketDTO, "count">>
  >();
  const residenceCities = new Map<
    string,
    CountedBucket<Omit<ResidenceCityBucketDTO, "count">>
  >();
  const employmentStatuses = new Map<
    string,
    CountedBucket<Omit<EmploymentStatusBucketDTO, "count">>
  >();
  const companies = new Map<
    string,
    CountedBucket<Omit<CompanyBucketDTO, "count">>
  >();
  const occupations = new Map<
    string,
    CountedBucket<Omit<OccupationBucketDTO, "count">>
  >();

  for (const row of rows) {
    if (row.isActive !== true) continue;

    const validation = validateRegistrationProfile(row, now);
    if (!validation.success) continue;
    const profile = validation.value;
    if (!isCanonicalStoredProfile(row, profile)) continue;

    const startYear = Math.floor(profile.birthYear / 10) * 10;
    countBucket(birthYearDecades, String(startYear), {
      startYear,
      endYear: startYear + 9,
    });

    countBucket(residenceCountries, profile.residenceCountryCode, {
      countryCode: profile.residenceCountryCode,
    });

    if (profile.residenceRegion !== null) {
      countBucket(
        residenceRegions,
        JSON.stringify([
          profile.residenceCountryCode,
          profile.residenceRegion,
        ]),
        {
          countryCode: profile.residenceCountryCode,
          regionCode: profile.residenceRegion,
        },
      );
    }

    countBucket(
      residenceCities,
      JSON.stringify([
        profile.residenceCountryCode,
        profile.residenceRegion,
        profile.residenceCity,
      ]),
      {
        countryCode: profile.residenceCountryCode,
        regionCode: profile.residenceRegion,
        city: profile.residenceCity,
      },
    );

    countBucket(employmentStatuses, profile.employmentStatus, {
      employmentStatus: profile.employmentStatus,
    });

    if (profile.company !== null) {
      countBucket(companies, profile.company, { company: profile.company });
    }
    if (profile.occupation !== null) {
      countBucket(occupations, profile.occupation, {
        occupation: profile.occupation,
      });
    }
  }

  return {
    minimumGroupSize: REGISTRATION_KPI_MINIMUM_GROUP_SIZE,
    birthYearDecades: publishDimension(
      birthYearDecades,
      (left, right) => left.bucket.startYear - right.bucket.startYear,
    ),
    residenceCountries: publishDimension(
      residenceCountries,
      compareCountThenKey(({ countryCode }) => countryCode),
    ),
    residenceRegions: publishDimension(
      residenceRegions,
      compareCountThenKey(({ countryCode, regionCode }) =>
        JSON.stringify([countryCode, regionCode]),
      ),
    ),
    residenceCities: publishDimension(
      residenceCities,
      compareCountThenKey(({ countryCode, regionCode, city }) =>
        JSON.stringify([countryCode, regionCode, city]),
      ),
    ),
    employmentStatuses: publishDimension(
      employmentStatuses,
      compareCountThenKey(({ employmentStatus }) => employmentStatus),
    ),
    companies: publishDimension(
      companies,
      compareCountThenKey(({ company }) => company),
    ),
    occupations: publishDimension(
      occupations,
      compareCountThenKey(({ occupation }) => occupation),
    ),
  };
}
