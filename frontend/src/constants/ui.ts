// UI Constants - Centralized styling and component configurations
export const UI_CONSTANTS = {
  // Button styles - using consistent design system
  BUTTON_STYLES: {
    primary:
      "bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors",
    secondary:
      "bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-md font-medium transition-colors",
    success:
      "bg-green-700 hover:bg-green-800 text-white px-4 py-2 rounded-md font-medium transition-colors",
    danger:
      "bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md font-medium transition-colors",
    warning:
      "bg-orange-700 hover:bg-orange-800 text-white px-4 py-2 rounded-md font-medium transition-colors",
    ghost:
      "bg-transparent text-gray-700 hover:text-gray-900 px-4 py-2 rounded-md font-medium transition-colors",

    // Size variants
    small: "px-3 py-1 text-sm",
    medium: "px-4 py-2",
    large: "px-6 py-3 text-lg",

    // Special variants
    link: "text-blue-600 hover:text-blue-800 underline",
    outline:
      "border border-gray-500 hover:border-gray-700 bg-white text-gray-700 px-4 py-2 rounded-md font-medium transition-colors",
  },

  // Badge/Status styles
  BADGE_STYLES: {
    success:
      "bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs font-medium",
    error: "bg-red-100 text-red-800 px-2 py-1 rounded-full text-xs font-medium",
    warning:
      "bg-orange-100 text-orange-800 px-2 py-1 rounded-full text-xs font-medium",
    info: "bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-medium",
    neutral:
      "bg-gray-100 text-gray-800 px-2 py-1 rounded-full text-xs font-medium",
    purple:
      "bg-purple-100 text-purple-800 px-2 py-1 rounded-full text-xs font-medium",
  },

  // Sort button styles
  SORT_BUTTON: {
    active: "bg-blue-50 border-blue-300 text-blue-700",
    inactive: "bg-white border-gray-500 text-gray-700 hover:bg-gray-50",
    base: "flex items-center gap-2 px-3 py-2 text-sm border rounded-md transition-colors",
  },

  // Card styles
  CARD_STYLES: {
    base: "bg-white rounded-lg shadow-sm",
    interactive:
      "bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer",
    padding: {
      small: "p-4",
      medium: "p-6",
      large: "p-8",
    },
  },

  // Input styles
  INPUT_STYLES: {
    base: "w-full px-3 py-2 border border-gray-500 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500",
    error: "border-red-600 focus:ring-red-600 focus:border-red-600",
    success: "border-green-700 focus:ring-green-700 focus:border-green-700",
  },

  // Animation classes
  ANIMATIONS: {
    fadeIn: "animate-fadeIn",
    slideIn: "animate-slideIn",
    pulse: "animate-pulse",
    spin: "animate-spin",
  },
} as const;

// Event status mapping
export const EVENT_STATUS = {
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  ACTIVE: "active",
  UPCOMING: "upcoming",
} as const;

// Role-based colors for consistent theming
export const ROLE_COLORS = {
  "Super Admin": "purple",
  Administrator: "blue",
  Leader: "green",
  Participant: "gray",
} as const;

// Centralized role color scheme (aligned with Management statistics cards)
// Use these to keep colors in sync across pages (Management, Analytics, etc.)
export type StatsCardColor =
  | "blue"
  | "green"
  | "yellow"
  | "red"
  | "purple"
  | "gray"
  | "orange"
  | "aquamarine";

export const ROLE_COLOR_SCHEME: Record<
  string,
  { card: StatsCardColor; badgeBg: string; badgeText: string }
> = {
  "Super Admin": {
    card: "purple",
    badgeBg: "bg-purple-100",
    badgeText: "text-purple-800",
  },
  Administrator: {
    card: "red",
    badgeBg: "bg-red-100",
    badgeText: "text-red-800",
  },
  Administrators: {
    // plural support for display label
    card: "red",
    badgeBg: "bg-red-100",
    badgeText: "text-red-800",
  },
  Leader: {
    card: "yellow",
    badgeBg: "bg-yellow-100",
    badgeText: "text-yellow-800",
  },
  Leaders: {
    card: "yellow",
    badgeBg: "bg-yellow-100",
    badgeText: "text-yellow-800",
  },
  "Guest Expert": {
    card: "aquamarine", // cyan variant in StatsCard
    badgeBg: "bg-cyan-100",
    badgeText: "text-cyan-800",
  },
  "Guest Experts": {
    card: "aquamarine",
    badgeBg: "bg-cyan-100",
    badgeText: "text-cyan-800",
  },
  Participant: {
    card: "green",
    badgeBg: "bg-green-100",
    badgeText: "text-green-800",
  },
  Participants: {
    card: "green",
    badgeBg: "bg-green-100",
    badgeText: "text-green-800",
  },
  "@Cloud Co-workers": {
    card: "orange",
    badgeBg: "bg-orange-100",
    badgeText: "text-orange-800",
  },
};

// Helper: get stats card color token for a role label
export function getRoleCardColor(roleLabel: string): StatsCardColor {
  return ROLE_COLOR_SCHEME[roleLabel]?.card || "gray";
}

// Helper: get badge bg/text classes for a role label
export function getRoleBadgeClassNames(roleLabel: string): string {
  const cfg = ROLE_COLOR_SCHEME[roleLabel];
  if (!cfg) return "bg-gray-100 text-gray-800";
  return `${cfg.badgeBg} ${cfg.badgeText}`;
}

// Engagement tiers for participant activity (by number of events)
// Tiers (inclusive ranges):
// - 0: gray (no activity)
// - 1-2: blue (low)
// - 3-4: green (medium)
// - 5-9: orange (high)
// - 10+: purple (elite)
export function getEngagementBadgeClassNames(
  count: number | undefined
): string {
  const n = typeof count === "number" && !Number.isNaN(count) ? count : 0;
  if (n <= 0) return "bg-gray-100 text-gray-800";
  if (n <= 2) return "bg-blue-100 text-blue-800";
  if (n <= 4) return "bg-green-100 text-green-800";
  if (n <= 9) return "bg-orange-100 text-orange-800";
  return "bg-purple-100 text-purple-800";
}

// Priority levels
export const PRIORITY_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

// Loading states configuration
export const LOADING_CONFIG = {
  SKELETON_ROWS: 3,
  SKELETON_DELAY: 200,
  MIN_LOADING_TIME: 500,
} as const;
