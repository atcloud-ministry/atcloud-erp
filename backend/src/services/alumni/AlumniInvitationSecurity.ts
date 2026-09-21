import { createHash, createHmac, timingSafeEqual } from "crypto";
import {
  ALUMNI_CONTACT_LOOKUP_VERSION,
  ALUMNI_INVITATION_TOKEN_VERSION,
  readAlumniContactLookupKey,
  readAlumniInvitationTokenKey,
} from "../../config/alumniInvitationSecurity";

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const ALUMNI_INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CONTACT_LOOKUP_DOMAIN = "atcloud:alumni-contact:v1\0";
const INVITATION_TOKEN_DOMAIN = "atcloud:alumni-invitation:v1\0";
const INVITATION_TOKEN_HASH_DOMAIN =
  "atcloud:alumni-invitation-hash:v1\0";

export interface AlumniInvitationTokenMaterial {
  readonly invitationId: string;
  readonly issueCount: number;
  readonly issuedAt: Date;
  readonly tokenVersion?: number;
}

export interface AlumniInvitationSecurityKeyReaders {
  readonly readContactLookupKey: (version: number) => Buffer;
  readonly readInvitationTokenKey: (version: number) => Buffer;
}

const DEFAULT_KEY_READERS: AlumniInvitationSecurityKeyReaders = Object.freeze({
  readContactLookupKey: (version: number) =>
    readAlumniContactLookupKey(version),
  readInvitationTokenKey: (version: number) =>
    readAlumniInvitationTokenKey(version),
});

export function normalizeAlumniContactEmail(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Invalid alumni contact email.");
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    !EMAIL_PATTERN.test(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new TypeError("Invalid alumni contact email.");
  }
  return normalized;
}

function requireTokenMaterial(
  input: AlumniInvitationTokenMaterial,
): Required<AlumniInvitationTokenMaterial> {
  const invitationId = input.invitationId.trim().toLowerCase();
  if (!OBJECT_ID_PATTERN.test(invitationId)) {
    throw new TypeError("Invalid alumni invitation id.");
  }
  if (
    !Number.isSafeInteger(input.issueCount) ||
    input.issueCount < 1 ||
    input.issueCount >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError("Invalid alumni invitation issue count.");
  }
  if (
    !(input.issuedAt instanceof Date) ||
    Number.isNaN(input.issuedAt.getTime())
  ) {
    throw new TypeError("Invalid alumni invitation issuedAt.");
  }
  const tokenVersion =
    input.tokenVersion ?? ALUMNI_INVITATION_TOKEN_VERSION;
  if (tokenVersion !== ALUMNI_INVITATION_TOKEN_VERSION) {
    throw new TypeError("Unsupported alumni invitation token version.");
  }
  return Object.freeze({
    invitationId,
    issueCount: input.issueCount,
    issuedAt: new Date(input.issuedAt.getTime()),
    tokenVersion,
  });
}

/** Canonicalized keyed digest used for exact roster/account matching. */
export function deriveAlumniContactLookupHash(
  email: string,
  version: number = ALUMNI_CONTACT_LOOKUP_VERSION,
  keyReaders: AlumniInvitationSecurityKeyReaders = DEFAULT_KEY_READERS,
): string {
  if (version !== ALUMNI_CONTACT_LOOKUP_VERSION) {
    throw new TypeError("Unsupported alumni contact lookup version.");
  }
  return createHmac("sha256", keyReaders.readContactLookupKey(version))
    .update(CONTACT_LOOKUP_DOMAIN, "utf8")
    .update(normalizeAlumniContactEmail(email), "utf8")
    .digest("hex");
}

/**
 * A one-time bearer credential that can be re-created by the delivery worker.
 * Only its domain-separated hash is persisted on AlumniInvitation.
 */
export function deriveAlumniInvitationToken(
  rawInput: AlumniInvitationTokenMaterial,
  keyReaders: AlumniInvitationSecurityKeyReaders = DEFAULT_KEY_READERS,
): string {
  const input = requireTokenMaterial(rawInput);
  return createHmac(
    "sha256",
    keyReaders.readInvitationTokenKey(input.tokenVersion),
  )
    .update(INVITATION_TOKEN_DOMAIN, "utf8")
    .update(input.invitationId, "utf8")
    .update("\0", "utf8")
    .update(String(input.issueCount), "utf8")
    .update("\0", "utf8")
    .update(input.issuedAt.toISOString(), "utf8")
    .digest("base64url");
}

export function hashAlumniInvitationToken(token: string): string {
  if (
    typeof token !== "string" ||
    !ALUMNI_INVITATION_TOKEN_PATTERN.test(token)
  ) {
    throw new TypeError("Invalid alumni invitation token.");
  }
  return createHash("sha256")
    .update(INVITATION_TOKEN_HASH_DOMAIN, "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function alumniInvitationTokenHashMatches(
  token: string,
  expectedHash: string,
): boolean {
  if (
    typeof expectedHash !== "string" ||
    !SHA256_PATTERN.test(expectedHash)
  ) {
    return false;
  }
  let actualHash: string;
  try {
    actualHash = hashAlumniInvitationToken(token);
  } catch {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actualHash, "hex"),
    Buffer.from(expectedHash, "hex"),
  );
}
