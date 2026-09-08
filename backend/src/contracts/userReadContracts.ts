import { ROLES, type UserRole } from "../utils/roleUtils";

export interface PaginationDTO {
  currentPage: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CommunityMemberDTO {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  gender: "male" | "female" | null;
  roleInAtCloud: string | null;
}

export interface AdminUserDTO {
  id: string;
  username: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  gender: "male" | "female" | null;
  avatar: string | null;
  homeAddress: string | null;
  isAtCloudLeader: boolean;
  roleInAtCloud: string | null;
  occupation: string | null;
  company: string | null;
  weeklyChurch: string | null;
  churchAddress: string | null;
  role: UserRole;
  isActive: boolean;
  isVerified: boolean;
  emailNotifications: boolean;
  lastLogin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Minimal identity data used by authorized assignment workflows. */
export interface UserPickerDTO {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  gender: "male" | "female" | null;
  role: UserRole;
  roleInAtCloud: string | null;
}

export interface DirectoryAffiliationDTO {
  id: string;
  programName: string;
  cohortLabel: string | null;
}

export interface DirectoryHelpOfferingsDTO {
  careerAdvice: boolean;
  warmIntroduction: boolean;
  formalEmployeeReferral: boolean;
}

export interface DirectoryCardDTO {
  id: string;
  displayName: string;
  avatar: string | null;
  professionalHeadline: string | null;
  company: string | null;
  occupation: string | null;
  generalLocation: string | null;
  affiliations: DirectoryAffiliationDTO[];
  helpOfferings: DirectoryHelpOfferingsDTO;
}

export interface DirectoryDetailDTO extends DirectoryCardDTO {
  industry: string | null;
  skills: string[];
  bio: string | null;
}

export interface OwnAlumniProfileDTO extends DirectoryDetailDTO {
  publishStatus: "draft" | "published" | "withdrawn";
  consentVersion: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
}

export const USER_OPTION_CONTEXTS = [
  "event-organizer",
  "program-mentor",
  "event-role-assignee",
] as const;

export type UserOptionContext = (typeof USER_OPTION_CONTEXTS)[number];

export type CommunityMemberSortField = "firstName" | "lastName" | "username";

export type AdminUserSortField =
  | "createdAt"
  | "firstName"
  | "lastName"
  | "username"
  | "email"
  | "role"
  | "gender"
  | "isActive"
  | "isVerified"
  | "isAtCloudLeader"
  | "lastLogin";

export interface CommunityMembersQuery {
  page: number;
  limit: number;
  q?: string;
  sortBy: CommunityMemberSortField;
  sortOrder: "asc" | "desc";
}

export interface AdminUsersQuery {
  page: number;
  limit: number;
  q?: string;
  role?: UserRole;
  isActive?: boolean;
  isVerified?: boolean;
  isAtCloudLeader?: boolean;
  gender?: "male" | "female";
  sortBy: AdminUserSortField;
  sortOrder: "asc" | "desc";
}

export interface UserOptionsQuery {
  context: UserOptionContext;
  resourceId?: string;
  page: number;
  limit: number;
  q?: string;
}

export interface RuntimeQueryIssue {
  path: string;
  msg: string;
}

export class RuntimeQueryValidationError extends Error {
  readonly issues: RuntimeQueryIssue[];

  constructor(issues: RuntimeQueryIssue[]) {
    super("Validation failed");
    this.name = "RuntimeQueryValidationError";
    this.issues = issues;
  }
}

type QueryInput = Record<string, unknown>;

const ROLE_VALUES = Object.values(ROLES) as UserRole[];
const COMMUNITY_SORT_FIELDS: CommunityMemberSortField[] = [
  "firstName",
  "lastName",
  "username",
];
const ADMIN_SORT_FIELDS: AdminUserSortField[] = [
  "createdAt",
  "firstName",
  "lastName",
  "username",
  "email",
  "role",
  "gender",
  "isActive",
  "isVerified",
  "isAtCloudLeader",
  "lastLogin",
];

function rejectUnknownKeys(
  input: QueryInput,
  allowedKeys: readonly string[],
  issues: RuntimeQueryIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push({ path: key, msg: `Unknown query parameter: ${key}` });
    }
  }
}

function readScalar(
  input: QueryInput,
  key: string,
  issues: RuntimeQueryIssue[],
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({ path: key, msg: `${key} must be a single string value` });
    return undefined;
  }
  return value.trim();
}

function readText(
  input: QueryInput,
  key: string,
  maxLength: number,
  issues: RuntimeQueryIssue[],
): string | undefined {
  const value = readScalar(input, key, issues);
  if (value === undefined || value === "") return undefined;
  if (value.length > maxLength) {
    issues.push({
      path: key,
      msg: `${key} must be at most ${maxLength} characters`,
    });
    return undefined;
  }
  return value;
}

function readPositiveInteger(
  input: QueryInput,
  key: string,
  defaultValue: number,
  maxValue: number,
  issues: RuntimeQueryIssue[],
): number {
  const value = readScalar(input, key, issues);
  if (value === undefined || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) {
    issues.push({ path: key, msg: `${key} must be a positive integer` });
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxValue) {
    issues.push({
      path: key,
      msg: `${key} must be between 1 and ${maxValue}`,
    });
    return defaultValue;
  }
  return parsed;
}

function readBoolean(
  input: QueryInput,
  key: string,
  issues: RuntimeQueryIssue[],
): boolean | undefined {
  const value = readScalar(input, key, issues);
  if (value === undefined || value === "") return undefined;
  if (value !== "true" && value !== "false") {
    issues.push({ path: key, msg: `${key} must be true or false` });
    return undefined;
  }
  return value === "true";
}

function readEnum<T extends string>(
  input: QueryInput,
  key: string,
  allowed: readonly T[],
  issues: RuntimeQueryIssue[],
): T | undefined {
  const value = readScalar(input, key, issues);
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value as T)) {
    issues.push({
      path: key,
      msg: `${key} must be one of: ${allowed.join(", ")}`,
    });
    return undefined;
  }
  return value as T;
}

function throwIfInvalid(issues: RuntimeQueryIssue[]): void {
  if (issues.length > 0) throw new RuntimeQueryValidationError(issues);
}

export const communityMembersQuerySchema = {
  parse(input: QueryInput): CommunityMembersQuery {
    const issues: RuntimeQueryIssue[] = [];
    rejectUnknownKeys(
      input,
      ["page", "limit", "q", "sortBy", "sortOrder"],
      issues,
    );
    const page = readPositiveInteger(input, "page", 1, 1_000_000, issues);
    const limit = readPositiveInteger(input, "limit", 20, 20, issues);
    const q = readText(input, "q", 100, issues);
    const sortBy =
      readEnum(input, "sortBy", COMMUNITY_SORT_FIELDS, issues) ?? "firstName";
    const sortOrder =
      readEnum(input, "sortOrder", ["asc", "desc"] as const, issues) ??
      "asc";
    throwIfInvalid(issues);
    return { page, limit, q, sortBy, sortOrder };
  },
};

export const adminUsersQuerySchema = {
  parse(input: QueryInput): AdminUsersQuery {
    const issues: RuntimeQueryIssue[] = [];
    rejectUnknownKeys(
      input,
      [
        "page",
        "limit",
        "q",
        "role",
        "isActive",
        "isVerified",
        "isAtCloudLeader",
        "gender",
        "sortBy",
        "sortOrder",
      ],
      issues,
    );
    const page = readPositiveInteger(input, "page", 1, 1_000_000, issues);
    const limit = readPositiveInteger(input, "limit", 20, 20, issues);
    const q = readText(input, "q", 100, issues);
    const role = readEnum(input, "role", ROLE_VALUES, issues);
    const isActive = readBoolean(input, "isActive", issues);
    const isVerified = readBoolean(input, "isVerified", issues);
    const isAtCloudLeader = readBoolean(input, "isAtCloudLeader", issues);
    const gender = readEnum(
      input,
      "gender",
      ["male", "female"] as const,
      issues,
    );
    const sortBy =
      readEnum(input, "sortBy", ADMIN_SORT_FIELDS, issues) ?? "createdAt";
    const sortOrder =
      readEnum(input, "sortOrder", ["asc", "desc"] as const, issues) ??
      "desc";
    throwIfInvalid(issues);
    return {
      page,
      limit,
      q,
      role,
      isActive,
      isVerified,
      isAtCloudLeader,
      gender,
      sortBy,
      sortOrder,
    };
  },
};

export const userOptionsQuerySchema = {
  parse(input: QueryInput): UserOptionsQuery {
    const issues: RuntimeQueryIssue[] = [];
    rejectUnknownKeys(input, ["context", "resourceId", "page", "limit", "q"], issues);
    const context = readEnum(input, "context", USER_OPTION_CONTEXTS, issues);
    if (!context) {
      if (!issues.some((issue) => issue.path === "context")) {
        issues.push({ path: "context", msg: "context is required" });
      }
    }
    const resourceId = readText(input, "resourceId", 24, issues);
    if (resourceId && !/^[a-f\d]{24}$/i.test(resourceId)) {
      issues.push({
        path: "resourceId",
        msg: "resourceId must be a valid ObjectId",
      });
    }
    const page = readPositiveInteger(input, "page", 1, 1_000_000, issues);
    const limit = readPositiveInteger(input, "limit", 20, 100, issues);
    const q = readText(input, "q", 100, issues);
    if (context === "event-role-assignee" && !resourceId) {
      issues.push({
        path: "resourceId",
        msg: "resourceId is required for event-role-assignee",
      });
    }
    throwIfInvalid(issues);
    return { context: context!, resourceId, page, limit, q };
  },
};
