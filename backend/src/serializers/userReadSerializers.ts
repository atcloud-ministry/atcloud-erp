import {
  type AdminUserDTO,
  type CommunityMemberDTO,
  type SelfUserDTO,
  type UserPickerDTO,
} from "../contracts/userReadContracts";
import { ROLES, type UserRole } from "../utils/roleUtils";
import {
  isBirthYear,
  isEmploymentStatus,
  isIsoCountryCode,
} from "@atcloud/shared-time/registration-profile";

export const COMMUNITY_MEMBER_PROJECTION = [
  "username",
  "firstName",
  "lastName",
  "avatar",
  "gender",
  "roleInAtCloud",
].join(" ");

export const ADMIN_USER_PROJECTION = [
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
].join(" ");

/** Explicitly opts the private, schema-hidden birthYear into admin queries. */
export const ADMIN_USER_QUERY_PROJECTION = `${ADMIN_USER_PROJECTION} +birthYear`;

/** Default User selection plus the private field required by owner reads. */
export const SELF_USER_QUERY_PROJECTION = "+birthYear";

export const USER_PICKER_PROJECTION = [
  "username",
  "firstName",
  "lastName",
  "avatar",
  "gender",
  "role",
  "roleInAtCloud",
].join(" ");

type UserSource = Record<string, unknown>;

function asSource(value: unknown): UserSource {
  if (value && typeof value === "object") {
    const maybeDocument = value as { toObject?: () => unknown };
    if (typeof maybeDocument.toObject === "function") {
      const objectValue = maybeDocument.toObject();
      if (objectValue && typeof objectValue === "object") {
        return objectValue as UserSource;
      }
    }
    return value as UserSource;
  }
  return {};
}

function idOf(source: UserSource): string {
  const value = source._id ?? source.id;
  return value == null ? "" : String(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function dateString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function genderValue(value: unknown): "male" | "female" | null {
  return value === "male" || value === "female" ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function roleValue(value: unknown): UserRole {
  return Object.values(ROLES).includes(value as UserRole)
    ? (value as UserRole)
    : ROLES.PARTICIPANT;
}

export function serializeCommunityMember(value: unknown): CommunityMemberDTO {
  const source = asSource(value);
  return {
    id: idOf(source),
    username: typeof source.username === "string" ? source.username : "",
    firstName: nullableString(source.firstName),
    lastName: nullableString(source.lastName),
    avatar: nullableString(source.avatar),
    gender: genderValue(source.gender),
    roleInAtCloud: nullableString(source.roleInAtCloud),
  };
}

export function serializeAdminUser(value: unknown): AdminUserDTO {
  const source = asSource(value);
  return {
    id: idOf(source),
    username: typeof source.username === "string" ? source.username : "",
    email: typeof source.email === "string" ? source.email : "",
    phone: nullableString(source.phone),
    birthYear: isBirthYear(source.birthYear) ? source.birthYear : null,
    residenceCity: nullableString(source.residenceCity),
    residenceRegion: nullableString(source.residenceRegion),
    residenceCountryCode: isIsoCountryCode(source.residenceCountryCode)
      ? source.residenceCountryCode
      : null,
    employmentStatus: isEmploymentStatus(source.employmentStatus)
      ? source.employmentStatus
      : null,
    firstName: nullableString(source.firstName),
    lastName: nullableString(source.lastName),
    gender: genderValue(source.gender),
    avatar: nullableString(source.avatar),
    homeAddress: nullableString(source.homeAddress),
    isAtCloudLeader: booleanValue(source.isAtCloudLeader),
    roleInAtCloud: nullableString(source.roleInAtCloud),
    occupation: nullableString(source.occupation),
    company: nullableString(source.company),
    weeklyChurch: nullableString(source.weeklyChurch),
    churchAddress: nullableString(source.churchAddress),
    role: roleValue(source.role),
    isActive: source.isActive !== false,
    isVerified: booleanValue(source.isVerified),
    emailNotifications: source.emailNotifications !== false,
    lastLogin: dateString(source.lastLogin),
    createdAt: dateString(source.createdAt),
    updatedAt: dateString(source.updatedAt),
  };
}

export function serializeSelfUser(value: unknown): SelfUserDTO {
  const source = asSource(value);
  return {
    id: idOf(source),
    username: typeof source.username === "string" ? source.username : "",
    email: typeof source.email === "string" ? source.email : "",
    phone: optionalString(source.phone),
    birthYear: isBirthYear(source.birthYear) ? source.birthYear : undefined,
    residenceCity: optionalString(source.residenceCity),
    residenceRegion:
      source.residenceRegion === null
        ? null
        : optionalString(source.residenceRegion),
    residenceCountryCode: isIsoCountryCode(source.residenceCountryCode)
      ? source.residenceCountryCode
      : undefined,
    employmentStatus: isEmploymentStatus(source.employmentStatus)
      ? source.employmentStatus
      : undefined,
    firstName: optionalString(source.firstName),
    lastName: optionalString(source.lastName),
    gender:
      source.gender === "male" || source.gender === "female"
        ? source.gender
        : undefined,
    avatar: optionalString(source.avatar),
    role: roleValue(source.role),
    isAtCloudLeader: optionalBoolean(source.isAtCloudLeader, false),
    roleInAtCloud: optionalString(source.roleInAtCloud),
    occupation:
      source.occupation === null ? null : optionalString(source.occupation),
    company: source.company === null ? null : optionalString(source.company),
    weeklyChurch: optionalString(source.weeklyChurch),
    homeAddress: optionalString(source.homeAddress),
    churchAddress: optionalString(source.churchAddress),
    lastLogin:
      source.lastLogin instanceof Date || typeof source.lastLogin === "string"
        ? source.lastLogin
        : undefined,
    createdAt:
      source.createdAt instanceof Date || typeof source.createdAt === "string"
        ? source.createdAt
        : undefined,
    isVerified: optionalBoolean(source.isVerified, false),
    isActive: optionalBoolean(source.isActive, true),
  };
}

export function serializeUserPicker(value: unknown): UserPickerDTO {
  const source = asSource(value);
  return {
    id: idOf(source),
    username: typeof source.username === "string" ? source.username : "",
    firstName: nullableString(source.firstName),
    lastName: nullableString(source.lastName),
    avatar: nullableString(source.avatar),
    gender: genderValue(source.gender),
    role: roleValue(source.role),
    roleInAtCloud: nullableString(source.roleInAtCloud),
  };
}
