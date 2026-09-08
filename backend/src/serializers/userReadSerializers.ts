import {
  type AdminUserDTO,
  type CommunityMemberDTO,
  type UserPickerDTO,
} from "../contracts/userReadContracts";
import { ROLES, type UserRole } from "../utils/roleUtils";

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
