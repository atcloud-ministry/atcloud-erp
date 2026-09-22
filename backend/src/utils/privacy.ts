import crypto from "crypto";
import { hasPermission, PERMISSIONS } from "./roleUtils";

/** Hash email with sha256 after trimming & lowercasing (PII minimization). */
export function hashEmail(email: string): string {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/**
 * Truncate an IP address to a coarse CIDR for privacy while allowing pattern detection.
 *  - IPv4: a.b.c.0/24
 *  - IPv6: first 3 hextets ::/48
 */
export function truncateIpToCidr(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const v4Match = ip.match(/(?:(?:\d{1,3}\.){3}\d{1,3})/);
  if (v4Match) {
    const parts = v4Match[0].split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  if (ip.includes(":")) {
    const cleaned = ip.split("%")[0];
    const hextets = cleaned.split(":").filter(Boolean);
    if (hextets.length >= 3) {
      return `${hextets[0]}:${hextets[1]}:${hextets[2]}::/48`;
    }
  }
  return null;
}

/**
 * Sensitive contact fields that should be stripped for unauthorized users
 */
const SENSITIVE_CONTACT_FIELDS = ["email", "phone"] as const;

/**
 * Represents a user object that may contain sensitive contact information
 */
interface UserWithContact {
  email?: string;
  phone?: string;
  birthYear?: number;
  [key: string]: unknown;
}

/**
 * Exact phone numbers and birth years are account-private fields. They may be
 * returned only to the account owner or a caller with user-management access.
 */
export function canViewExactPrivateProfileFields(
  viewerId: unknown,
  viewerRole: string | undefined,
  subjectId: unknown,
): boolean {
  const normalizedViewerId = viewerId == null ? "" : String(viewerId);
  const normalizedSubjectId = subjectId == null ? "" : String(subjectId);

  return (
    (normalizedViewerId.length > 0 &&
      normalizedViewerId === normalizedSubjectId) ||
    hasPermission(viewerRole || "", PERMISSIONS.MANAGE_USERS)
  );
}

/** Return a shallow copy without account-private exact values. */
export function stripExactPrivateProfileFields<T extends UserWithContact>(
  user: T,
): Omit<T, "phone" | "birthYear"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { phone: _phone, birthYear: _birthYear, ...sanitized } = user;
  return sanitized as Omit<T, "phone" | "birthYear">;
}

/**
 * Represents a participant object containing a user with possible contact info
 */
interface ParticipantWithUser {
  user: UserWithContact;
  [key: string]: unknown;
}

/**
 * Strip sensitive contact information from a user object.
 * Returns a new object without email/phone fields.
 */
export function stripContactInfo<T extends UserWithContact>(
  user: T,
): Omit<T, "email" | "phone"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { email: _email, phone: _phone, ...sanitized } = user;
  return sanitized as Omit<T, "email" | "phone">;
}

/**
 * Strip sensitive contact information from a mentor object.
 * Mentors are stored as embedded documents in programs.
 */
export function sanitizeMentor<T extends UserWithContact>(
  mentor: T,
  canViewContact: boolean,
): T | Omit<T, "email" | "phone"> {
  if (canViewContact) {
    return mentor;
  }
  return stripContactInfo(mentor);
}

/**
 * Strip sensitive contact information from a list of mentors.
 */
export function sanitizeMentors<T extends UserWithContact>(
  mentors: T[],
  canViewContact: boolean,
): (T | Omit<T, "email" | "phone">)[] {
  if (canViewContact) {
    return mentors;
  }
  return mentors.map((m) => stripContactInfo(m));
}

/**
 * Strip sensitive contact information from a participant object.
 * Participants have a nested user object.
 */
export function sanitizeParticipant<T extends ParticipantWithUser>(
  participant: T,
  canViewContact: boolean,
): T {
  if (canViewContact) {
    return participant;
  }
  return {
    ...participant,
    user: stripContactInfo(participant.user),
  };
}

/**
 * Strip sensitive contact information from a list of participants.
 */
export function sanitizeParticipants<T extends ParticipantWithUser>(
  participants: T[],
  canViewContact: boolean,
): T[] {
  if (canViewContact) {
    return participants;
  }
  return participants.map((p) => sanitizeParticipant(p, false));
}

export default {
  hashEmail,
  truncateIpToCidr,
  stripContactInfo,
  canViewExactPrivateProfileFields,
  stripExactPrivateProfileFields,
  sanitizeMentor,
  sanitizeMentors,
  sanitizeParticipant,
  sanitizeParticipants,
  SENSITIVE_CONTACT_FIELDS,
};
