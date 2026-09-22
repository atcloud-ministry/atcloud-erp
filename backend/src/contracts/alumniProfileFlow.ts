import {
  codePointLength,
  isValidDisplayText,
  isValidMultilineDisplayText,
  normalizeDisplayText,
  normalizeNullableDisplayText,
  normalizeNullableMultilineDisplayText,
} from "@atcloud/shared-time/registration-profile";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../config/alumniProfilePublicationConsent";
import {
  ALUMNI_PROFILE_PUBLISH_STATUSES,
  type AlumniProfilePublishStatus,
} from "./alumniDirectoryData";
import type {
  AlumniProfilePublishReadinessIssueDTO,
  DirectoryAffiliationDTO,
  DirectoryDetailDTO,
  DirectoryHelpOfferingsDTO,
  OwnAlumniProfileDTO,
} from "./userReadContracts";

export const ALUMNI_PROFILE_FIELD_LIMITS = Object.freeze({
  professionalHeadline: 160,
  industry: 100,
  skill: 80,
  skills: 20,
  bio: 2_000,
});

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export interface AlumniProfileFlowIssue {
  readonly path: string;
  readonly msg: string;
}

export class AlumniProfileFlowValidationError extends Error {
  readonly name = "AlumniProfileFlowValidationError";
  readonly code = "ALUMNI_PROFILE_FLOW_INPUT_INVALID";

  constructor(public readonly issues: readonly AlumniProfileFlowIssue[]) {
    super("Validation failed");
  }
}

export interface AlumniProfileFieldsInput {
  readonly professionalHeadline?: string | null;
  readonly industry?: string | null;
  readonly skills?: readonly string[];
  readonly bio?: string | null;
  readonly helpOfferings?: DirectoryHelpOfferingsDTO;
}

export interface AlumniProfileUpdateBody extends AlumniProfileFieldsInput {
  readonly expectedRevision: number;
}

export interface AlumniProfilePublishBody {
  readonly expectedRevision: number;
  readonly consentVersion: string;
  readonly consentAccepted: true;
}

export interface AlumniProfileWithdrawBody {
  readonly expectedRevision: number;
}

export interface DirectoryProfileSource {
  readonly id: string;
  readonly displayName: string;
  readonly avatar?: string | null;
  readonly professionalHeadline?: string | null;
  readonly company?: string | null;
  readonly occupation?: string | null;
  readonly generalLocation?: string | null;
  readonly affiliations: readonly DirectoryAffiliationDTO[];
  readonly helpOfferings: DirectoryHelpOfferingsDTO;
  readonly industry?: string | null;
  readonly skills: readonly string[];
  readonly bio?: string | null;
}

export interface OwnAlumniProfileSource extends DirectoryProfileSource {
  readonly publishStatus: AlumniProfilePublishStatus;
  readonly consentVersion?: string | null;
  readonly hasCurrentPublicationConsent: boolean;
  readonly acceptedPublicationConsent?: {
    readonly version: string;
    readonly text: string;
    readonly documentHash: string;
    readonly effectiveAt: Date | string;
    readonly acceptedAt: Date | string;
  } | null;
  readonly publishReadiness: {
    readonly ready: boolean;
    readonly issues: readonly AlumniProfilePublishReadinessIssueDTO[];
  };
  readonly revision: number;
  readonly publishedAt?: Date | string | null;
  readonly withdrawnAt?: Date | string | null;
  readonly updatedAt?: Date | string | null;
}

type StrictObject = Readonly<Record<string, unknown>>;

function fail(path: string, msg: string): never {
  throw new AlumniProfileFlowValidationError([
    Object.freeze({ path, msg }),
  ]);
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

function nullableDisplayText(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    return fail(path, `${path} must be a string or null`);
  }
  const normalized = normalizeNullableDisplayText(value);
  if (
    normalized === null ||
    !isValidDisplayText(normalized, 1, maximum)
  ) {
    return fail(path, `${path} must contain 1-${maximum} characters or be null`);
  }
  return normalized;
}

function nullableMultilineDisplayText(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    return fail(path, `${path} must be a string or null`);
  }
  const normalized = normalizeNullableMultilineDisplayText(value);
  if (
    normalized === null ||
    !isValidMultilineDisplayText(normalized, 1, maximum)
  ) {
    return fail(path, `${path} must contain 1-${maximum} characters or be null`);
  }
  return normalized;
}

function skills(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > ALUMNI_PROFILE_FIELD_LIMITS.skills) {
    return fail(
      path,
      `${path} must contain at most ${ALUMNI_PROFILE_FIELD_LIMITS.skills} skills`,
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string") {
        return fail(`${path}[${index}]`, "Skill must be a string");
      }
      const normalized = normalizeDisplayText(entry);
      if (
        !isValidDisplayText(
          normalized,
          1,
          ALUMNI_PROFILE_FIELD_LIMITS.skill,
        )
      ) {
        return fail(
          `${path}[${index}]`,
          `Skill must contain 1-${ALUMNI_PROFILE_FIELD_LIMITS.skill} characters`,
        );
      }
      return normalized;
    }),
  );
}

function helpOfferings(value: unknown, path: string): DirectoryHelpOfferingsDTO {
  const object = strictObject(value, path, [
    "careerAdvice",
    "warmIntroduction",
    "formalEmployeeReferral",
  ]);
  const result = {
    careerAdvice: required(object, "careerAdvice", path),
    warmIntroduction: required(object, "warmIntroduction", path),
    formalEmployeeReferral: required(object, "formalEmployeeReferral", path),
  };
  for (const [key, entry] of Object.entries(result)) {
    if (typeof entry !== "boolean") {
      return fail(`${path}.${key}`, `${path}.${key} must be a boolean`);
    }
  }
  return Object.freeze(result as DirectoryHelpOfferingsDTO);
}

function parseFields(
  object: StrictObject,
  path: string,
): AlumniProfileFieldsInput {
  const result: {
    professionalHeadline?: string | null;
    industry?: string | null;
    skills?: readonly string[];
    bio?: string | null;
    helpOfferings?: DirectoryHelpOfferingsDTO;
  } = {};
  if (Object.prototype.hasOwnProperty.call(object, "professionalHeadline")) {
    result.professionalHeadline = nullableDisplayText(
      object.professionalHeadline,
      `${path}.professionalHeadline`,
      ALUMNI_PROFILE_FIELD_LIMITS.professionalHeadline,
    );
  }
  if (Object.prototype.hasOwnProperty.call(object, "industry")) {
    result.industry = nullableDisplayText(
      object.industry,
      `${path}.industry`,
      ALUMNI_PROFILE_FIELD_LIMITS.industry,
    );
  }
  if (Object.prototype.hasOwnProperty.call(object, "skills")) {
    result.skills = skills(object.skills, `${path}.skills`);
  }
  if (Object.prototype.hasOwnProperty.call(object, "bio")) {
    result.bio = nullableMultilineDisplayText(
      object.bio,
      `${path}.bio`,
      ALUMNI_PROFILE_FIELD_LIMITS.bio,
    );
  }
  if (Object.prototype.hasOwnProperty.call(object, "helpOfferings")) {
    result.helpOfferings = helpOfferings(
      object.helpOfferings,
      `${path}.helpOfferings`,
    );
  }
  return Object.freeze(result);
}

export function parseAlumniProfileUpdateBody(
  value: unknown,
): AlumniProfileUpdateBody {
  const object = strictObject(value, "body", [
    "expectedRevision",
    "professionalHeadline",
    "industry",
    "skills",
    "bio",
    "helpOfferings",
  ]);
  const fields = parseFields(object, "body");
  if (Object.keys(fields).length === 0) {
    return fail("body", "At least one profile field is required");
  }
  return Object.freeze({
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
    ...fields,
  });
}

export function parseAlumniProfilePublishBody(
  value: unknown,
): AlumniProfilePublishBody {
  const object = strictObject(value, "body", [
    "expectedRevision",
    "consentVersion",
    "consentAccepted",
  ]);
  const version = required(object, "consentVersion", "body");
  if (typeof version !== "string" || !CONSENT_VERSION_PATTERN.test(version)) {
    return fail("body.consentVersion", "consentVersion is invalid");
  }
  if (required(object, "consentAccepted", "body") !== true) {
    return fail("body.consentAccepted", "Publication consent must be accepted");
  }
  return Object.freeze({
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
    consentVersion: version,
    consentAccepted: true,
  });
}

export function parseAlumniProfileWithdrawBody(
  value: unknown,
): AlumniProfileWithdrawBody {
  const object = strictObject(value, "body", ["expectedRevision"]);
  return Object.freeze({
    expectedRevision: expectedRevision(
      required(object, "expectedRevision", "body"),
      "body.expectedRevision",
    ),
  });
}

function objectId(value: unknown, path: string): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return fail(path, `${path} must be a 24-character ObjectId`);
  }
  return value.toLowerCase();
}

function nullableText(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return fail(path, `${path} must be text or null`);
  return value;
}

function isoDate(value: Date | string | null | undefined, path: string): string | null {
  if (value == null) return null;
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) return fail(path, `${path} must be a date`);
  return candidate.toISOString();
}

function cloneAffiliations(
  values: readonly DirectoryAffiliationDTO[],
): DirectoryAffiliationDTO[] {
  return values.map((value, index) => {
    const programName = nullableDisplayText(
      value.programName,
      `affiliations[${index}].programName`,
      160,
    );
    if (programName === null) {
      return fail(
        `affiliations[${index}].programName`,
        "Program name is required",
      );
    }
    return Object.freeze({
      id: objectId(value.id, `affiliations[${index}].id`),
      programName,
      cohortLabel:
        value.cohortLabel == null
          ? null
          : nullableDisplayText(
              value.cohortLabel,
              `affiliations[${index}].cohortLabel`,
              100,
            ),
    });
  });
}

function cloneOfferings(
  value: DirectoryHelpOfferingsDTO,
): DirectoryHelpOfferingsDTO {
  return helpOfferings(value, "helpOfferings");
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail(path, `${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function publicationConsentEvidence(
  value: OwnAlumniProfileSource["acceptedPublicationConsent"],
): OwnAlumniProfileDTO["acceptedPublicationConsent"] {
  if (value == null) return null;
  if (
    typeof value.version !== "string" ||
    !CONSENT_VERSION_PATTERN.test(value.version) ||
    typeof value.text !== "string" ||
    value.text.length === 0 ||
    typeof value.documentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.documentHash)
  ) {
    return fail(
      "acceptedPublicationConsent",
      "acceptedPublicationConsent is invalid",
    );
  }
  const effectiveAt = isoDate(
    value.effectiveAt,
    "acceptedPublicationConsent.effectiveAt",
  );
  const acceptedAt = isoDate(
    value.acceptedAt,
    "acceptedPublicationConsent.acceptedAt",
  );
  if (!effectiveAt || !acceptedAt) {
    return fail(
      "acceptedPublicationConsent",
      "acceptedPublicationConsent dates are required",
    );
  }
  return Object.freeze({
    version: value.version,
    text: value.text,
    documentHash: value.documentHash,
    effectiveAt,
    acceptedAt,
  });
}

function cloneReadinessIssues(
  values: readonly AlumniProfilePublishReadinessIssueDTO[],
): AlumniProfilePublishReadinessIssueDTO[] {
  return values.map((value, index) => {
    if (
      typeof value.field !== "string" ||
      typeof value.code !== "string" ||
      typeof value.message !== "string" ||
      !SAFE_CODE_PATTERN.test(value.code) ||
      codePointLength(value.field) === 0 ||
      codePointLength(value.field) > 80 ||
      codePointLength(value.message) === 0 ||
      codePointLength(value.message) > 240
    ) {
      return fail(`publishReadiness.issues[${index}]`, "Invalid readiness issue");
    }
    return Object.freeze({
      field: value.field,
      code: value.code,
      message: value.message,
    });
  });
}

export function buildDirectoryDetailDTO(
  input: DirectoryProfileSource,
): DirectoryDetailDTO {
  if (typeof input.displayName !== "string" || input.displayName.length === 0) {
    return fail("displayName", "displayName is required");
  }
  return Object.freeze({
    id: objectId(input.id, "id"),
    displayName: input.displayName,
    avatar: nullableText(input.avatar, "avatar"),
    professionalHeadline: nullableText(
      input.professionalHeadline,
      "professionalHeadline",
    ),
    company: nullableText(input.company, "company"),
    occupation: nullableText(input.occupation, "occupation"),
    generalLocation: nullableText(input.generalLocation, "generalLocation"),
    affiliations: cloneAffiliations(input.affiliations),
    helpOfferings: cloneOfferings(input.helpOfferings),
    industry: nullableText(input.industry, "industry"),
    skills: [...skills(input.skills, "skills")],
    bio: nullableText(input.bio, "bio"),
  });
}

export function buildOwnAlumniProfileDTO(
  input: OwnAlumniProfileSource,
): OwnAlumniProfileDTO {
  if (!(ALUMNI_PROFILE_PUBLISH_STATUSES as readonly string[]).includes(input.publishStatus)) {
    return fail("publishStatus", "publishStatus is invalid");
  }
  const details = buildDirectoryDetailDTO(input);
  const readinessIssues = cloneReadinessIssues(input.publishReadiness.issues);
  if (typeof input.publishReadiness.ready !== "boolean") {
    return fail("publishReadiness.ready", "publishReadiness.ready must be a boolean");
  }
  if (typeof input.hasCurrentPublicationConsent !== "boolean") {
    return fail(
      "hasCurrentPublicationConsent",
      "hasCurrentPublicationConsent must be a boolean",
    );
  }
  return Object.freeze({
    ...details,
    publishStatus: input.publishStatus,
    consentVersion: nullableText(input.consentVersion, "consentVersion"),
    hasCurrentPublicationConsent: input.hasCurrentPublicationConsent,
    publicationConsent: Object.freeze({
      version: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      text: ALUMNI_PROFILE_PUBLICATION_CONSENT.text,
    }),
    acceptedPublicationConsent: publicationConsentEvidence(
      input.acceptedPublicationConsent,
    ),
    publishReadiness: Object.freeze({
      ready: input.publishReadiness.ready,
      issues: readinessIssues,
    }),
    revision: nonNegativeInteger(input.revision, "revision"),
    publishedAt: isoDate(input.publishedAt, "publishedAt"),
    withdrawnAt: isoDate(input.withdrawnAt, "withdrawnAt"),
    updatedAt: isoDate(input.updatedAt, "updatedAt"),
  });
}
