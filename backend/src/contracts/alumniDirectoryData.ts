import { createHash } from "crypto";
import { normalizeDisplayText } from "@atcloud/shared-time/registration-profile";

export const ALUMNI_PROFILE_PUBLISH_STATUSES = [
  "draft",
  "published",
  "withdrawn",
] as const;

export type AlumniProfilePublishStatus =
  (typeof ALUMNI_PROFILE_PUBLISH_STATUSES)[number];

export const ALUMNI_AFFILIATION_VERIFICATION_STATUSES = [
  "pending_review",
  "verified",
  "rejected",
] as const;

export type AlumniAffiliationVerificationStatus =
  (typeof ALUMNI_AFFILIATION_VERIFICATION_STATUSES)[number];

export const ALUMNI_INVITATION_STATUSES = [
  "active",
  "claimed",
  "invalidated",
] as const;

export type AlumniInvitationStatus =
  (typeof ALUMNI_INVITATION_STATUSES)[number];

export const ALUMNI_IMPORT_BATCH_STATUSES = [
  "pending",
  "dry_running",
  "review_ready",
  "applying",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AlumniImportBatchStatus =
  (typeof ALUMNI_IMPORT_BATCH_STATUSES)[number];

export const ALUMNI_IMPORT_ROW_MATCH_STATUSES = [
  "matched",
  "unmatched",
  "ambiguous",
  "invalid",
] as const;

export type AlumniImportRowMatchStatus =
  (typeof ALUMNI_IMPORT_ROW_MATCH_STATUSES)[number];

export const ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES = [
  "not_applicable",
  "pending_review",
  "approved",
  "rejected",
] as const;

export type AlumniImportRowEligibilityStatus =
  (typeof ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES)[number];

export const ALUMNI_IMPORT_ROW_APPLICATION_STATUSES = [
  "pending",
  "applied",
  "skipped",
  "failed",
] as const;

export type AlumniImportRowApplicationStatus =
  (typeof ALUMNI_IMPORT_ROW_APPLICATION_STATUSES)[number];

export const ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly AlumniImportBatchStatus[];

export const CONSENT_RECORD_PURPOSES = [
  "alumni_profile_publication",
] as const;

export type ConsentRecordPurpose =
  (typeof CONSENT_RECORD_PURPOSES)[number];

export const CONSENT_RECORD_STATUSES = [
  "active",
  "superseded",
  "withdrawn",
  "account_deleted",
] as const;

export type ConsentRecordStatus =
  (typeof CONSENT_RECORD_STATUSES)[number];

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const SAFE_SINGLE_LINE_PATTERN = /^[^\u0000-\u001f\u007f-\u009f]*$/u;
export const SAFE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
export const INVITATION_TOKEN_LIFETIME_DAYS = 14;
export const ACCOUNT_DELETION_RETENTION_DAYS = 30;
export const IMPORT_RAW_DATA_RETENTION_DAYS = 30;
export const INVITATION_CONTACT_RETENTION_MONTHS = 6;
export const IMPORT_SUMMARY_RETENTION_MONTHS = 6;
export const CONSENT_RECORD_RETENTION_MONTHS = 12;

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function addFixedDays(value: Date, days: number): Date {
  if (!Number.isSafeInteger(days)) {
    throw new TypeError("days must be a safe integer");
  }
  return new Date(value.getTime() + days * MILLISECONDS_PER_DAY);
}

export function isWithinFixedDayRetention(
  purgeAt: Date | null | undefined,
  startsAt: Date,
  maximumDays: number,
): boolean {
  return (
    purgeAt instanceof Date &&
    purgeAt >= startsAt &&
    purgeAt <= addFixedDays(startsAt, maximumDays)
  );
}

/** Add UTC calendar months while clamping dates such as August 31 to month end. */
export function addUtcCalendarMonths(value: Date, months: number): Date {
  if (!Number.isSafeInteger(months)) {
    throw new TypeError("months must be a safe integer");
  }

  const target = new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months,
      1,
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}

export function datesEqual(left: Date | null | undefined, right: Date): boolean {
  return left instanceof Date && left.getTime() === right.getTime();
}

export function isTerminalAlumniImportBatchStatus(
  status: AlumniImportBatchStatus,
): boolean {
  return (ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}

export interface AlumniAffiliationIdentityInput {
  programName: string;
  cohortLabel?: string | null;
}

export interface AlumniProgramAffiliationIdentityInput {
  programId: string;
  cohortLabel?: string | null;
}

function normalizeAlumniIdentityText(value: string): string {
  return normalizeDisplayText(value).normalize("NFKC").toLowerCase();
}

/** Stable, domain-separated identity based on the canonical program name/cohort. */
export function deriveAlumniAffiliationKey(
  input: AlumniAffiliationIdentityInput,
): string {
  const programIdentity = normalizeAlumniIdentityText(input.programName);
  const cohortIdentity = normalizeAlumniIdentityText(input.cohortLabel ?? "");
  return createHash("sha256")
    .update("atcloud:alumni-affiliation:v1\0", "utf8")
    .update(programIdentity, "utf8")
    .update("\0", "utf8")
    .update(cohortIdentity, "utf8")
    .digest("hex");
}

/** Stable companion identity that also deduplicates renamed canonical Programs. */
export function deriveAlumniProgramAffiliationKey(
  input: AlumniProgramAffiliationIdentityInput,
): string {
  const programIdentity = input.programId.trim().toLowerCase();
  const cohortIdentity = normalizeAlumniIdentityText(input.cohortLabel ?? "");
  return createHash("sha256")
    .update("atcloud:alumni-program-affiliation:v1\0", "utf8")
    .update(programIdentity, "utf8")
    .update("\0", "utf8")
    .update(cohortIdentity, "utf8")
    .digest("hex");
}
