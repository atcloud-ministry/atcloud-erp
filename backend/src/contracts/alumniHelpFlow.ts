import {
  codePointLength,
  isValidDisplayText,
  normalizeDisplayText,
} from "@atcloud/shared-time/registration-profile";
import { ALUMNI_HELP_TERMS } from "../config/alumniHelpTerms";
import {
  addFixedDays,
  addUtcCalendarMonths,
  MILLISECONDS_PER_DAY,
} from "./alumniDirectoryData";

export const ALUMNI_HELP_TYPES = [
  "career_advice",
  "warm_introduction",
  "formal_employee_referral",
] as const;
export type AlumniHelpType = (typeof ALUMNI_HELP_TYPES)[number];

export const ALUMNI_HELP_REQUEST_STATUSES = [
  "requested",
  "needs_information",
  "alternative_proposed",
  "accepted",
  "declined",
  "withdrawn",
  "in_progress",
  "completed",
  "closed",
] as const;
export type AlumniHelpRequestStatus =
  (typeof ALUMNI_HELP_REQUEST_STATUSES)[number];

export const ALUMNI_HELP_ACTIVE_REQUEST_STATUSES = [
  "requested",
  "needs_information",
  "alternative_proposed",
  "accepted",
  "in_progress",
  "completed",
] as const satisfies readonly AlumniHelpRequestStatus[];

export const ALUMNI_HELP_TERMINAL_REQUEST_STATUSES = [
  "declined",
  "withdrawn",
  "closed",
] as const satisfies readonly AlumniHelpRequestStatus[];

export const ALUMNI_HELP_LIFECYCLE_ACTIONS = [
  "create",
  "request_information",
  "provide_information",
  "propose_alternative",
  "confirm_alternative",
  "reject_alternative",
  "accept",
  "decline",
  "withdraw",
  "start",
  "complete",
  "close",
  "outcome_confirm",
  "outcome_auto_confirm",
  "outcome_reconcile",
] as const;
export type AlumniHelpLifecycleAction =
  (typeof ALUMNI_HELP_LIFECYCLE_ACTIONS)[number];

export const ALUMNI_HELP_TRANSITION_ACTIONS = [
  "request_information",
  "provide_information",
  "propose_alternative",
  "confirm_alternative",
  "reject_alternative",
  "accept",
  "decline",
  "withdraw",
  "start",
  "complete",
  "close",
] as const;
export type HelpTransitionAction =
  (typeof ALUMNI_HELP_TRANSITION_ACTIONS)[number];

export const ALUMNI_HELP_AVAILABLE_ACTIONS = [
  ...ALUMNI_HELP_TRANSITION_ACTIONS,
  "submit_outcome",
  "resubmit_outcome",
  "confirm_outcome",
  "deny_outcome",
] as const;
export type AlumniHelpAvailableAction =
  (typeof ALUMNI_HELP_AVAILABLE_ACTIONS)[number];

export const ALUMNI_HELP_PARTICIPANT_ROLES = [
  "requester",
  "provider",
] as const;
export type AlumniHelpParticipantRole =
  (typeof ALUMNI_HELP_PARTICIPANT_ROLES)[number];

/**
 * Timeline entries can also record a fixed-deadline outcome confirmation.
 * Keep this separate from participant roles: `system` is never a viewer or
 * an actor authorized to make a participant transition.
 */
export const ALUMNI_HELP_LIFECYCLE_ACTOR_ROLES = [
  ...ALUMNI_HELP_PARTICIPANT_ROLES,
  "system",
] as const;
export type AlumniHelpLifecycleActorRole =
  (typeof ALUMNI_HELP_LIFECYCLE_ACTOR_ROLES)[number];

export const ALUMNI_HELP_LIFECYCLE_TRANSITION_ACTIONS = [
  ...ALUMNI_HELP_TRANSITION_ACTIONS,
  "outcome_confirm",
  "outcome_auto_confirm",
  "outcome_reconcile",
] as const;
export type AlumniHelpLifecycleTransitionAction =
  (typeof ALUMNI_HELP_LIFECYCLE_TRANSITION_ACTIONS)[number];

export const ALUMNI_HELP_OUTCOME_CODES = [
  "not_fulfilled",
  "completed",
  "interview_not_hired",
  "hired_after_interview",
] as const;
export type AlumniHelpOutcomeCode =
  (typeof ALUMNI_HELP_OUTCOME_CODES)[number];

export const ALUMNI_HELP_OUTCOME_STATUSES = [
  "pending",
  "confirmed",
  "denied",
] as const;
export type AlumniHelpOutcomeStatus =
  (typeof ALUMNI_HELP_OUTCOME_STATUSES)[number];

export const ALUMNI_HELP_OUTCOME_CONFIRMATION_METHODS = [
  "provider",
  "automatic_20_day",
] as const;
export type AlumniHelpOutcomeConfirmationMethod =
  (typeof ALUMNI_HELP_OUTCOME_CONFIRMATION_METHODS)[number];

export const ALUMNI_HELP_REQUEST_LIST_VIEWS = [
  "updates",
  "action_required",
  "received",
  "sent",
  "completed",
] as const;
export type AlumniHelpRequestListView =
  (typeof ALUMNI_HELP_REQUEST_LIST_VIEWS)[number];

export const ALUMNI_HELP_FIELD_LIMITS = Object.freeze({
  note: 4_000,
  pageDefault: 20,
  pageMaximum: 100,
});

export const ALUMNI_HELP_OUTCOME_CONFIRMATION_HOURS = 480;
export const ALUMNI_HELP_ROOM_GRACE_DAYS = 7;
export const ALUMNI_HELP_NEVER_ACCEPTED_RETENTION_MONTHS = 2;
export const ALUMNI_HELP_ACCEPTED_RETENTION_MONTHS = 12;
export const ALUMNI_HELP_OUTCOME_RETENTION_SAFETY_DAYS = 30;

export const ALUMNI_HELP_OUTCOMES_BY_TYPE = Object.freeze({
  career_advice: Object.freeze(["not_fulfilled", "completed"]),
  warm_introduction: Object.freeze(["not_fulfilled", "completed"]),
  formal_employee_referral: Object.freeze([
    "not_fulfilled",
    "interview_not_hired",
    "hired_after_interview",
  ]),
} as const satisfies Record<AlumniHelpType, readonly AlumniHelpOutcomeCode[]>);

export const ALUMNI_HELP_TRANSITIONS = Object.freeze({
  request_information: Object.freeze({
    actor: "provider",
    from: Object.freeze(["requested"] as const),
    to: "needs_information",
  }),
  provide_information: Object.freeze({
    actor: "requester",
    from: Object.freeze(["needs_information"] as const),
    to: "requested",
  }),
  propose_alternative: Object.freeze({
    actor: "provider",
    from: Object.freeze(["requested"] as const),
    to: "alternative_proposed",
  }),
  confirm_alternative: Object.freeze({
    actor: "requester",
    from: Object.freeze(["alternative_proposed"] as const),
    to: "accepted",
  }),
  reject_alternative: Object.freeze({
    actor: "requester",
    from: Object.freeze(["alternative_proposed"] as const),
    to: "requested",
  }),
  accept: Object.freeze({
    actor: "provider",
    from: Object.freeze(["requested"] as const),
    to: "accepted",
  }),
  decline: Object.freeze({
    actor: "provider",
    from: Object.freeze([
      "requested",
      "needs_information",
      "alternative_proposed",
    ] as const),
    to: "declined",
  }),
  withdraw: Object.freeze({
    actor: "requester",
    from: Object.freeze([
      "requested",
      "needs_information",
      "alternative_proposed",
    ] as const),
    to: "withdrawn",
  }),
  start: Object.freeze({
    actor: "provider",
    from: Object.freeze(["accepted"] as const),
    to: "in_progress",
  }),
  complete: Object.freeze({
    actor: "provider",
    from: Object.freeze(["accepted", "in_progress"] as const),
    to: "completed",
  }),
  close: Object.freeze({
    actor: "either",
    from: Object.freeze(["accepted", "in_progress", "completed"] as const),
    to: "closed",
  }),
  outcome_confirm: Object.freeze({
    actor: "provider",
    from: Object.freeze(["accepted", "in_progress", "completed"] as const),
    to: "closed",
  }),
  outcome_auto_confirm: Object.freeze({
    actor: "system",
    from: Object.freeze(["accepted", "in_progress", "completed"] as const),
    to: "closed",
  }),
  outcome_reconcile: Object.freeze({
    actor: "system",
    from: Object.freeze(["accepted", "in_progress", "completed"] as const),
    to: "closed",
  }),
} as const satisfies Record<
  AlumniHelpLifecycleTransitionAction,
  {
    readonly actor: AlumniHelpLifecycleActorRole | "either";
    readonly from: readonly AlumniHelpRequestStatus[];
    readonly to: AlumniHelpRequestStatus;
  }
>);

export interface AlumniHelpFlowIssue {
  readonly path: string;
  readonly msg: string;
}

export class AlumniHelpFlowValidationError extends Error {
  readonly name = "AlumniHelpFlowValidationError";
  readonly code = "ALUMNI_HELP_FLOW_INPUT_INVALID";

  constructor(public readonly issues: readonly AlumniHelpFlowIssue[]) {
    super("Validation failed");
  }
}

export interface CreateHelpRequestBody {
  readonly alumniProfileId: string;
  readonly requestedHelpType: AlumniHelpType;
  readonly openingNote?: string;
  readonly consentVersion: string;
  readonly consentAccepted: true;
  readonly disclaimerVersion: string;
  readonly disclaimerAccepted: true;
}

export interface HelpTransitionBody {
  readonly expectedRevision: number;
  readonly note?: string;
  readonly proposedHelpType?: AlumniHelpType;
}

export interface SubmitHelpOutcomeBody {
  readonly expectedRevision: number;
  readonly outcomeCode: AlumniHelpOutcomeCode;
}

export interface OutcomeDecisionBody {
  readonly expectedRevision: number;
}

export interface ReadHelpRequestBody {
  readonly observedRevision: number;
}

export interface HelpRequestListQuery {
  readonly view: AlumniHelpRequestListView;
  readonly page: number;
  readonly limit: number;
}

export interface AlumniHelpParticipantDTO {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: string | null;
}

export interface AlumniHelpLifecycleEventDTO {
  readonly id: string;
  readonly sequence: number;
  readonly action: AlumniHelpLifecycleAction;
  readonly fromStatus: AlumniHelpRequestStatus | null;
  readonly toStatus: AlumniHelpRequestStatus;
  readonly actorRole: AlumniHelpLifecycleActorRole;
  readonly note: string | null;
  readonly helpType: AlumniHelpType | null;
  readonly occurredAt: string;
}

export interface AlumniHelpOutcomeDTO {
  readonly id: string;
  readonly revisionNumber: number;
  readonly previousSubmissionId: string | null;
  readonly agreedHelpType: AlumniHelpType;
  readonly outcomeCode: AlumniHelpOutcomeCode;
  readonly status: AlumniHelpOutcomeStatus;
  readonly submittedAt: string;
  readonly dueAt: string;
  readonly decidedAt: string | null;
  readonly confirmationMethod: AlumniHelpOutcomeConfirmationMethod | null;
  readonly revision: number;
}

export interface AlumniHelpRequestSummaryDTO {
  readonly id: string;
  readonly requester: AlumniHelpParticipantDTO;
  readonly provider: AlumniHelpParticipantDTO;
  readonly status: AlumniHelpRequestStatus;
  readonly requestedHelpType: AlumniHelpType;
  readonly proposedHelpType: AlumniHelpType | null;
  readonly agreedHelpType: AlumniHelpType | null;
  readonly conversationId: string | null;
  readonly viewerRole: AlumniHelpParticipantRole;
  readonly actionRequiredForViewer: boolean;
  readonly hasUnreadUpdate: boolean;
  readonly availableActions: AlumniHelpAvailableAction[];
  readonly latestOutcome: AlumniHelpOutcomeDTO | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface AlumniHelpRequestDTO extends AlumniHelpRequestSummaryDTO {
  readonly alumniProfileId: string;
  readonly openingNote: string | null;
  readonly lifecycleTimeline: AlumniHelpLifecycleEventDTO[];
  readonly outcomes: AlumniHelpOutcomeDTO[];
  readonly availableAlternativeHelpTypes: AlumniHelpType[];
  readonly acceptedAt: string | null;
  readonly declinedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly termsAcceptedAt: string;
  readonly acceptedTerms: AlumniHelpTermsDTO;
}

export interface AlumniHelpTermsDTO {
  readonly consent: {
    readonly version: string;
    readonly text: string;
    readonly effectiveAt: string;
  };
  readonly disclaimer: {
    readonly version: string;
    readonly text: string;
    readonly effectiveAt: string;
  };
}

export interface AlumniHelpPaginationDTO {
  readonly currentPage: number;
  readonly totalPages: number;
  readonly totalCount: number;
  readonly hasNext: boolean;
  readonly hasPrev: boolean;
}

export interface AlumniHelpRequestListDataDTO {
  readonly requests: AlumniHelpRequestSummaryDTO[];
  readonly pagination: AlumniHelpPaginationDTO;
  readonly helpActionRequiredCount: number;
  readonly helpNotificationCount: number;
}

export interface AlumniHelpRequestDataDTO {
  readonly request: AlumniHelpRequestDTO;
  readonly helpActionRequiredCount: number;
  readonly helpNotificationCount: number;
}

export interface AlumniHelpActionRequiredCountDTO {
  readonly helpActionRequiredCount: number;
  readonly helpNotificationCount: number;
}

type StrictObject = Readonly<Record<string, unknown>>;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function fail(path: string, msg: string): never {
  throw new AlumniHelpFlowValidationError([Object.freeze({ path, msg })]);
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): StrictObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, `${path} must be an object`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(path, `${path} must be a plain data object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, `${path} must be a plain data object`);
  }
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return fail(typeof key === "string" ? `${path}.${key}` : path, "Unknown field");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return fail(`${path}.${key}`, "Accessor fields are not allowed");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function required(object: StrictObject, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    return fail(`${path}.${key}`, "Required field is missing");
  }
  return object[key];
}

function objectId(value: unknown, path: string): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return fail(path, `${path} must be a valid object id`);
  }
  return value.toLowerCase();
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fail(path, `${path} is invalid`);
  }
  return value as T;
}

function expectedRevision(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) >= Number.MAX_SAFE_INTEGER
  ) {
    return fail(path, `${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function note(value: unknown, path: string, optional: boolean): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") return fail(path, `${path} must be a string`);
  const normalized = normalizeDisplayText(value);
  if (
    !isValidDisplayText(normalized, 1, ALUMNI_HELP_FIELD_LIMITS.note) ||
    codePointLength(normalized) > ALUMNI_HELP_FIELD_LIMITS.note
  ) {
    return fail(
      path,
      `${path} must contain 1-${ALUMNI_HELP_FIELD_LIMITS.note} safe characters`,
    );
  }
  return normalized;
}

function version(value: unknown, path: string): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    return fail(path, `${path} is invalid`);
  }
  return value;
}

function literalTrue(value: unknown, path: string): true {
  if (value !== true) return fail(path, `${path} must be true`);
  return true;
}

export function parseCreateHelpRequestBody(
  value: unknown,
): CreateHelpRequestBody {
  const object = strictObject(value, "body", [
    "alumniProfileId",
    "requestedHelpType",
    "openingNote",
    "consentVersion",
    "consentAccepted",
    "disclaimerVersion",
    "disclaimerAccepted",
  ]);
  const openingNote = Object.prototype.hasOwnProperty.call(object, "openingNote")
    ? note(object.openingNote, "body.openingNote", true)
    : undefined;
  return Object.freeze({
    alumniProfileId: objectId(
      required(object, "alumniProfileId", "body"),
      "body.alumniProfileId",
    ),
    requestedHelpType: enumValue(
      required(object, "requestedHelpType", "body"),
      ALUMNI_HELP_TYPES,
      "body.requestedHelpType",
    ),
    ...(openingNote === undefined ? {} : { openingNote }),
    consentVersion: version(
      required(object, "consentVersion", "body"),
      "body.consentVersion",
    ),
    consentAccepted: literalTrue(
      required(object, "consentAccepted", "body"),
      "body.consentAccepted",
    ),
    disclaimerVersion: version(
      required(object, "disclaimerVersion", "body"),
      "body.disclaimerVersion",
    ),
    disclaimerAccepted: literalTrue(
      required(object, "disclaimerAccepted", "body"),
      "body.disclaimerAccepted",
    ),
  });
}

export function parseHelpTransitionBody(
  action: HelpTransitionAction,
  value: unknown,
): HelpTransitionBody {
  if (!(ALUMNI_HELP_TRANSITION_ACTIONS as readonly string[]).includes(action)) {
    return fail("action", "action is invalid");
  }
  const requiresNote =
    action === "request_information" || action === "provide_information";
  const isAlternative = action === "propose_alternative";
  const allowedKeys = [
    "expectedRevision",
    ...(requiresNote || isAlternative ? ["note"] : []),
    ...(isAlternative ? ["proposedHelpType"] : []),
  ];
  const object = strictObject(value, "body", allowedKeys);
  const result: {
    expectedRevision: number;
    note?: string;
    proposedHelpType?: AlumniHelpType;
  } = {
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
  };
  if (requiresNote) {
    result.note = note(required(object, "note", "body"), "body.note", false);
  } else if (isAlternative && Object.prototype.hasOwnProperty.call(object, "note")) {
    result.note = note(object.note, "body.note", true);
  }
  if (isAlternative) {
    result.proposedHelpType = enumValue(
      required(object, "proposedHelpType", "body"),
      ALUMNI_HELP_TYPES,
      "body.proposedHelpType",
    );
  }
  return Object.freeze(result);
}

export function parseSubmitHelpOutcomeBody(
  value: unknown,
): SubmitHelpOutcomeBody {
  const object = strictObject(value, "body", [
    "expectedRevision",
    "outcomeCode",
  ]);
  return Object.freeze({
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
    outcomeCode: enumValue(
      required(object, "outcomeCode", "body"),
      ALUMNI_HELP_OUTCOME_CODES,
      "body.outcomeCode",
    ),
  });
}

export function parseOutcomeDecisionBody(
  value: unknown,
): OutcomeDecisionBody {
  const object = strictObject(value, "body", ["expectedRevision"]);
  return Object.freeze({
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
  });
}

export function parseReadHelpRequestBody(value: unknown): ReadHelpRequestBody {
  const object = strictObject(value, "body", ["observedRevision"]);
  return Object.freeze({
    observedRevision: expectedRevision(
      required(object, "observedRevision", "body"),
      "body.observedRevision",
    ),
  });
}

function scalarQueryValue(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return fail(path, `${path} must be a string`);
  return value.trim();
}

function positiveQueryInteger(
  value: unknown,
  path: string,
  fallback: number,
  maximum: number,
): number {
  const scalar = scalarQueryValue(value, path);
  if (scalar === undefined || scalar === "") return fallback;
  if (!/^\d+$/.test(scalar)) return fail(path, `${path} must be an integer`);
  const parsed = Number(scalar);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return fail(path, `${path} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseHelpRequestListQuery(
  value: unknown,
): HelpRequestListQuery {
  const object = strictObject(value, "query", ["view", "page", "limit"]);
  const rawView = scalarQueryValue(object.view, "query.view");
  const limit = positiveQueryInteger(
    object.limit,
    "query.limit",
    ALUMNI_HELP_FIELD_LIMITS.pageDefault,
    ALUMNI_HELP_FIELD_LIMITS.pageMaximum,
  );
  // Bound the complete page window, not merely the page number. Otherwise a
  // valid-looking page combined with a large limit can overflow the MongoDB
  // skip calculation and turn client input into an internal query error.
  const maximumPage = Math.floor(
    (Number.MAX_SAFE_INTEGER - (limit - 1)) / limit,
  );
  return Object.freeze({
    view:
      rawView === undefined || rawView === ""
        ? "updates"
        : enumValue(rawView, ALUMNI_HELP_REQUEST_LIST_VIEWS, "query.view"),
    page: positiveQueryInteger(object.page, "query.page", 1, maximumPage),
    limit,
  });
}

export function buildAlumniHelpTermsDTO(): AlumniHelpTermsDTO {
  return Object.freeze({
    consent: Object.freeze({
      version: ALUMNI_HELP_TERMS.consent.version,
      text: ALUMNI_HELP_TERMS.consent.text,
      effectiveAt: ALUMNI_HELP_TERMS.consent.effectiveAt,
    }),
    disclaimer: Object.freeze({
      version: ALUMNI_HELP_TERMS.disclaimer.version,
      text: ALUMNI_HELP_TERMS.disclaimer.text,
      effectiveAt: ALUMNI_HELP_TERMS.disclaimer.effectiveAt,
    }),
  });
}

export function isAlumniHelpType(value: unknown): value is AlumniHelpType {
  return (
    typeof value === "string" &&
    (ALUMNI_HELP_TYPES as readonly string[]).includes(value)
  );
}

export function isAlumniHelpOutcomeCodeForType(
  helpType: AlumniHelpType,
  outcomeCode: unknown,
): outcomeCode is AlumniHelpOutcomeCode {
  return (
    typeof outcomeCode === "string" &&
    (ALUMNI_HELP_OUTCOMES_BY_TYPE[helpType] as readonly string[]).includes(
      outcomeCode,
    )
  );
}

export function isActiveAlumniHelpRequestStatus(
  status: AlumniHelpRequestStatus,
): boolean {
  return (ALUMNI_HELP_ACTIVE_REQUEST_STATUSES as readonly string[]).includes(
    status,
  );
}

export function addFixedHours(value: Date, hours: number): Date {
  if (!Number.isSafeInteger(hours)) throw new TypeError("hours must be a safe integer");
  return new Date(value.getTime() + hours * (MILLISECONDS_PER_DAY / 24));
}

export function helpOutcomeDueAt(submittedAt: Date): Date {
  return addFixedHours(submittedAt, ALUMNI_HELP_OUTCOME_CONFIRMATION_HOURS);
}

/**
 * A closed Help Request remains a two-way conversation for one final week.
 * The Room archive worker uses this fixed deadline; chat send authorization
 * also enforces it, so a delayed worker run cannot extend the grace period.
 */
export function alumniHelpRoomGraceEndsAt(closedAt: Date): Date {
  return addFixedDays(closedAt, ALUMNI_HELP_ROOM_GRACE_DAYS);
}

export function neverAcceptedHelpRequestPurgeAt(endedAt: Date): Date {
  return addUtcCalendarMonths(
    endedAt,
    ALUMNI_HELP_NEVER_ACCEPTED_RETENTION_MONTHS,
  );
}

export function acceptedHelpRequestPurgeAt(
  closedAt: Date,
  latestOutcomeDueAt?: Date | null,
): Date {
  const closedRetention = addUtcCalendarMonths(
    closedAt,
    ALUMNI_HELP_ACCEPTED_RETENTION_MONTHS,
  );
  if (!latestOutcomeDueAt) return closedRetention;
  const outcomeRetention = addFixedDays(
    latestOutcomeDueAt,
    ALUMNI_HELP_OUTCOME_RETENTION_SAFETY_DAYS,
  );
  return outcomeRetention > closedRetention ? outcomeRetention : closedRetention;
}
