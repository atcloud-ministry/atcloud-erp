import { BaseApiClient } from "./common";
import {
  MIN_BIRTH_YEAR,
  isEmploymentStatus,
  isIsoCountryCode,
  isIsoSubdivisionCode,
  type EmploymentStatus,
  type IsoCountryCode,
} from "@atcloud/shared-time/registration-profile";

/**
 * Overview Analytics Types
 */
export interface AnalyticsOverview {
  overview: {
    totalUsers: number;
    totalEvents: number;
    completedEvents: number;
    totalRegistrations: number;
    activeParticipants: number;
    averageSignupRate: number;
    activeUsers: number;
    upcomingEvents: number;
    recentRegistrations: number;
  };
  growth: {
    userGrowthRate: number;
    eventGrowthRate: number;
    registrationGrowthRate: number;
  };
  last30Days: {
    newUsers: number;
    newEvents: number;
    registrations: number;
    attendanceCompletionRate: number;
    attendanceRate: number;
  };
  needsAttention: {
    lowSignupUpcomingEvents: number;
    completedEventsMissingAttendance: number;
    unrecordedAttendance: number;
    waitlistedRegistrations: number;
  };
  topEvents: Array<{
    id: string;
    title: string;
    date?: string;
    type?: string;
    status?: string;
    registrations: number;
    totalSlots: number;
    signupRate: number;
  }>;
  topPrograms: Array<{
    id: string;
    title: string;
    programType?: string;
    registrations: number;
    events: number;
  }>;
  recentActivity: Array<{
    id: string;
    type: "registration";
    person: string;
    eventTitle: string;
    eventDate?: string;
    createdAt: string;
  }>;
}

/**
 * Program Analytics Types
 */
export interface ProgramTypeBreakdown {
  programType: string;
  revenue: number; // in cents
  purchases: number;
  uniqueBuyers: number;
}

export interface ProgramAnalytics {
  totalRevenue: number; // in cents
  totalPurchases: number;
  uniqueBuyers: number;
  avgProgramPrice: number; // in cents
  classRepPurchases: number;
  classRepRevenue: number; // in cents
  classRepRate: number; // percentage
  promoCodePurchases: number;
  promoCodeUsageRate: number; // percentage
  earlyBirdPurchases: number;
  earlyBirdRate: number; // percentage
  pendingPurchases: number;
  pendingRevenue: number; // in cents
  failedPurchases: number;
  failedRevenue: number; // in cents
  refundedPurchases: number;
  refundedRevenue: number; // in cents
  last30Days: {
    revenue: number; // in cents
    purchases: number;
  };
  programTypeBreakdown: ProgramTypeBreakdown[];
}

/**
 * Financial Summary Types
 */
export interface FinancialSummary {
  totalRevenue: number; // in cents
  totalTransactions: number;
  uniqueParticipants: number;
  growthRate: number; // percentage
  last30Days: {
    revenue: number; // in cents
    transactions: number;
    percentage: number; // percentage of all-time
  };
  programs: {
    revenue: number; // in cents
    purchases: number;
    uniqueBuyers: number;
    last30Days: {
      revenue: number; // in cents
      purchases: number;
    };
  };
  donations: {
    revenue: number; // in cents
    gifts: number;
    uniqueDonors: number;
    last30Days: {
      revenue: number; // in cents
      donations: number;
    };
  };
}

/**
 * Donation Analytics Types
 */
export interface FrequencyBreakdown {
  frequency: string;
  count: number;
  monthlyValue: number; // in cents
}

export interface DonationAnalytics {
  totalRevenue: number; // in cents
  totalGifts: number;
  uniqueDonors: number;
  avgGiftsPerDonor: number;
  retentionRate: number; // percentage
  oneTime: {
    gifts: number;
    revenue: number; // in cents
    avgGiftSize: number; // in cents
  };
  recurring: {
    gifts: number;
    revenue: number; // in cents
    avgGiftSize: number; // in cents
    activeDonations: number;
    activeRecurringRevenue: number; // in cents - monthly equivalent
    onHoldDonations: number;
    scheduledDonations: number;
    frequencyBreakdown: FrequencyBreakdown[];
  };
}

/**
 * Trends Analytics Types
 */
export interface TrendsData {
  period: string; // "6months", "12months", "all", "custom"
  startDate: string; // ISO date
  endDate: string; // ISO date
  labels: string[]; // Month labels: ["Jan 2024", "Feb 2024", ...]
  programRevenue: number[]; // Revenue in cents for each month
  donationRevenue: number[]; // Revenue in cents for each month
  combinedRevenue: number[]; // Combined revenue in cents for each month
}

/**
 * Attendance Analytics Types
 */
export interface AttendanceCounts {
  registered: number;
  attended: number;
  absent: number;
  unrecorded: number;
  recorded: number;
  attendanceRate: number;
  noShowRate: number;
  completionRate: number;
}

export interface AttendancePersonAnalytics extends AttendanceCounts {
  userId: string;
  name: string;
  roleInAtCloud: string;
  systemAuthorizationLevel: string;
  programs: string[];
  completedEvents: number;
  lastAttendedAt?: string;
  lastAttendedEvent?: string;
}

export interface AttendanceProgramAnalytics extends AttendanceCounts {
  programId: string;
  programTitle: string;
  programType: string;
  completedEvents: number;
}

export interface AttendanceProgramRef {
  id: string;
  title: string;
  programType?: string;
}

export interface AttendanceEventAnalytics extends AttendanceCounts {
  eventId: string;
  eventTitle: string;
  eventDate: string;
  eventType: string;
  programs: AttendanceProgramRef[];
}

export interface AttendanceAnalytics {
  summary: AttendanceCounts;
  byPerson: AttendancePersonAnalytics[];
  byProgram: AttendanceProgramAnalytics[];
  byEvent: AttendanceEventAnalytics[];
}

export interface UserAnalyticsDemographics {
  roleStats: {
    total: number;
    superAdmin: number;
    administrators: number;
    leaders: number;
    guestExperts: number;
    participants: number;
    atCloudLeaders: number;
  };
  churchAnalytics: {
    weeklyChurchStats: Record<string, number>;
    churchAddressStats: Record<string, number>;
    usersWithChurchInfo: number;
    usersWithoutChurchInfo: number;
    totalChurches: number;
    totalChurchLocations: number;
    churchParticipationRate: number;
  };
  occupationAnalytics: {
    occupationStats: Record<string, number>;
    usersWithOccupation: number;
    usersWithoutOccupation: number;
    totalOccupationTypes: number;
    topOccupations: Array<{ occupation: string; count: number }>;
    occupationCompletionRate: number;
  };
}

export interface PrivacyProtectedDistribution<TBucket> {
  buckets: TBucket[];
  suppressionApplied: boolean;
}

export interface BirthYearDecadeKpiBucket {
  startYear: number;
  endYear: number;
  count: number;
}

export interface ResidenceCountryKpiBucket {
  countryCode: IsoCountryCode;
  count: number;
}

export interface ResidenceRegionKpiBucket {
  countryCode: IsoCountryCode;
  regionCode: string;
  count: number;
}

export interface ResidenceCityKpiBucket {
  countryCode: IsoCountryCode;
  regionCode: string | null;
  city: string;
  count: number;
}

export interface EmploymentStatusKpiBucket {
  employmentStatus: EmploymentStatus;
  count: number;
}

export interface CompanyKpiBucket {
  company: string;
  count: number;
}

export interface OccupationKpiBucket {
  occupation: string;
  count: number;
}

export interface RegistrationProfileKpis {
  minimumGroupSize: 5;
  birthYearDecades: PrivacyProtectedDistribution<BirthYearDecadeKpiBucket>;
  residenceCountries: PrivacyProtectedDistribution<ResidenceCountryKpiBucket>;
  residenceRegions: PrivacyProtectedDistribution<ResidenceRegionKpiBucket>;
  residenceCities: PrivacyProtectedDistribution<ResidenceCityKpiBucket>;
  employmentStatuses: PrivacyProtectedDistribution<EmploymentStatusKpiBucket>;
  companies: PrivacyProtectedDistribution<CompanyKpiBucket>;
  occupations: PrivacyProtectedDistribution<OccupationKpiBucket>;
}

export interface UserAnalytics {
  usersByRole: Array<{ _id: string; count: number }>;
  usersByAtCloudStatus: Array<{ _id: boolean | null; count: number }>;
  usersByChurch: Array<{ _id: string; count: number }>;
  registrationTrends: Array<{
    _id: { year: number; month: number };
    count: number;
  }>;
  usersByOccupation: Array<{ _id: string; count: number }>;
  totalUsers: number;
  activeUsers: number;
  demographics: UserAnalyticsDemographics;
  /** Optional while the independently deployed frontend/backend roll out. */
  registrationProfileKpis?: RegistrationProfileKpis;
}

type JsonObject = Record<string, unknown>;

const analyticsContractError = (path: string, expected: string): never => {
  throw new Error(`Invalid API response at ${path}: expected ${expected}`);
};

const analyticsObject = (value: unknown, path: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return analyticsContractError(path, "object");
  }
  return value as JsonObject;
};

const exactAnalyticsObject = (
  value: unknown,
  path: string,
  keys: readonly string[],
): JsonObject => {
  const object = analyticsObject(value, path);
  const allowed = new Set(keys);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    return analyticsContractError(path, `only keys ${keys.join(", ")}`);
  }
  return object;
};

const analyticsNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return analyticsContractError(path, "finite number");
  }
  return value;
};

const analyticsString = (value: unknown, path: string): string => {
  if (typeof value !== "string") return analyticsContractError(path, "string");
  return value;
};

const analyticsBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    return analyticsContractError(path, "boolean");
  }
  return value;
};

const analyticsInteger = (value: unknown, path: string): number => {
  const number = analyticsNumber(value, path);
  if (!Number.isInteger(number)) {
    return analyticsContractError(path, "integer");
  }
  return number;
};

const analyticsNonEmptyString = (value: unknown, path: string): string => {
  const string = analyticsString(value, path);
  if (!string.trim()) {
    return analyticsContractError(path, "non-empty string");
  }
  return string;
};

const analyticsCountryCode = (
  value: unknown,
  path: string,
): IsoCountryCode => {
  if (!isIsoCountryCode(value)) {
    return analyticsContractError(path, "ISO 3166-1 alpha-2 country code");
  }
  return value;
};

const privacyProtectedDistribution = <TBucket>(
  value: unknown,
  path: string,
  minimumGroupSize: number,
  decodeBucket: (value: unknown, path: string) => TBucket,
): PrivacyProtectedDistribution<TBucket> => {
  const distribution = exactAnalyticsObject(value, path, [
    "buckets",
    "suppressionApplied",
  ]);
  if (!Array.isArray(distribution.buckets)) {
    return analyticsContractError(`${path}.buckets`, "array");
  }

  const buckets = distribution.buckets.map((bucket, index) =>
    decodeBucket(bucket, `${path}.buckets[${index}]`),
  );
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index] as { count?: unknown };
    const count = analyticsInteger(
      bucket.count,
      `${path}.buckets[${index}].count`,
    );
    if (count < minimumGroupSize) {
      return analyticsContractError(
        `${path}.buckets[${index}].count`,
        `integer greater than or equal to ${minimumGroupSize}`,
      );
    }
  }

  return {
    buckets,
    suppressionApplied: analyticsBoolean(
      distribution.suppressionApplied,
      `${path}.suppressionApplied`,
    ),
  };
};

function decodeRegistrationProfileKpis(
  value: unknown,
  path: string,
): RegistrationProfileKpis {
  const data = exactAnalyticsObject(value, path, [
    "minimumGroupSize",
    "birthYearDecades",
    "residenceCountries",
    "residenceRegions",
    "residenceCities",
    "employmentStatuses",
    "companies",
    "occupations",
  ]);
  const minimumGroupSize = analyticsInteger(
    data.minimumGroupSize,
    `${path}.minimumGroupSize`,
  );
  if (minimumGroupSize !== 5) {
    return analyticsContractError(`${path}.minimumGroupSize`, "5");
  }

  return {
    minimumGroupSize,
    birthYearDecades: privacyProtectedDistribution(
      data.birthYearDecades,
      `${path}.birthYearDecades`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "startYear",
          "endYear",
          "count",
        ]);
        const startYear = analyticsInteger(
          bucket.startYear,
          `${bucketPath}.startYear`,
        );
        const endYear = analyticsInteger(
          bucket.endYear,
          `${bucketPath}.endYear`,
        );
        if (
          startYear < MIN_BIRTH_YEAR ||
          startYear % 10 !== 0 ||
          endYear !== startYear + 9
        ) {
          return analyticsContractError(
            bucketPath,
            "valid ten-year birth-year bucket",
          );
        }
        return {
          startYear,
          endYear,
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
    residenceCountries: privacyProtectedDistribution(
      data.residenceCountries,
      `${path}.residenceCountries`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "countryCode",
          "count",
        ]);
        return {
          countryCode: analyticsCountryCode(
            bucket.countryCode,
            `${bucketPath}.countryCode`,
          ),
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
    residenceRegions: privacyProtectedDistribution(
      data.residenceRegions,
      `${path}.residenceRegions`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "countryCode",
          "regionCode",
          "count",
        ]);
        const countryCode = analyticsCountryCode(
          bucket.countryCode,
          `${bucketPath}.countryCode`,
        );
        if (!isIsoSubdivisionCode(bucket.regionCode, countryCode)) {
          return analyticsContractError(
            `${bucketPath}.regionCode`,
            "ISO 3166-2 code matching countryCode",
          );
        }
        return {
          countryCode,
          regionCode: bucket.regionCode,
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
    residenceCities: privacyProtectedDistribution(
      data.residenceCities,
      `${path}.residenceCities`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "countryCode",
          "regionCode",
          "city",
          "count",
        ]);
        const countryCode = analyticsCountryCode(
          bucket.countryCode,
          `${bucketPath}.countryCode`,
        );
        const regionCode = bucket.regionCode;
        if (
          regionCode !== null &&
          !isIsoSubdivisionCode(regionCode, countryCode)
        ) {
          return analyticsContractError(
            `${bucketPath}.regionCode`,
            "null or ISO 3166-2 code matching countryCode",
          );
        }
        return {
          countryCode,
          regionCode,
          city: analyticsNonEmptyString(bucket.city, `${bucketPath}.city`),
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
    employmentStatuses: privacyProtectedDistribution(
      data.employmentStatuses,
      `${path}.employmentStatuses`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "employmentStatus",
          "count",
        ]);
        if (!isEmploymentStatus(bucket.employmentStatus)) {
          return analyticsContractError(
            `${bucketPath}.employmentStatus`,
            "employment status",
          );
        }
        return {
          employmentStatus: bucket.employmentStatus,
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
    companies: privacyProtectedDistribution(
      data.companies,
      `${path}.companies`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "company",
          "count",
        ]);
        return {
          company: analyticsNonEmptyString(
            bucket.company,
            `${bucketPath}.company`,
          ),
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
    occupations: privacyProtectedDistribution(
      data.occupations,
      `${path}.occupations`,
      minimumGroupSize,
      (value, bucketPath) => {
        const bucket = exactAnalyticsObject(value, bucketPath, [
          "occupation",
          "count",
        ]);
        return {
          occupation: analyticsNonEmptyString(
            bucket.occupation,
            `${bucketPath}.occupation`,
          ),
          count: analyticsInteger(bucket.count, `${bucketPath}.count`),
        };
      },
    ),
  };
}

const countRecord = (value: unknown, path: string): Record<string, number> => {
  const object = analyticsObject(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, count]) => [
      key,
      analyticsNumber(count, `${path}.${key}`),
    ]),
  );
};

const countBuckets = <T>(
  value: unknown,
  path: string,
  decodeId: (id: unknown, path: string) => T,
): Array<{ _id: T; count: number }> => {
  if (!Array.isArray(value)) return analyticsContractError(path, "array");
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const bucket = exactAnalyticsObject(item, itemPath, ["_id", "count"]);
    return {
      _id: decodeId(bucket._id, `${itemPath}._id`),
      count: analyticsNumber(bucket.count, `${itemPath}.count`),
    };
  });
};

export function decodeUserAnalytics(value: unknown): UserAnalytics {
  const data = exactAnalyticsObject(value, "data", [
    "usersByRole",
    "usersByAtCloudStatus",
    "usersByChurch",
    "registrationTrends",
    "usersByOccupation",
    "totalUsers",
    "activeUsers",
    "demographics",
    "registrationProfileKpis",
  ]);
  const demographics = exactAnalyticsObject(data.demographics, "data.demographics", [
    "roleStats",
    "churchAnalytics",
    "occupationAnalytics",
  ]);
  const roleStats = exactAnalyticsObject(demographics.roleStats, "data.demographics.roleStats", [
    "total",
    "superAdmin",
    "administrators",
    "leaders",
    "guestExperts",
    "participants",
    "atCloudLeaders",
  ]);
  const church = exactAnalyticsObject(demographics.churchAnalytics, "data.demographics.churchAnalytics", [
    "weeklyChurchStats",
    "churchAddressStats",
    "usersWithChurchInfo",
    "usersWithoutChurchInfo",
    "totalChurches",
    "totalChurchLocations",
    "churchParticipationRate",
  ]);
  const occupation = exactAnalyticsObject(demographics.occupationAnalytics, "data.demographics.occupationAnalytics", [
    "occupationStats",
    "usersWithOccupation",
    "usersWithoutOccupation",
    "totalOccupationTypes",
    "topOccupations",
    "occupationCompletionRate",
  ]);
  if (!Array.isArray(occupation.topOccupations)) {
    return analyticsContractError("data.demographics.occupationAnalytics.topOccupations", "array");
  }
  const registrationProfileKpis =
    data.registrationProfileKpis === undefined
      ? undefined
      : decodeRegistrationProfileKpis(
          data.registrationProfileKpis,
          "data.registrationProfileKpis",
        );

  return {
    usersByRole: countBuckets(data.usersByRole, "data.usersByRole", analyticsString),
    usersByAtCloudStatus: countBuckets(
      data.usersByAtCloudStatus,
      "data.usersByAtCloudStatus",
      (id, path) => {
        if (id === null || typeof id === "boolean") return id;
        return analyticsContractError(path, "boolean or null");
      },
    ),
    usersByChurch: countBuckets(data.usersByChurch, "data.usersByChurch", analyticsString),
    registrationTrends: data.registrationTrends instanceof Array
      ? data.registrationTrends.map((item, index) => {
          const itemPath = `data.registrationTrends[${index}]`;
          const row = exactAnalyticsObject(item, itemPath, ["_id", "count"]);
          const id = exactAnalyticsObject(row._id, `${itemPath}._id`, ["year", "month"]);
          return {
            _id: {
              year: analyticsNumber(id.year, `${itemPath}._id.year`),
              month: analyticsNumber(id.month, `${itemPath}._id.month`),
            },
            count: analyticsNumber(row.count, `${itemPath}.count`),
          };
        })
      : analyticsContractError("data.registrationTrends", "array"),
    usersByOccupation: countBuckets(
      data.usersByOccupation,
      "data.usersByOccupation",
      analyticsString,
    ),
    totalUsers: analyticsNumber(data.totalUsers, "data.totalUsers"),
    activeUsers: analyticsNumber(data.activeUsers, "data.activeUsers"),
    demographics: {
      roleStats: {
        total: analyticsNumber(roleStats.total, "data.demographics.roleStats.total"),
        superAdmin: analyticsNumber(roleStats.superAdmin, "data.demographics.roleStats.superAdmin"),
        administrators: analyticsNumber(roleStats.administrators, "data.demographics.roleStats.administrators"),
        leaders: analyticsNumber(roleStats.leaders, "data.demographics.roleStats.leaders"),
        guestExperts: analyticsNumber(roleStats.guestExperts, "data.demographics.roleStats.guestExperts"),
        participants: analyticsNumber(roleStats.participants, "data.demographics.roleStats.participants"),
        atCloudLeaders: analyticsNumber(roleStats.atCloudLeaders, "data.demographics.roleStats.atCloudLeaders"),
      },
      churchAnalytics: {
        weeklyChurchStats: countRecord(church.weeklyChurchStats, "data.demographics.churchAnalytics.weeklyChurchStats"),
        churchAddressStats: countRecord(church.churchAddressStats, "data.demographics.churchAnalytics.churchAddressStats"),
        usersWithChurchInfo: analyticsNumber(church.usersWithChurchInfo, "data.demographics.churchAnalytics.usersWithChurchInfo"),
        usersWithoutChurchInfo: analyticsNumber(church.usersWithoutChurchInfo, "data.demographics.churchAnalytics.usersWithoutChurchInfo"),
        totalChurches: analyticsNumber(church.totalChurches, "data.demographics.churchAnalytics.totalChurches"),
        totalChurchLocations: analyticsNumber(church.totalChurchLocations, "data.demographics.churchAnalytics.totalChurchLocations"),
        churchParticipationRate: analyticsNumber(church.churchParticipationRate, "data.demographics.churchAnalytics.churchParticipationRate"),
      },
      occupationAnalytics: {
        occupationStats: countRecord(occupation.occupationStats, "data.demographics.occupationAnalytics.occupationStats"),
        usersWithOccupation: analyticsNumber(occupation.usersWithOccupation, "data.demographics.occupationAnalytics.usersWithOccupation"),
        usersWithoutOccupation: analyticsNumber(occupation.usersWithoutOccupation, "data.demographics.occupationAnalytics.usersWithoutOccupation"),
        totalOccupationTypes: analyticsNumber(occupation.totalOccupationTypes, "data.demographics.occupationAnalytics.totalOccupationTypes"),
        topOccupations: occupation.topOccupations.map((item, index) => {
          const itemPath = `data.demographics.occupationAnalytics.topOccupations[${index}]`;
          const row = exactAnalyticsObject(item, itemPath, ["occupation", "count"]);
          return {
            occupation: analyticsString(row.occupation, `${itemPath}.occupation`),
            count: analyticsNumber(row.count, `${itemPath}.count`),
          };
        }),
        occupationCompletionRate: analyticsNumber(occupation.occupationCompletionRate, "data.demographics.occupationAnalytics.occupationCompletionRate"),
      },
    },
    ...(registrationProfileKpis ? { registrationProfileKpis } : {}),
  };
}

/**
 * Analytics API Service
 * Handles analytics data retrieval and export
 */
class AnalyticsApiClient extends BaseApiClient {
  /**
   * Get overall analytics data
   * @returns Analytics object
   */
  async getAnalytics(): Promise<AnalyticsOverview> {
    const response = await this.request<AnalyticsOverview>("/analytics");

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get analytics");
  }

  /**
   * Get user-specific analytics
   * @returns User analytics object
   */
  async getUserAnalytics(): Promise<UserAnalytics> {
    const response = await this.request<unknown>(
      "/analytics/users?includeRegistrationProfileKpis=1",
      { cache: "no-store" },
    );

    if (response.data) {
      return decodeUserAnalytics(response.data);
    }

    throw new Error(response.message || "Failed to get user analytics");
  }

  /**
   * Get event-specific analytics
   * @returns Event analytics object
   */
  async getEventAnalytics(): Promise<unknown> {
    const response = await this.request<unknown>("/analytics/events");

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get event analytics");
  }

  /**
   * Get engagement analytics
   * @returns Engagement analytics object
   */
  async getEngagementAnalytics(): Promise<unknown> {
    const response = await this.request<unknown>("/analytics/engagement");

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get engagement analytics");
  }

  /**
   * Get attendance confirmation analytics for completed events
   * @returns Attendance analytics grouped by summary, person, program, and event
   */
  async getAttendanceAnalytics(): Promise<AttendanceAnalytics> {
    const response = await this.request<AttendanceAnalytics>(
      "/analytics/attendance"
    );

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get attendance analytics");
  }

  /**
   * Export analytics data in specified format
   * @param format - Export format (csv, xlsx, json)
   * @returns Blob containing exported data
   */
  async exportAnalytics(
    format: "csv" | "xlsx" | "json" = "csv"
  ): Promise<Blob> {
    const response = await fetch(
      `${this.baseURL}/analytics/export?format=${format}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken")}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error("Failed to export analytics");
    }

    return response.blob();
  }

  /**
   * Export privacy-protected registration profile KPI aggregates.
   */
  async exportRegistrationProfileKpis(
    format: "csv" | "xlsx" | "json" = "xlsx",
  ): Promise<Blob> {
    const response = await fetch(
      `${this.baseURL}/analytics/registration-profile-kpis/export?format=${format}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken")}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error("Failed to export registration profile KPIs");
    }

    return response.blob();
  }

  /**
   * Get program analytics (purchases, revenue, engagement)
   * @returns Program analytics data
   */
  async getProgramAnalytics(): Promise<ProgramAnalytics> {
    const response = await this.request<ProgramAnalytics>(
      "/analytics/programs"
    );

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get program analytics");
  }

  /**
   * Get financial summary (combined programs + donations)
   * @returns Financial summary data
   */
  async getFinancialSummary(): Promise<FinancialSummary> {
    const response = await this.request<FinancialSummary>(
      "/analytics/financial-summary"
    );

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get financial summary");
  }

  /**
   * Get donation analytics (one-time, recurring, frequency distribution)
   * @returns Donation analytics data
   */
  async getDonationAnalytics(): Promise<DonationAnalytics> {
    const response = await this.request<DonationAnalytics>(
      "/analytics/donations"
    );

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get donation analytics");
  }

  /**
   * Get financial trends over time
   * @param period - Time period: "6months", "12months", "all", "custom"
   * @param startDate - Custom start date (for "custom" period only)
   * @param endDate - Custom end date (for "custom" period only)
   * @returns Financial trends data
   */
  async getTrends(
    period: "6months" | "12months" | "all" | "custom" = "6months",
    startDate?: string,
    endDate?: string
  ): Promise<TrendsData> {
    let url = `/analytics/trends?period=${period}`;
    if (period === "custom" && startDate && endDate) {
      url += `&startDate=${startDate}&endDate=${endDate}`;
    }

    const response = await this.request<TrendsData>(url);

    if (response.data) {
      return response.data;
    }

    throw new Error(response.message || "Failed to get financial trends");
  }
}

// Export singleton instance
const analyticsApiClient = new AnalyticsApiClient();

// Export service methods
export const analyticsService = {
  getAnalytics: () => analyticsApiClient.getAnalytics(),
  getUserAnalytics: () => analyticsApiClient.getUserAnalytics(),
  getEventAnalytics: () => analyticsApiClient.getEventAnalytics(),
  getEngagementAnalytics: () => analyticsApiClient.getEngagementAnalytics(),
  getAttendanceAnalytics: () => analyticsApiClient.getAttendanceAnalytics(),
  getProgramAnalytics: () => analyticsApiClient.getProgramAnalytics(),
  getDonationAnalytics: () => analyticsApiClient.getDonationAnalytics(),
  getFinancialSummary: () => analyticsApiClient.getFinancialSummary(),
  getTrends: (
    period?: "6months" | "12months" | "all" | "custom",
    startDate?: string,
    endDate?: string
  ) => analyticsApiClient.getTrends(period, startDate, endDate),
  exportAnalytics: (format?: "csv" | "xlsx" | "json") =>
    analyticsApiClient.exportAnalytics(format),
  exportRegistrationProfileKpis: (format?: "csv" | "xlsx" | "json") =>
    analyticsApiClient.exportRegistrationProfileKpis(format),
};
