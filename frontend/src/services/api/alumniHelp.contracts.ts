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

export const ALUMNI_HELP_VIEWER_ROLES = ["requester", "provider"] as const;

export type AlumniHelpViewerRole =
  (typeof ALUMNI_HELP_VIEWER_ROLES)[number];

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
] as const;

export type AlumniHelpLifecycleAction =
  (typeof ALUMNI_HELP_LIFECYCLE_ACTIONS)[number];

export const ALUMNI_HELP_AVAILABLE_ACTIONS = [
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
  "submit_outcome",
  "resubmit_outcome",
  "confirm_outcome",
  "deny_outcome",
] as const;

export type AlumniHelpAvailableAction =
  (typeof ALUMNI_HELP_AVAILABLE_ACTIONS)[number];

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

export const ALUMNI_HELP_CONFIRMATION_METHODS = [
  "provider",
  "automatic_20_day",
] as const;

export type AlumniHelpConfirmationMethod =
  (typeof ALUMNI_HELP_CONFIRMATION_METHODS)[number];

export interface AlumniHelpParticipantDTO {
  id: string;
  displayName: string;
  avatar: string | null;
}

export interface AlumniHelpOutcomeDTO {
  id: string;
  revisionNumber: number;
  previousSubmissionId: string | null;
  agreedHelpType: AlumniHelpType;
  outcomeCode: AlumniHelpOutcomeCode;
  status: AlumniHelpOutcomeStatus;
  submittedAt: string;
  dueAt: string;
  decidedAt: string | null;
  confirmationMethod: AlumniHelpConfirmationMethod | null;
  revision: number;
}

export interface AlumniHelpRequestSummaryDTO {
  id: string;
  requester: AlumniHelpParticipantDTO;
  provider: AlumniHelpParticipantDTO;
  status: AlumniHelpRequestStatus;
  requestedHelpType: AlumniHelpType;
  proposedHelpType: AlumniHelpType | null;
  agreedHelpType: AlumniHelpType | null;
  conversationId: string | null;
  viewerRole: AlumniHelpViewerRole;
  actionRequiredForViewer: boolean;
  availableActions: AlumniHelpAvailableAction[];
  latestOutcome: AlumniHelpOutcomeDTO | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AlumniHelpTimelineEntryDTO {
  id: string;
  sequence: number;
  action: AlumniHelpLifecycleAction;
  fromStatus: AlumniHelpRequestStatus | null;
  toStatus: AlumniHelpRequestStatus;
  actorRole: AlumniHelpViewerRole;
  note: string | null;
  helpType: AlumniHelpType | null;
  occurredAt: string;
}

export interface AlumniHelpRequestDetailDTO
  extends AlumniHelpRequestSummaryDTO {
  alumniProfileId: string;
  availableAlternativeHelpTypes: AlumniHelpType[];
  openingNote: string | null;
  lifecycleTimeline: AlumniHelpTimelineEntryDTO[];
  outcomes: AlumniHelpOutcomeDTO[];
  acceptedAt: string | null;
  declinedAt: string | null;
  withdrawnAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  termsAcceptedAt: string;
  acceptedTerms: AlumniHelpTermsDTO;
}

export interface AlumniHelpTermsDTO {
  consent: { version: string; text: string; effectiveAt: string };
  disclaimer: { version: string; text: string; effectiveAt: string };
}

export interface AlumniHelpRequestPageDTO {
  requests: AlumniHelpRequestSummaryDTO[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalCount: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  helpActionRequiredCount: number;
}

export interface AlumniHelpRequestMutationDTO {
  request: AlumniHelpRequestDetailDTO;
  helpActionRequiredCount: number;
}

type JsonObject = Record<string, unknown>;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function contractError(path: string, expectation: string): never {
  throw new Error(
    `Invalid Alumni Help API response at ${path}: expected ${expectation}`,
  );
}

function exactObjectAt(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return contractError(path, "object");
  }
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    return contractError(path, `exact keys ${expectedKeys.join(", ")}`);
  }
  return object;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") return contractError(path, "string");
  return value;
}

function nonemptyStringAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!result.trim()) return contractError(path, "non-empty string");
  return result;
}

function nullableStringAt(value: unknown, path: string): string | null {
  return value === null ? null : stringAt(value, path);
}

function objectIdAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (!OBJECT_ID_PATTERN.test(result)) {
    return contractError(path, "24-character ObjectId string");
  }
  return result;
}

function nullableObjectIdAt(value: unknown, path: string): string | null {
  return value === null ? null : objectIdAt(value, path);
}

function dateAt(value: unknown, path: string): string {
  const result = stringAt(value, path);
  if (Number.isNaN(Date.parse(result))) {
    return contractError(path, "ISO date string");
  }
  return result;
}

function nullableDateAt(value: unknown, path: string): string | null {
  return value === null ? null : dateAt(value, path);
}

function safeIntegerAt(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    return contractError(path, `safe integer >= ${minimum}`);
  }
  return Number(value);
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return contractError(path, "boolean");
  return value;
}

function enumAt<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return contractError(path, values.join(" | "));
  }
  return value as T;
}

function nullableEnumAt<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T | null {
  return value === null ? null : enumAt(value, path, values);
}

function arrayAt<T>(
  value: unknown,
  path: string,
  decoder: (item: unknown, itemPath: string) => T,
): T[] {
  if (!Array.isArray(value)) return contractError(path, "array");
  return value.map((item, index) => decoder(item, `${path}[${index}]`));
}

function decodeParticipant(
  value: unknown,
  path: string,
): AlumniHelpParticipantDTO {
  const participant = exactObjectAt(value, path, ["id", "displayName", "avatar"]);
  return {
    id: objectIdAt(participant.id, `${path}.id`),
    displayName: nonemptyStringAt(participant.displayName, `${path}.displayName`),
    avatar: nullableStringAt(participant.avatar, `${path}.avatar`),
  };
}

const OUTCOME_KEYS = [
  "id",
  "revisionNumber",
  "previousSubmissionId",
  "agreedHelpType",
  "outcomeCode",
  "status",
  "submittedAt",
  "dueAt",
  "decidedAt",
  "confirmationMethod",
  "revision",
] as const;

export function decodeAlumniHelpOutcome(
  value: unknown,
  path: string,
): AlumniHelpOutcomeDTO {
  const outcome = exactObjectAt(value, path, OUTCOME_KEYS);
  return {
    id: objectIdAt(outcome.id, `${path}.id`),
    revisionNumber: safeIntegerAt(
      outcome.revisionNumber,
      `${path}.revisionNumber`,
      1,
    ),
    previousSubmissionId: nullableObjectIdAt(
      outcome.previousSubmissionId,
      `${path}.previousSubmissionId`,
    ),
    agreedHelpType: enumAt(
      outcome.agreedHelpType,
      `${path}.agreedHelpType`,
      ALUMNI_HELP_TYPES,
    ),
    outcomeCode: enumAt(
      outcome.outcomeCode,
      `${path}.outcomeCode`,
      ALUMNI_HELP_OUTCOME_CODES,
    ),
    status: enumAt(
      outcome.status,
      `${path}.status`,
      ALUMNI_HELP_OUTCOME_STATUSES,
    ),
    submittedAt: dateAt(outcome.submittedAt, `${path}.submittedAt`),
    dueAt: dateAt(outcome.dueAt, `${path}.dueAt`),
    decidedAt: nullableDateAt(outcome.decidedAt, `${path}.decidedAt`),
    confirmationMethod: nullableEnumAt(
      outcome.confirmationMethod,
      `${path}.confirmationMethod`,
      ALUMNI_HELP_CONFIRMATION_METHODS,
    ),
    revision: safeIntegerAt(outcome.revision, `${path}.revision`, 0),
  };
}

const SUMMARY_KEYS = [
  "id",
  "requester",
  "provider",
  "status",
  "requestedHelpType",
  "proposedHelpType",
  "agreedHelpType",
  "conversationId",
  "viewerRole",
  "actionRequiredForViewer",
  "availableActions",
  "latestOutcome",
  "revision",
  "createdAt",
  "updatedAt",
  "closedAt",
] as const;

function decodeSummaryFields(
  summary: JsonObject,
  path: string,
): AlumniHelpRequestSummaryDTO {
  return {
    id: objectIdAt(summary.id, `${path}.id`),
    requester: decodeParticipant(summary.requester, `${path}.requester`),
    provider: decodeParticipant(summary.provider, `${path}.provider`),
    status: enumAt(
      summary.status,
      `${path}.status`,
      ALUMNI_HELP_REQUEST_STATUSES,
    ),
    requestedHelpType: enumAt(
      summary.requestedHelpType,
      `${path}.requestedHelpType`,
      ALUMNI_HELP_TYPES,
    ),
    proposedHelpType: nullableEnumAt(
      summary.proposedHelpType,
      `${path}.proposedHelpType`,
      ALUMNI_HELP_TYPES,
    ),
    agreedHelpType: nullableEnumAt(
      summary.agreedHelpType,
      `${path}.agreedHelpType`,
      ALUMNI_HELP_TYPES,
    ),
    conversationId: nullableObjectIdAt(
      summary.conversationId,
      `${path}.conversationId`,
    ),
    viewerRole: enumAt(
      summary.viewerRole,
      `${path}.viewerRole`,
      ALUMNI_HELP_VIEWER_ROLES,
    ),
    actionRequiredForViewer: booleanAt(
      summary.actionRequiredForViewer,
      `${path}.actionRequiredForViewer`,
    ),
    availableActions: arrayAt(
      summary.availableActions,
      `${path}.availableActions`,
      (action, actionPath) =>
        enumAt(action, actionPath, ALUMNI_HELP_AVAILABLE_ACTIONS),
    ),
    latestOutcome:
      summary.latestOutcome === null
        ? null
        : decodeAlumniHelpOutcome(
            summary.latestOutcome,
            `${path}.latestOutcome`,
          ),
    revision: safeIntegerAt(summary.revision, `${path}.revision`, 0),
    createdAt: dateAt(summary.createdAt, `${path}.createdAt`),
    updatedAt: dateAt(summary.updatedAt, `${path}.updatedAt`),
    closedAt: nullableDateAt(summary.closedAt, `${path}.closedAt`),
  };
}

export function decodeAlumniHelpRequestSummary(
  value: unknown,
  path: string,
): AlumniHelpRequestSummaryDTO {
  return decodeSummaryFields(exactObjectAt(value, path, SUMMARY_KEYS), path);
}

function decodeTimelineEntry(
  value: unknown,
  path: string,
): AlumniHelpTimelineEntryDTO {
  const entry = exactObjectAt(value, path, [
    "id",
    "sequence",
    "action",
    "fromStatus",
    "toStatus",
    "actorRole",
    "note",
    "helpType",
    "occurredAt",
  ]);
  return {
    id: objectIdAt(entry.id, `${path}.id`),
    sequence: safeIntegerAt(entry.sequence, `${path}.sequence`, 1),
    action: enumAt(
      entry.action,
      `${path}.action`,
      ALUMNI_HELP_LIFECYCLE_ACTIONS,
    ),
    fromStatus: nullableEnumAt(
      entry.fromStatus,
      `${path}.fromStatus`,
      ALUMNI_HELP_REQUEST_STATUSES,
    ),
    toStatus: enumAt(
      entry.toStatus,
      `${path}.toStatus`,
      ALUMNI_HELP_REQUEST_STATUSES,
    ),
    actorRole: enumAt(
      entry.actorRole,
      `${path}.actorRole`,
      ALUMNI_HELP_VIEWER_ROLES,
    ),
    note: nullableStringAt(entry.note, `${path}.note`),
    helpType: nullableEnumAt(
      entry.helpType,
      `${path}.helpType`,
      ALUMNI_HELP_TYPES,
    ),
    occurredAt: dateAt(entry.occurredAt, `${path}.occurredAt`),
  };
}

const DETAIL_KEYS = [
  ...SUMMARY_KEYS,
  "alumniProfileId",
  "availableAlternativeHelpTypes",
  "openingNote",
  "lifecycleTimeline",
  "outcomes",
  "acceptedAt",
  "declinedAt",
  "withdrawnAt",
  "startedAt",
  "completedAt",
  "termsAcceptedAt",
  "acceptedTerms",
] as const;

export function decodeAlumniHelpRequestDetail(
  value: unknown,
  path = "data.request",
): AlumniHelpRequestDetailDTO {
  const detail = exactObjectAt(value, path, DETAIL_KEYS);
  return {
    ...decodeSummaryFields(detail, path),
    alumniProfileId: objectIdAt(
      detail.alumniProfileId,
      `${path}.alumniProfileId`,
    ),
    availableAlternativeHelpTypes: arrayAt(
      detail.availableAlternativeHelpTypes,
      `${path}.availableAlternativeHelpTypes`,
      (helpType, helpTypePath) =>
        enumAt(helpType, helpTypePath, ALUMNI_HELP_TYPES),
    ),
    openingNote: nullableStringAt(detail.openingNote, `${path}.openingNote`),
    lifecycleTimeline: arrayAt(
      detail.lifecycleTimeline,
      `${path}.lifecycleTimeline`,
      decodeTimelineEntry,
    ),
    outcomes: arrayAt(detail.outcomes, `${path}.outcomes`, decodeAlumniHelpOutcome),
    acceptedAt: nullableDateAt(detail.acceptedAt, `${path}.acceptedAt`),
    declinedAt: nullableDateAt(detail.declinedAt, `${path}.declinedAt`),
    withdrawnAt: nullableDateAt(detail.withdrawnAt, `${path}.withdrawnAt`),
    startedAt: nullableDateAt(detail.startedAt, `${path}.startedAt`),
    completedAt: nullableDateAt(detail.completedAt, `${path}.completedAt`),
    termsAcceptedAt: dateAt(
      detail.termsAcceptedAt,
      `${path}.termsAcceptedAt`,
    ),
    acceptedTerms: decodeTerms(
      detail.acceptedTerms,
      `${path}.acceptedTerms`,
    ),
  };
}

function decodePagination(
  value: unknown,
  path: string,
): AlumniHelpRequestPageDTO["pagination"] {
  const pagination = exactObjectAt(value, path, [
    "currentPage",
    "totalPages",
    "totalCount",
    "hasNext",
    "hasPrev",
  ]);
  const currentPage = safeIntegerAt(
    pagination.currentPage,
    `${path}.currentPage`,
    1,
  );
  const totalPages = safeIntegerAt(
    pagination.totalPages,
    `${path}.totalPages`,
    0,
  );
  const totalCount = safeIntegerAt(
    pagination.totalCount,
    `${path}.totalCount`,
    0,
  );
  const hasNext = booleanAt(pagination.hasNext, `${path}.hasNext`);
  const hasPrev = booleanAt(pagination.hasPrev, `${path}.hasPrev`);
  if (hasNext !== (currentPage < totalPages)) {
    return contractError(`${path}.hasNext`, "value consistent with pagination");
  }
  if (hasPrev !== (currentPage > 1)) {
    return contractError(`${path}.hasPrev`, "value consistent with pagination");
  }
  if ((totalCount === 0) !== (totalPages === 0)) {
    return contractError(path, "consistent totalCount and totalPages");
  }
  return { currentPage, totalPages, totalCount, hasNext, hasPrev };
}

export function decodeAlumniHelpRequestPage(
  value: unknown,
): AlumniHelpRequestPageDTO {
  const data = exactObjectAt(value, "data", [
    "requests",
    "pagination",
    "helpActionRequiredCount",
  ]);
  return {
    requests: arrayAt(
      data.requests,
      "data.requests",
      decodeAlumniHelpRequestSummary,
    ),
    pagination: decodePagination(data.pagination, "data.pagination"),
    helpActionRequiredCount: safeIntegerAt(
      data.helpActionRequiredCount,
      "data.helpActionRequiredCount",
      0,
    ),
  };
}

export function decodeAlumniHelpRequestMutation(
  value: unknown,
): AlumniHelpRequestMutationDTO {
  const data = exactObjectAt(value, "data", [
    "request",
    "helpActionRequiredCount",
  ]);
  return {
    request: decodeAlumniHelpRequestDetail(data.request),
    helpActionRequiredCount: safeIntegerAt(
      data.helpActionRequiredCount,
      "data.helpActionRequiredCount",
      0,
    ),
  };
}

export function decodeAlumniHelpActionRequiredCount(value: unknown): number {
  const data = exactObjectAt(value, "data", ["helpActionRequiredCount"]);
  return safeIntegerAt(
    data.helpActionRequiredCount,
    "data.helpActionRequiredCount",
    0,
  );
}

function decodeTerm(
  value: unknown,
  path: string,
): { version: string; text: string; effectiveAt: string } {
  const term = exactObjectAt(value, path, ["version", "text", "effectiveAt"]);
  return {
    version: nonemptyStringAt(term.version, `${path}.version`),
    text: nonemptyStringAt(term.text, `${path}.text`),
    effectiveAt: dateAt(term.effectiveAt, `${path}.effectiveAt`),
  };
}

function decodeTerms(value: unknown, path: string): AlumniHelpTermsDTO {
  const terms = exactObjectAt(value, path, ["consent", "disclaimer"]);
  return {
    consent: decodeTerm(terms.consent, `${path}.consent`),
    disclaimer: decodeTerm(terms.disclaimer, `${path}.disclaimer`),
  };
}

export function decodeAlumniHelpTerms(value: unknown): AlumniHelpTermsDTO {
  const data = exactObjectAt(value, "data", ["terms"]);
  return decodeTerms(data.terms, "data.terms");
}
