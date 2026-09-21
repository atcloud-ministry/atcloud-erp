/**
 * Core type definitions for the @Cloud Event Sign-up System
 * This file centralizes all shared types to ensure consistency across the application
 */

import type {
  EmploymentStatus,
  IsoCountryCode,
} from "@atcloud/shared-time/registration-profile";

export type {
  EmploymentStatus,
  IsoCountryCode,
  RegistrationProfileFields,
  StoredRegistrationProfileFields,
} from "@atcloud/shared-time/registration-profile";

// Re-export Purchase types (Phase 4 - Paid Events Feature)
export * from "./purchase";

// Base User Types
export type SystemAuthorizationLevel =
  | "Super Admin"
  | "Administrator"
  | "Leader"
  | "Guest Expert"
  | "Participant";
export type AtCloudLeaderStatus = "Yes" | "No";
export type Gender = "male" | "female";

// Core User Interface (for authentication and profile)
export interface User {
  id: string; // UUID from backend
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  birthYear?: number;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: IsoCountryCode;
  employmentStatus?: EmploymentStatus;
  gender: Gender;
  avatar?: string | null;

  // Role Information
  role: SystemAuthorizationLevel; // System-level authorization level
  isAtCloudLeader: AtCloudLeaderStatus;
  roleInAtCloud?: string; // Only present if isAtCloudLeader is "Yes"

  // Profile Information
  homeAddress?: string;
  occupation?: string | null; // User's profession or occupation
  company?: string | null;
  weeklyChurch?: string; // Which church do you attend weekly?
  churchAddress?: string; // Church's full address

  // System Information
  joinDate?: string;
  lastLogin?: string;
}

// Authentication User (minimal subset for auth context)
export interface AuthUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  birthYear?: number;
  residenceCity?: string;
  residenceRegion?: string | null;
  residenceCountryCode?: IsoCountryCode;
  employmentStatus?: EmploymentStatus;
  role: SystemAuthorizationLevel;
  isAtCloudLeader: AtCloudLeaderStatus;
  roleInAtCloud?: string;
  gender: Gender;
  avatar?: string | null;
  weeklyChurch?: string;
  churchAddress?: string;
  homeAddress?: string;
  occupation?: string | null;
  company?: string | null;
}

// Event Organizer (for event management)
export interface EventOrganizer {
  id: string; // User ID
  firstName: string;
  lastName: string;
  systemAuthorizationLevel: SystemAuthorizationLevel;
  roleInAtCloud?: string;
  gender: Gender;
  avatar: string | null;
}

// Form Data Types
export interface LoginFormData {
  emailOrUsername: string; // unified credential input
  password: string;
  rememberMe?: boolean;
}

export interface ChangePasswordFormData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

// Event Types
export interface Event {
  id: string;
  title: string;
  description: string;
  date: string;
  time: string;
  location: string;
  organizer: string; // Display string
  organizerDetails: EventOrganizer[];
  maxParticipants: number;
  currentParticipants: number;
  status: "upcoming" | "ongoing" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  // Paid Events Feature (Phase 4)
  pricing?: {
    isFree: boolean;
    price?: number; // Price in cents (e.g., 2500 = $25.00)
  };
}

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: Record<string, string[]>;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Error Types
export interface AppError {
  message: string;
  code?: string;
  field?: string;
  details?: Record<string, unknown>;
}

// UI State Types
export interface LoadingState {
  isLoading: boolean;
  error?: AppError | null;
}

export interface FormState<T = unknown> extends LoadingState {
  data: T;
  isDirty: boolean;
  isSubmitting: boolean;
}

// Navigation Types
export interface NavigationItem {
  name: string;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  requiresAuth?: boolean;
  allowedRoles?: SystemAuthorizationLevel[];
}

// Utility Types
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

// System Monitoring Types
export interface SystemHealth {
  status: "healthy" | "warning" | "critical";
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  requests: {
    total: number;
    perMinute: number;
    errorRate: number;
  };
}

export interface EndpointMetric {
  path: string;
  method: string;
  count: number;
  avgResponseTime: number;
  errorCount: number;
  lastAccessed: string;
}

export interface IPMetric {
  ip: string;
  requestCount: number;
  uniqueEndpoints: number;
  lastSeen: string;
  suspicious: boolean;
}

export interface RequestStats {
  totalRequests: number;
  requestsPerMinute: number;
  averageResponseTime: number;
  errorRate: number;
  activeConnections: number;
}

export interface MonitoringAlert {
  id: string;
  type: "warning" | "critical";
  message: string;
  timestamp: string;
  resolved: boolean;
}

// Constants
export const SYSTEM_AUTHORIZATION_LEVELS: SystemAuthorizationLevel[] = [
  "Super Admin",
  "Administrator",
  "Leader",
  "Guest Expert",
  "Participant",
];
export const AT_CLOUD_LEADER_OPTIONS: AtCloudLeaderStatus[] = ["Yes", "No"];
export const GENDER_OPTIONS: Gender[] = ["male", "female"];
