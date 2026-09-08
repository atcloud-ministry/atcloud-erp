import { BaseApiClient } from "./common";

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
    const response = await this.request<unknown>("/analytics/users");

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
};
