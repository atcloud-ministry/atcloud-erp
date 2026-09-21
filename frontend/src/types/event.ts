export interface EventParticipant {
  registrationId?: string;
  userId: string; // Changed from number to string to match Management UUIDs
  username: string;
  firstName?: string; // Optional for flexibility
  lastName?: string; // Optional for flexibility
  email?: string;
  phone?: string;
  systemAuthorizationLevel?: string; // System authorization level (Super Admin, Administrator, Leader, Participant)
  roleInAtCloud?: string;
  avatar?: string;
  gender?: "male" | "female"; // For default avatar selection
  notes?: string;
  registeredAt?: string;
  registrationStatus?: "active" | "waitlisted" | "attended" | "no_show";
  attendanceConfirmed?: boolean;
}

export interface OrganizerDetail {
  userId?: string; // Optional user ID for clickable name cards
  name: string;
  role: string;
  email?: string;
  phone?: string;
  avatar?: string | null;
  gender?: "male" | "female";
}

export interface EventRole {
  id: string;
  name: string;
  description: string;
  // Optional role-level agenda (separate from event-level agenda)
  agenda?: string;
  maxParticipants: number;
  startTime?: string; // Optional role-specific start time (HH:mm format)
  endTime?: string; // Optional role-specific end time (HH:mm format)
  currentSignups: EventParticipant[]; // Ensure this is strictly an array of EventParticipant
  // Whether this role is open to public self-registration when event is published
  openToPublic?: boolean;
  // Computed remaining capacity for public display (provided by public serializer)
  capacityRemaining?: number;
}

// Updated EventData interface
export interface EventData {
  id: string; // Changed from number to string for consistency
  title: string;
  type: string; // Changed from literal type to string
  date: string;
  endDate?: string;
  time: string;
  endTime: string; // New field for event end time
  location: string;
  organizer: string;
  organizerDetails?: OrganizerDetail[]; // Optional detailed organizer information
  hostedBy?: string; // Hosted by information
  purpose?: string;
  agenda?: string; // Event agenda and schedule
  format: string; // Changed from literal union to string
  disclaimer?: string; // Optional disclaimer terms
  // Additional event disclaimer for viewer pages (mirrors public view)
  publicDisclaimer?: string; // legacy alias if backend uses different field name

  // Role-based system (new requirement)
  roles: EventRole[];

  // Legacy properties for backward compatibility
  signedUp: number;
  totalSlots: number;

  // Optional properties
  attendees?: number;
  status?: "upcoming" | "ongoing" | "completed" | "cancelled";
  isHybrid?: boolean;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  requirements?: string;
  materials?: string;
  timeZone?: string;
  flyerUrl?: string; // Optional Event Flyer image URL
  secondaryFlyerUrl?: string; // Optional Secondary Event Flyer image URL (for events only)
  youtubeUrl?: string; // Optional YouTube video URL (only for completed events)

  // Programs integration - many-to-many relationship
  programLabels?: string[]; // Array of program IDs this event belongs to

  // Paid Events Feature (Phase 4)
  pricing?: {
    isFree: boolean;
    price?: number; // Price in cents (e.g., 2500 = $25.00)
  };

  // Workshop-specific topics per group A-F
  workshopGroupTopics?: {
    A?: string;
    B?: string;
    C?: string;
    D?: string;
    E?: string;
    F?: string;
  };

  // Public publishing fields
  publish?: boolean; // Whether event is published (publicly accessible)
  publishedAt?: string; // First time event was published (preserved across cycles)
  publicSlug?: string; // Stable slug used in public URL

  // Auto-unpublish tracking (mirrors backend fields)
  autoUnpublishedAt?: string | null;
  autoUnpublishedReason?: string | null;
  // 48-hour grace period tracking
  unpublishScheduledAt?: string | null; // When unpublish is scheduled (null = not scheduled)
  unpublishWarningFields?: string[]; // Fields that triggered the grace period warning

  // Management properties
  createdBy:
    | string
    | {
        _id?: string;
        id?: string;
        username?: string;
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        systemAuthorizationLevel?: string;
        roleInAtCloud?: string;
        role?: string;
        avatar?: string;
        gender?: "male" | "female";
      };
  createdAt: string;
}

// Mapping of necessary fields for publishing by format (frontend mirror of backend constant)
export const NECESSARY_PUBLISH_FIELDS_BY_FORMAT: Record<string, string[]> = {
  Online: ["zoomLink", "meetingId", "passcode"],
  "In-person": ["location"],
  "Hybrid Participation": ["location", "zoomLink", "meetingId", "passcode"],
};

// Human readable labels (centralized for UI banner/tooltips)
export const PUBLISH_FIELD_LABELS: Record<string, string> = {
  zoomLink: "Zoom Link",
  meetingId: "Meeting ID",
  passcode: "Passcode",
  location: "Location",
  roles: "At least one public role",
};

export function getMissingNecessaryFieldsForPublishFrontend(
  event: Partial<EventData>,
): string[] {
  const needed = NECESSARY_PUBLISH_FIELDS_BY_FORMAT[event.format || ""] || [];
  const missing: string[] = [];
  for (const f of needed) {
    const val = (event as Record<string, unknown>)[f];
    if (
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim().length === 0)
    ) {
      missing.push(f);
    }
  }

  // Check if at least one role is open to public
  const roles = event.roles || [];
  const hasPublicRole = roles.some(
    (r) => (r as { openToPublic?: boolean }).openToPublic,
  );
  if (!hasPublicRole) {
    missing.push("roles");
  }

  return missing;
}

export function buildPublishReadinessMessage(
  event: Partial<EventData>,
): string {
  const missing = getMissingNecessaryFieldsForPublishFrontend(event);
  if (!missing.length) return "All required fields present for publishing.";
  return `Add: ${missing.map((m) => PUBLISH_FIELD_LABELS[m] || m).join(", ")}`;
}

export interface EventStats {
  totalEvents: number;
  totalParticipants: number;
  availableSpots?: number; // For upcoming events
  totalAttendees?: number; // For passed events
  completedEvents?: number; // For passed events
}

export type EventListType = "upcoming" | "passed";
