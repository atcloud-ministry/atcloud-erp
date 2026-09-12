import { timingSafeEqual } from "crypto";

export const ALUMNI_CONTACT_LOOKUP_KEY_ENV =
  "ALUMNI_CONTACT_LOOKUP_KEY_V1" as const;
export const ALUMNI_INVITATION_TOKEN_KEY_ENV =
  "ALUMNI_INVITATION_TOKEN_KEY_V1" as const;

export const ALUMNI_CONTACT_LOOKUP_VERSION = 1 as const;
export const ALUMNI_INVITATION_TOKEN_VERSION = 1 as const;

const BASE64URL_256_BIT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_BYTES = 32;

export class AlumniInvitationSecurityConfigurationError extends Error {
  readonly name = "AlumniInvitationSecurityConfigurationError";
  readonly code = "ALUMNI_INVITATION_SECURITY_CONFIGURATION_INVALID";

  constructor(public readonly setting: string) {
    super(`Alumni invitation security setting ${setting} is invalid.`);
  }
}

function read256BitKey(
  environment: NodeJS.ProcessEnv,
  name: typeof ALUMNI_CONTACT_LOOKUP_KEY_ENV | typeof ALUMNI_INVITATION_TOKEN_KEY_ENV,
): Buffer {
  const encoded = environment[name];
  if (
    typeof encoded !== "string" ||
    encoded !== encoded.trim() ||
    !BASE64URL_256_BIT_KEY_PATTERN.test(encoded)
  ) {
    throw new AlumniInvitationSecurityConfigurationError(name);
  }

  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.length !== KEY_BYTES ||
    decoded.toString("base64url") !== encoded
  ) {
    throw new AlumniInvitationSecurityConfigurationError(name);
  }
  return decoded;
}

export function readAlumniContactLookupKey(
  version: number,
  environment: NodeJS.ProcessEnv = process.env,
): Buffer {
  if (version !== ALUMNI_CONTACT_LOOKUP_VERSION) {
    throw new AlumniInvitationSecurityConfigurationError(
      `contact-lookup-v${String(version)}`,
    );
  }
  return read256BitKey(environment, ALUMNI_CONTACT_LOOKUP_KEY_ENV);
}

export function readAlumniInvitationTokenKey(
  version: number,
  environment: NodeJS.ProcessEnv = process.env,
): Buffer {
  if (version !== ALUMNI_INVITATION_TOKEN_VERSION) {
    throw new AlumniInvitationSecurityConfigurationError(
      `invitation-token-v${String(version)}`,
    );
  }
  return read256BitKey(environment, ALUMNI_INVITATION_TOKEN_KEY_ENV);
}

/**
 * Fail closed before an alumni-enabled deployment accepts traffic. Secrets are
 * deliberately independent and have no JWT/session/development fallback.
 */
export function assertAlumniInvitationSecurityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const contactKey = readAlumniContactLookupKey(
    ALUMNI_CONTACT_LOOKUP_VERSION,
    environment,
  );
  const tokenKey = readAlumniInvitationTokenKey(
    ALUMNI_INVITATION_TOKEN_VERSION,
    environment,
  );
  if (
    contactKey.length === tokenKey.length &&
    timingSafeEqual(contactKey, tokenKey)
  ) {
    throw new AlumniInvitationSecurityConfigurationError(
      "alumni-key-separation",
    );
  }
}

/** Alumni invitation issuance is unavailable without its durable email worker. */
export function assertAlumniInvitationReleaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertAlumniInvitationSecurityConfiguration(environment);
  if (environment.NOTIFICATION_OUTBOX_ENABLED !== "true") {
    throw new AlumniInvitationSecurityConfigurationError(
      "NOTIFICATION_OUTBOX_ENABLED",
    );
  }
}
