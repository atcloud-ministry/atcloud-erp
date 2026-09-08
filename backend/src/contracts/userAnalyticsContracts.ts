import { ROLES } from "../utils/roleUtils";

export interface UserRoleStatsDTO {
  total: number;
  superAdmin: number;
  administrators: number;
  leaders: number;
  guestExperts: number;
  participants: number;
  atCloudLeaders: number;
}

export interface ChurchAnalyticsDTO {
  weeklyChurchStats: Record<string, number>;
  churchAddressStats: Record<string, number>;
  usersWithChurchInfo: number;
  usersWithoutChurchInfo: number;
  totalChurches: number;
  totalChurchLocations: number;
  churchParticipationRate: number;
}

export interface OccupationAnalyticsDTO {
  occupationStats: Record<string, number>;
  usersWithOccupation: number;
  usersWithoutOccupation: number;
  totalOccupationTypes: number;
  topOccupations: Array<{ occupation: string; count: number }>;
  occupationCompletionRate: number;
}

export interface UserDemographicsDTO {
  roleStats: UserRoleStatsDTO;
  churchAnalytics: ChurchAnalyticsDTO;
  occupationAnalytics: OccupationAnalyticsDTO;
}

type DemographicSource = {
  role?: unknown;
  isAtCloudLeader?: unknown;
  weeklyChurch?: unknown;
  churchAddress?: unknown;
  occupation?: unknown;
};

function presentText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function buildUserDemographics(
  rows: DemographicSource[],
): UserDemographicsDTO {
  const roleStats: UserRoleStatsDTO = {
    total: rows.length,
    superAdmin: 0,
    administrators: 0,
    leaders: 0,
    guestExperts: 0,
    participants: 0,
    atCloudLeaders: 0,
  };
  const weeklyChurchStats: Record<string, number> = {};
  const churchAddressStats: Record<string, number> = {};
  const occupationStats: Record<string, number> = {};
  let usersWithChurchInfo = 0;
  let usersWithOccupation = 0;

  for (const row of rows) {
    if (row.role === ROLES.SUPER_ADMIN) roleStats.superAdmin += 1;
    else if (row.role === ROLES.ADMINISTRATOR) roleStats.administrators += 1;
    else if (row.role === ROLES.LEADER) roleStats.leaders += 1;
    else if (row.role === ROLES.GUEST_EXPERT) roleStats.guestExperts += 1;
    else if (row.role === ROLES.PARTICIPANT) roleStats.participants += 1;

    if (row.isAtCloudLeader === true && row.role !== ROLES.GUEST_EXPERT) {
      roleStats.atCloudLeaders += 1;
    }

    const weeklyChurch = presentText(row.weeklyChurch);
    const churchAddress = presentText(row.churchAddress);
    if (weeklyChurch) {
      weeklyChurchStats[weeklyChurch] =
        (weeklyChurchStats[weeklyChurch] ?? 0) + 1;
    }
    if (churchAddress) {
      churchAddressStats[churchAddress] =
        (churchAddressStats[churchAddress] ?? 0) + 1;
    }
    if (weeklyChurch || churchAddress) usersWithChurchInfo += 1;

    const occupation = presentText(row.occupation);
    if (occupation) {
      usersWithOccupation += 1;
      occupationStats[occupation] = (occupationStats[occupation] ?? 0) + 1;
    }
  }

  const total = rows.length;
  return {
    roleStats,
    churchAnalytics: {
      weeklyChurchStats,
      churchAddressStats,
      usersWithChurchInfo,
      usersWithoutChurchInfo: total - usersWithChurchInfo,
      totalChurches: Object.keys(weeklyChurchStats).length,
      totalChurchLocations: Object.keys(churchAddressStats).length,
      churchParticipationRate:
        total > 0
          ? Math.round((usersWithChurchInfo / total) * 1_000) / 10
          : 0,
    },
    occupationAnalytics: {
      occupationStats,
      usersWithOccupation,
      usersWithoutOccupation: total - usersWithOccupation,
      totalOccupationTypes: Object.keys(occupationStats).length,
      topOccupations: Object.entries(occupationStats)
        .sort(([, left], [, right]) => right - left)
        .slice(0, 5)
        .map(([occupation, count]) => ({ occupation, count })),
      occupationCompletionRate:
        total > 0
          ? Math.round((usersWithOccupation / total) * 1_000) / 10
          : 0,
    },
  };
}
