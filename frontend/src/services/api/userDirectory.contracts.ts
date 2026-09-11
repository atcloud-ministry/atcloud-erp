import {
  isEmploymentStatus,
  isBirthYear,
  isIsoCountryCode,
  isIsoSubdivisionCode,
  type EmploymentStatus,
  type IsoCountryCode,
} from "@atcloud/shared-time/registration-profile";

export type UserRole =
  | "Super Admin"
  | "Administrator"
  | "Leader"
  | "Guest Expert"
  | "Participant";

export type UserGender = "male" | "female";

export interface AdminUserDTO {
  id: string;
  username: string;
  email: string;
  phone: string | null;
  birthYear: number | null;
  residenceCity: string | null;
  residenceRegion: string | null;
  residenceCountryCode: IsoCountryCode | null;
  employmentStatus: EmploymentStatus | null;
  firstName: string | null;
  lastName: string | null;
  gender: UserGender | null;
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

export interface CommunityMemberDTO {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  gender: UserGender | null;
  roleInAtCloud: string | null;
}

export type UserOptionContext =
  | "event-organizer"
  | "program-mentor"
  | "event-role-assignee";

export interface UserPickerDTO {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  gender: UserGender | null;
  role: UserRole;
  roleInAtCloud: string | null;
}

export interface AdminUsersPageDTO {
  users: AdminUserDTO[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalUsers: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface CommunityMembersPageDTO {
  members: CommunityMemberDTO[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalMembers: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface UserOptionsPageDTO {
  options: UserPickerDTO[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalOptions: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

type JsonObject = Record<string, unknown>;

const USER_ROLES = new Set<UserRole>([
  "Super Admin",
  "Administrator",
  "Leader",
  "Guest Expert",
  "Participant",
]);
const USER_GENDERS = new Set<UserGender>(["male", "female"]);

function contractError(path: string, expectation: string): never {
  throw new Error(`Invalid API response at ${path}: expected ${expectation}`);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return contractError(path, "object");
  }
  return value as JsonObject;
}

function exactObjectAt(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): JsonObject {
  const object = objectAt(value, path);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    return contractError(path, `only keys ${allowedKeys.join(", ")}`);
  }
  return object;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") return contractError(path, "string");
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringAt(value, path);
}

function nullableBirthYearAt(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!isBirthYear(value)) {
    return contractError(path, "valid birth year integer or null");
  }
  return Number(value);
}

function nullableCountryCodeAt(
  value: unknown,
  path: string,
): IsoCountryCode | null {
  if (value === null) return null;
  if (!isIsoCountryCode(value)) {
    return contractError(path, "ISO 3166-1 alpha-2 country code or null");
  }
  return value;
}

function nullableEmploymentStatusAt(
  value: unknown,
  path: string,
): EmploymentStatus | null {
  if (value === null) return null;
  if (!isEmploymentStatus(value)) {
    return contractError(path, "recognized employment status or null");
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return contractError(path, "boolean");
  return value;
}

function nonnegativeIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    return contractError(path, "nonnegative integer");
  }
  return Number(value);
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    return contractError(path, "positive integer");
  }
  return Number(value);
}

function roleAt(value: unknown, path: string): UserRole {
  if (typeof value !== "string" || !USER_ROLES.has(value as UserRole)) {
    return contractError(path, "recognized user role");
  }
  return value as UserRole;
}

function nullableGenderAt(
  value: unknown,
  path: string,
): UserGender | null {
  if (value === null) return null;
  if (typeof value !== "string" || !USER_GENDERS.has(value as UserGender)) {
    return contractError(path, "male, female, or null");
  }
  return value as UserGender;
}

function arrayAt<T>(
  value: unknown,
  path: string,
  decodeItem: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) return contractError(path, "array");
  return value.map((item, index) => decodeItem(item, `${path}[${index}]`));
}

const ADMIN_USER_KEYS = [
  "id",
  "username",
  "email",
  "phone",
  "birthYear",
  "residenceCity",
  "residenceRegion",
  "residenceCountryCode",
  "employmentStatus",
  "firstName",
  "lastName",
  "gender",
  "avatar",
  "homeAddress",
  "isAtCloudLeader",
  "roleInAtCloud",
  "occupation",
  "company",
  "weeklyChurch",
  "churchAddress",
  "role",
  "isActive",
  "isVerified",
  "emailNotifications",
  "lastLogin",
  "createdAt",
  "updatedAt",
] as const;

export function decodeAdminUser(
  value: unknown,
  path = "data.user",
): AdminUserDTO {
  const user = exactObjectAt(value, path, ADMIN_USER_KEYS);
  const residenceCountryCode = nullableCountryCodeAt(
    user.residenceCountryCode,
    `${path}.residenceCountryCode`,
  );
  const residenceRegion = nullableStringAt(
    user.residenceRegion,
    `${path}.residenceRegion`,
  );
  if (
    residenceRegion !== null &&
    !isIsoSubdivisionCode(residenceRegion, residenceCountryCode)
  ) {
    return contractError(
      `${path}.residenceRegion`,
      "ISO 3166-2 code matching residenceCountryCode or null",
    );
  }
  return {
    id: stringAt(user.id, `${path}.id`),
    username: stringAt(user.username, `${path}.username`),
    email: stringAt(user.email, `${path}.email`),
    phone: nullableStringAt(user.phone, `${path}.phone`),
    birthYear: nullableBirthYearAt(user.birthYear, `${path}.birthYear`),
    residenceCity: nullableStringAt(
      user.residenceCity,
      `${path}.residenceCity`,
    ),
    residenceRegion,
    residenceCountryCode,
    employmentStatus: nullableEmploymentStatusAt(
      user.employmentStatus,
      `${path}.employmentStatus`,
    ),
    firstName: nullableStringAt(user.firstName, `${path}.firstName`),
    lastName: nullableStringAt(user.lastName, `${path}.lastName`),
    gender: nullableGenderAt(user.gender, `${path}.gender`),
    avatar: nullableStringAt(user.avatar, `${path}.avatar`),
    homeAddress: nullableStringAt(user.homeAddress, `${path}.homeAddress`),
    isAtCloudLeader: booleanAt(
      user.isAtCloudLeader,
      `${path}.isAtCloudLeader`,
    ),
    roleInAtCloud: nullableStringAt(
      user.roleInAtCloud,
      `${path}.roleInAtCloud`,
    ),
    occupation: nullableStringAt(user.occupation, `${path}.occupation`),
    company: nullableStringAt(user.company, `${path}.company`),
    weeklyChurch: nullableStringAt(
      user.weeklyChurch,
      `${path}.weeklyChurch`,
    ),
    churchAddress: nullableStringAt(
      user.churchAddress,
      `${path}.churchAddress`,
    ),
    role: roleAt(user.role, `${path}.role`),
    isActive: booleanAt(user.isActive, `${path}.isActive`),
    isVerified: booleanAt(user.isVerified, `${path}.isVerified`),
    emailNotifications: booleanAt(
      user.emailNotifications,
      `${path}.emailNotifications`,
    ),
    lastLogin: nullableStringAt(user.lastLogin, `${path}.lastLogin`),
    createdAt: nullableStringAt(user.createdAt, `${path}.createdAt`),
    updatedAt: nullableStringAt(user.updatedAt, `${path}.updatedAt`),
  };
}

const COMMUNITY_MEMBER_KEYS = [
  "id",
  "username",
  "firstName",
  "lastName",
  "avatar",
  "gender",
  "roleInAtCloud",
] as const;

export function decodeCommunityMember(
  value: unknown,
  path = "data.member",
): CommunityMemberDTO {
  const member = exactObjectAt(value, path, COMMUNITY_MEMBER_KEYS);
  return {
    id: stringAt(member.id, `${path}.id`),
    username: stringAt(member.username, `${path}.username`),
    firstName: nullableStringAt(member.firstName, `${path}.firstName`),
    lastName: nullableStringAt(member.lastName, `${path}.lastName`),
    avatar: nullableStringAt(member.avatar, `${path}.avatar`),
    gender: nullableGenderAt(member.gender, `${path}.gender`),
    roleInAtCloud: nullableStringAt(
      member.roleInAtCloud,
      `${path}.roleInAtCloud`,
    ),
  };
}

const USER_OPTION_KEYS = [
  "id",
  "username",
  "firstName",
  "lastName",
  "avatar",
  "gender",
  "role",
  "roleInAtCloud",
] as const;

export function decodeUserPicker(
  value: unknown,
  path = "data.option",
): UserPickerDTO {
  const option = exactObjectAt(value, path, USER_OPTION_KEYS);
  return {
    id: stringAt(option.id, `${path}.id`),
    username: stringAt(option.username, `${path}.username`),
    firstName: nullableStringAt(option.firstName, `${path}.firstName`),
    lastName: nullableStringAt(option.lastName, `${path}.lastName`),
    avatar: nullableStringAt(option.avatar, `${path}.avatar`),
    gender: nullableGenderAt(option.gender, `${path}.gender`),
    role: roleAt(option.role, `${path}.role`),
    roleInAtCloud: nullableStringAt(
      option.roleInAtCloud,
      `${path}.roleInAtCloud`,
    ),
  };
}

function decodePagination(
  value: unknown,
  path: string,
  totalKey: "totalUsers" | "totalMembers" | "totalOptions",
) {
  const pagination = exactObjectAt(value, path, [
    "currentPage",
    "totalPages",
    totalKey,
    "hasNext",
    "hasPrev",
  ]);
  return {
    currentPage: positiveIntegerAt(
      pagination.currentPage,
      `${path}.currentPage`,
    ),
    totalPages: nonnegativeIntegerAt(
      pagination.totalPages,
      `${path}.totalPages`,
    ),
    total: nonnegativeIntegerAt(pagination[totalKey], `${path}.${totalKey}`),
    hasNext: booleanAt(pagination.hasNext, `${path}.hasNext`),
    hasPrev: booleanAt(pagination.hasPrev, `${path}.hasPrev`),
  };
}

export function decodeAdminUsersPage(value: unknown): AdminUsersPageDTO {
  const data = exactObjectAt(value, "data", ["users", "pagination"]);
  const pagination = decodePagination(
    data.pagination,
    "data.pagination",
    "totalUsers",
  );
  return {
    users: arrayAt(data.users, "data.users", decodeAdminUser),
    pagination: {
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      totalUsers: pagination.total,
      hasNext: pagination.hasNext,
      hasPrev: pagination.hasPrev,
    },
  };
}

export function decodeAdminUserDetail(value: unknown): AdminUserDTO {
  const data = exactObjectAt(value, "data", ["user"]);
  return decodeAdminUser(data.user);
}

export function decodeCommunityMembersPage(
  value: unknown,
): CommunityMembersPageDTO {
  const data = exactObjectAt(value, "data", ["members", "pagination"]);
  const pagination = decodePagination(
    data.pagination,
    "data.pagination",
    "totalMembers",
  );
  return {
    members: arrayAt(data.members, "data.members", decodeCommunityMember),
    pagination: {
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      totalMembers: pagination.total,
      hasNext: pagination.hasNext,
      hasPrev: pagination.hasPrev,
    },
  };
}

export function decodeCommunityMemberDetail(
  value: unknown,
): CommunityMemberDTO {
  const data = exactObjectAt(value, "data", ["member"]);
  return decodeCommunityMember(data.member);
}

export function decodeUserOptionsPage(value: unknown): UserOptionsPageDTO {
  const data = exactObjectAt(value, "data", ["options", "pagination"]);
  const pagination = decodePagination(
    data.pagination,
    "data.pagination",
    "totalOptions",
  );
  return {
    options: arrayAt(data.options, "data.options", decodeUserPicker),
    pagination: {
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      totalOptions: pagination.total,
      hasNext: pagination.hasNext,
      hasPrev: pagination.hasPrev,
    },
  };
}
