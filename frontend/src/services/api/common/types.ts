// API Response Types
import type {
  EmploymentStatus,
  IsoCountryCode,
} from "@atcloud/shared-time/registration-profile";

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

export interface AuthResponse {
  user: {
    id: string;
    username: string;
    email: string;
    phone?: string;
    birthYear?: number;
    residenceCity?: string;
    residenceRegion?: string | null;
    residenceCountryCode?: IsoCountryCode;
    employmentStatus?: EmploymentStatus;
    firstName?: string;
    lastName?: string;
    gender?: string;
    role: string;
    isAtCloudLeader: boolean;
    roleInAtCloud?: string;
    avatar?: string;
    weeklyChurch?: string;
    churchAddress?: string;
    occupation?: string | null;
    company?: string | null;
    homeAddress?: string;
    lastLogin?: string;
    createdAt?: string;
    isVerified?: boolean;
    isActive?: boolean;
  };
  accessToken: string;
  expiresAt: string;
}

// Minimal payload shape used in tests for updateEvent
export type UpdateEventPayload = Record<string, unknown> & {
  organizerDetails: unknown[];
  forceDeleteRegistrations?: boolean; // Force delete all registrations when applying template
};

// Minimal guest summary for admin views and token-based management
export interface GuestSummary {
  id?: string;
  _id?: string;
  fullName: string;
  gender?: "male" | "female";
  email?: string;
  phone?: string;
  notes?: string;
  roleId: string;
  manageToken?: string;
}

// Program participant types
export type ProgramParticipant = {
  user: {
    _id?: string; // For direct Mongoose documents
    id?: string; // For JSON-serialized responses
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    avatar?: string;
    gender?: "male" | "female";
    roleInAtCloud?: string;
  };
  isPaid: boolean;
  enrollmentDate: string;
  studentRoleId?: string;
  studentRoleName?: string;
};

export type ProgramParticipantsResponse = {
  mentees: ProgramParticipant[];
  classReps: ProgramParticipant[];
  studentRoles?: Array<{
    roleId: string;
    name: string;
    discountEligible?: boolean;
    participants: ProgramParticipant[];
  }>;
};

export type ProgramUnenrollPreview = {
  enrollmentType: "mentee" | "classRep";
  studentRoleId?: string;
  studentRoleName?: string;
  isPaid: boolean;
  refundEligible: boolean;
  requiresApproval: boolean;
  refundAmount: number;
  daysRemaining?: number;
  purchaseDate?: string;
  refundDeadline?: string;
  refundWindowExpired: boolean;
  reason?: string;
};

export type ProgramUnenrollResult = {
  refundStatus:
    | "processing"
    | "pending_approval"
    | "failed"
    | "not_eligible"
    | "not_applicable";
  refundId?: string;
  refundRequestId?: string;
  existingRequest?: boolean;
  enrollmentType: "mentee" | "classRep";
  studentRoleId?: string;
  studentRoleName?: string;
  reason?: string;
};

// Re-export public event types from main types
export type {
  PublicEventData,
  PublicEventListItem,
  PublicRegistrationPayload,
  PublicRegistrationResponse,
} from "../../../types/publicEvent";
