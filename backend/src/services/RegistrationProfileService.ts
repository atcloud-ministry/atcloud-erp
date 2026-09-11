import {
  REGISTRATION_PROFILE_FIELDS,
  validateRegistrationProfile,
  type RegistrationProfileField,
  type RegistrationProfileFields,
  type RegistrationProfileInput,
  type RegistrationProfileValidationIssue,
} from "@atcloud/shared-time/registration-profile";
import { User } from "../models";

type RegistrationProfileSource = Partial<
  Record<RegistrationProfileField | "homeAddress", unknown>
>;

export interface RegistrationProfileReadiness {
  ready: boolean;
  issues: RegistrationProfileValidationIssue[];
}

export class RegistrationProfileNotReadyError extends Error {
  readonly issues: RegistrationProfileValidationIssue[];

  constructor(issues: RegistrationProfileValidationIssue[]) {
    super("A complete registration profile is required before publishing.");
    this.name = "RegistrationProfileNotReadyError";
    this.issues = issues;
  }
}

export class RegistrationProfileUserNotFoundError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super("User not found while checking registration profile readiness.");
    this.name = "RegistrationProfileUserNotFoundError";
    this.userId = userId;
  }
}

export const REGISTRATION_PROFILE_READ_PROJECTION = [
  ...REGISTRATION_PROFILE_FIELDS.filter((field) => field !== "birthYear"),
  "+birthYear",
].join(" ");

function hasOwn(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

/** Build the shared-validator input without leaking unrelated User fields. */
export function registrationProfileInputFrom(
  source: RegistrationProfileSource,
): RegistrationProfileInput {
  return Object.fromEntries(
    REGISTRATION_PROFILE_FIELDS.map((field) => [field, source[field]]),
  ) as RegistrationProfileInput;
}

/** True when an API request deliberately edits at least one profile-contract field. */
export function containsRegistrationProfileUpdate(
  source: RegistrationProfileSource,
): boolean {
  return REGISTRATION_PROFILE_FIELDS.some((field) => hasOwn(source, field));
}

/**
 * Validate an edit against the persisted document. This lets complete profiles
 * accept partial API edits while keeping legacy accounts in their completion
 * grace period until a profile-contract field is deliberately submitted.
 */
export function validateMergedRegistrationProfile(
  persisted: RegistrationProfileSource,
  submitted: RegistrationProfileSource,
  now = new Date(),
) {
  const merged = Object.fromEntries(
    REGISTRATION_PROFILE_FIELDS.map((field) => [
      field,
      hasOwn(submitted, field) ? submitted[field] : persisted[field],
    ]),
  ) as RegistrationProfileInput;
  return validateRegistrationProfile(merged, now);
}

/** Apply canonical shared-validator output and retire the legacy address. */
export function applyCanonicalRegistrationProfile(
  target: RegistrationProfileSource,
  profile: RegistrationProfileFields,
): void {
  for (const field of REGISTRATION_PROFILE_FIELDS) {
    target[field] = profile[field];
  }
  target.homeAddress = undefined;
}

/** Reusable readiness result for the Alumni Profile publish flow. */
export function getRegistrationProfileReadiness(
  source: RegistrationProfileSource,
  now = new Date(),
): RegistrationProfileReadiness {
  const result = validateRegistrationProfile(
    registrationProfileInputFrom(source),
    now,
  );
  return result.success
    ? { ready: true, issues: [] }
    : { ready: false, issues: result.issues };
}

/** Guard for the Alumni Profile publish service introduced in M2. */
export function assertRegistrationProfileReadyForAlumniPublish(
  source: RegistrationProfileSource,
  now = new Date(),
): void {
  const readiness = getRegistrationProfileReadiness(source, now);
  if (!readiness.ready) {
    throw new RegistrationProfileNotReadyError(readiness.issues);
  }
}

/**
 * Load publish readiness from storage so schema-hidden birthYear is always
 * available; callers must not rely on an authentication-token user snapshot.
 */
export async function getRegistrationProfileReadinessByUserId(
  userId: string,
  now = new Date(),
): Promise<RegistrationProfileReadiness> {
  const source = await User.findById(userId)
    .select(REGISTRATION_PROFILE_READ_PROJECTION)
    .lean();
  if (!source) {
    throw new RegistrationProfileUserNotFoundError(userId);
  }
  return getRegistrationProfileReadiness(
    source as unknown as RegistrationProfileSource,
    now,
  );
}

/** Storage-backed guard for the Alumni Profile publish flow introduced in M2. */
export async function assertRegistrationProfileReadyForAlumniPublishByUserId(
  userId: string,
  now = new Date(),
): Promise<void> {
  const readiness = await getRegistrationProfileReadinessByUserId(userId, now);
  if (!readiness.ready) {
    throw new RegistrationProfileNotReadyError(readiness.issues);
  }
}
