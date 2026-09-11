/**
 * Phase 2 Migration: API Response Interfaces
 *
 * Standardized response formats for Registration-based queries
 * These interfaces ensure consistency between backend and frontend
 */

/** Lightweight role summary used by event-list cards. */
export interface EventListRoleData {
  id: string;
  name: string;
  description: string;
  agenda?: string;
  maxParticipants: number;
  openToPublic?: boolean;
  currentCount: number;
  availableSpots: number;
  isFull: boolean;
  waitlistCount: number;
  // Frontend compatibility without shipping participant records in list APIs.
  currentSignups: [];
}

/**
 * Event-list response contract. Detail-only content and participant records are
 * deliberately excluded so list pages remain small and constant-query.
 */
export interface EventListItemData {
  id: string;
  title: string;
  type: string;
  date: string;
  endDate: string;
  time: string;
  endTime: string;
  timeZone?: string;
  location: string;
  organizer: string;
  organizerDetails?: OrganizerDetail[];
  hostedBy?: string;
  format: string;
  status: "upcoming" | "ongoing" | "completed" | "cancelled";
  createdBy: UserBasicInfo;
  createdAt: Date;
  roles: EventListRoleData[];
  totalCapacity: number;
  totalRegistrations: number;
  availableSpots: number;
  totalSlots: number;
  signedUp: number;
  maxParticipants: number;
  publish?: boolean;
  publishedAt?: Date | null;
  publicSlug?: string;
  youtubeUrl?: string;
  programLabels?: string[];
}

export interface EventWithRegistrationData {
  id: string;
  title: string;
  type: string; // FIX: Add missing type field
  date: string;
  endDate: string;
  time: string;
  endTime: string;
  location: string;
  organizer: string;
  organizerDetails?: OrganizerDetail[];
  hostedBy?: string;
  purpose?: string;
  agenda?: string;
  format: string;
  timeZone?: string;
  disclaimer?: string;
  // Programs & Mentors (optional)
  programId?: string | null;
  programLabels?: string[]; // Array of program IDs
  mentorCircle?: "E" | "M" | "B" | "A" | null;
  mentors?: Array<{
    userId?: string;
    name?: string;
    email?: string;
    gender?: "male" | "female";
    avatar?: string;
    roleInAtCloud?: string;
  }> | null;
  // Optional Event Flyer image URL (absolute or /uploads/...)
  flyerUrl?: string;
  // Optional Secondary Event Flyer image URL (for events only, not programs)
  secondaryFlyerUrl?: string;
  // Optional YouTube video URL (for completed events)
  youtubeUrl?: string;
  isHybrid?: boolean;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  requirements?: string;
  materials?: string;
  // Workshop-specific fields
  workshopGroupTopics?: {
    A?: string;
    B?: string;
    C?: string;
    D?: string;
    E?: string;
    F?: string;
  };
  status: "upcoming" | "ongoing" | "completed" | "cancelled";
  createdBy: UserBasicInfo;
  roles: EventRoleWithCounts[];
  totalCapacity: number;
  totalRegistrations: number;
  availableSpots: number;
  // FIX: Add frontend-compatible field names for event cards
  totalSlots: number;
  signedUp: number;
  // FIX: Add backward compatibility alias for tests expecting maxParticipants
  maxParticipants: number;
  createdAt: Date;
  updatedAt: Date;
  // Publish lifecycle fields (added to fix frontend refresh losing publish state)
  publish?: boolean;
  publishedAt?: Date | null;
  publicSlug?: string;
  // Auto-unpublish tracking
  autoUnpublishedAt?: Date | null;
  autoUnpublishedReason?: string | null;
  // 48-hour grace period tracking
  unpublishScheduledAt?: Date | null;
  unpublishWarningFields?: string[];
  // Pricing (Paid Events Feature - Phase 6)
  pricing?: {
    isFree?: boolean;
    price?: number;
  };
}

export interface EventRoleWithCounts {
  id: string;
  name: string;
  description: string;
  // Optional role-level agenda (not the global event agenda)
  agenda?: string;
  maxParticipants: number;
  // Whether this role is publicly visible & registerable (mirrors Event.roles[].openToPublic)
  openToPublic?: boolean;
  currentCount: number;
  availableSpots: number;
  isFull: boolean;
  waitlistCount: number;
  registrations: RegistrationWithUser[];
}

export interface RegistrationWithUser {
  id: string;
  userId: string;
  eventId: string;
  roleId: string;
  status: "active" | "waitlisted" | "attended" | "no_show";
  attendanceConfirmed?: boolean;
  user: UserBasicInfo;
  registeredAt: Date;
  // Participant-provided fields captured at signup time
  notes?: string; // Optional signup notes (max 500 chars in schema)
  specialRequirements?: string; // Accessibility or other requirements
  eventSnapshot: {
    eventTitle: string;
    eventDate: string;
    eventTime: string;
    roleName: string;
    roleDescription: string;
  };
}

export interface UserBasicInfo {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  gender?: "male" | "female";
  systemAuthorizationLevel: string;
  roleInAtCloud: string;
  role: string;
  avatar?: string;
}

export interface OrganizerDetail {
  name: string;
  role: string;
  email: string;
  phone?: string;
  avatar?: string;
  gender?: "male" | "female";
}

export interface EventListResponse {
  success: boolean;
  data: {
    events: EventListItemData[];
    totalEvents: number;
    totalPages: number;
    currentPage: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  message?: string;
}

export interface EventDetailResponse {
  success: boolean;
  data: EventWithRegistrationData;
  message?: string;
}

export interface UserSignupStatusResponse {
  success: boolean;
  data: {
    userId: string;
    eventId: string;
    isRegistered: boolean;
    currentRole?: string;
    canSignup: boolean;
    canSignupForMoreRoles: boolean;
    currentSignupCount: number;
    maxAllowedSignups: number;
    availableRoles: string[];
    restrictedRoles: string[];
  };
  message?: string;
}

export interface AnalyticsEventData {
  id: string;
  title: string;
  date: string;
  endDate: string;
  time: string;
  endTime: string;
  location: string;
  status: string;
  format: string;
  timeZone?: string;
  type: string;
  hostedBy: string;
  createdBy: UserBasicInfo;
  roles: {
    id: string;
    name: string;
    maxParticipants: number;
    currentCount: number;
    registrations: RegistrationWithUser[];
  }[];
  totalCapacity: number;
  totalRegistrations: number;
  registrationRate: number; // percentage
}

export interface AnalyticsResponse {
  success: boolean;
  data: {
    overview: {
      totalUsers: number;
      totalEvents: number;
      totalRegistrations: number;
      activeUsers: number;
      upcomingEvents: number;
      recentRegistrations: number;
    };
    eventAnalytics?: {
      eventsByType: Array<{ _id: string; count: number; percentage: number }>;
      eventsByFormat: Array<{ _id: string; count: number; percentage: number }>;
      registrationStats: Array<{
        _id: { year: number; month: number };
        totalRegistrations: number;
        averagePerEvent: number;
      }>;
      eventTrends: Array<{
        _id: { year: number; month: number };
        count: number;
      }>;
      upcomingEvents: AnalyticsEventData[];
      completedEvents: AnalyticsEventData[];
    };
    userAnalytics?: {
      usersByRole: Array<{ _id: string; count: number; percentage: number }>;
      userRegistrationActivity: Array<{
        _id: string;
        registrationCount: number;
        user: UserBasicInfo;
      }>;
      topParticipants: Array<{
        user: UserBasicInfo;
        eventCount: number;
        roles: string[];
      }>;
    };
  };
  message?: string;
}

export interface WebSocketEventUpdate {
  type:
    | "user_signed_up"
    | "user_cancelled"
    | "user_moved"
    | "event_updated"
    | "role_capacity_changed"
    | "workshop_topic_updated"
    | "attendance_updated";
  eventId: string;
  data: {
    userId?: string;
    registrationId?: string;
    roleId?: string;
    attended?: boolean;
    fromRoleId?: string;
    toRoleId?: string;
    newCount?: number;
    event?: EventWithRegistrationData;
    role?: EventRoleWithCounts;
    group?: "A" | "B" | "C" | "D" | "E" | "F";
    topic?: string;
  };
  timestamp: Date;
}

// Program Deletion API Response Types
export interface ProgramDeletionResponse {
  success: true;
  message: string;
  // Unlink-only mode fields
  unlinkedEvents?: number;
  // Cascade mode fields
  deletedEvents?: number;
  deletedRegistrations?: number;
  deletedGuestRegistrations?: number;
}

export interface ProgramEventsResponse {
  success: true;
  data: Array<{
    _id: string;
    title: string;
    date: string;
    time: string;
    programId: string;
    [key: string]: unknown; // Allow for other event fields
  }>;
}

// Event Cascade Service Response Types
export interface EventCascadeDeletionResult {
  deletedRegistrations: number;
  deletedGuestRegistrations: number;
}

// Type guards for program deletion responses
export const isProgramDeletionResponse = (
  response: unknown,
): response is ProgramDeletionResponse => {
  return (
    response !== null &&
    typeof response === "object" &&
    "success" in response &&
    (response as { success: unknown }).success === true &&
    "message" in response &&
    typeof (response as { message: unknown }).message === "string" &&
    ("unlinkedEvents" in response || "deletedEvents" in response)
  );
};
