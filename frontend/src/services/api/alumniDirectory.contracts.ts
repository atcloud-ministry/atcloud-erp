export const DIRECTORY_OFFERINGS = [
  "career_advice",
  "warm_introduction",
  "formal_employee_referral",
] as const;

export type DirectoryOffering = (typeof DIRECTORY_OFFERINGS)[number];

export interface DirectoryAffiliationDTO {
  id: string;
  programName: string;
  cohortLabel: string | null;
}

export interface DirectoryHelpOfferingsDTO {
  careerAdvice: boolean;
  warmIntroduction: boolean;
  formalEmployeeReferral: boolean;
}

export interface DirectoryCardDTO {
  id: string;
  displayName: string;
  avatar: string | null;
  professionalHeadline: string | null;
  company: string | null;
  occupation: string | null;
  generalLocation: string | null;
  affiliations: DirectoryAffiliationDTO[];
  helpOfferings: DirectoryHelpOfferingsDTO;
}

export interface DirectoryDetailDTO extends DirectoryCardDTO {
  industry: string | null;
  skills: string[];
  bio: string | null;
}

export interface AlumniProfilePublishReadinessIssueDTO {
  field: string;
  code: string;
  message: string;
}

export interface OwnAlumniProfileDTO extends DirectoryDetailDTO {
  publishStatus: "draft" | "published" | "withdrawn";
  consentVersion: string | null;
  hasCurrentPublicationConsent: boolean;
  publicationConsent: {
    version: string;
    text: string;
  };
  publishReadiness: {
    ready: boolean;
    issues: AlumniProfilePublishReadinessIssueDTO[];
  };
  revision: number;
  publishedAt: string | null;
  withdrawnAt: string | null;
  updatedAt: string | null;
}

export interface DirectoryPageDTO {
  profiles: DirectoryCardDTO[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalProfiles: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

type JsonObject = Record<string, unknown>;

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function contractError(path: string, expectation: string): never {
  throw new Error(`Invalid Directory API response at ${path}: expected ${expectation}`);
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

function objectIdAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return contractError(path, "24-character ObjectId string");
  }
  return value;
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

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return contractError(path, "boolean");
  return value;
}

function safeIntegerAt(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    return contractError(path, `safe integer greater than or equal to ${minimum}`);
  }
  return Number(value);
}

function arrayAt<T>(
  value: unknown,
  path: string,
  decode: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) return contractError(path, "array");
  return value.map((item, index) => decode(item, `${path}[${index}]`));
}

function decodeAffiliation(
  value: unknown,
  path: string,
): DirectoryAffiliationDTO {
  const affiliation = exactObjectAt(value, path, [
    "id",
    "programName",
    "cohortLabel",
  ]);
  return {
    id: objectIdAt(affiliation.id, `${path}.id`),
    programName: nonemptyStringAt(
      affiliation.programName,
      `${path}.programName`,
    ),
    cohortLabel: nullableStringAt(
      affiliation.cohortLabel,
      `${path}.cohortLabel`,
    ),
  };
}

function decodeHelpOfferings(
  value: unknown,
  path: string,
): DirectoryHelpOfferingsDTO {
  const offerings = exactObjectAt(value, path, [
    "careerAdvice",
    "warmIntroduction",
    "formalEmployeeReferral",
  ]);
  return {
    careerAdvice: booleanAt(offerings.careerAdvice, `${path}.careerAdvice`),
    warmIntroduction: booleanAt(
      offerings.warmIntroduction,
      `${path}.warmIntroduction`,
    ),
    formalEmployeeReferral: booleanAt(
      offerings.formalEmployeeReferral,
      `${path}.formalEmployeeReferral`,
    ),
  };
}

const CARD_KEYS = [
  "id",
  "displayName",
  "avatar",
  "professionalHeadline",
  "company",
  "occupation",
  "generalLocation",
  "affiliations",
  "helpOfferings",
] as const;

function decodeCardFields(
  card: JsonObject,
  path: string,
): DirectoryCardDTO {
  return {
    id: objectIdAt(card.id, `${path}.id`),
    displayName: nonemptyStringAt(card.displayName, `${path}.displayName`),
    avatar: nullableStringAt(card.avatar, `${path}.avatar`),
    professionalHeadline: nullableStringAt(
      card.professionalHeadline,
      `${path}.professionalHeadline`,
    ),
    company: nullableStringAt(card.company, `${path}.company`),
    occupation: nullableStringAt(card.occupation, `${path}.occupation`),
    generalLocation: nullableStringAt(
      card.generalLocation,
      `${path}.generalLocation`,
    ),
    affiliations: arrayAt(
      card.affiliations,
      `${path}.affiliations`,
      decodeAffiliation,
    ),
    helpOfferings: decodeHelpOfferings(
      card.helpOfferings,
      `${path}.helpOfferings`,
    ),
  };
}

export function decodeDirectoryCard(
  value: unknown,
  path = "data.profile",
): DirectoryCardDTO {
  return decodeCardFields(exactObjectAt(value, path, CARD_KEYS), path);
}

export function decodeDirectoryDetail(
  value: unknown,
  path = "data.profile",
): DirectoryDetailDTO {
  const detail = exactObjectAt(value, path, [
    ...CARD_KEYS,
    "industry",
    "skills",
    "bio",
  ]);
  return {
    ...decodeCardFields(detail, path),
    industry: nullableStringAt(detail.industry, `${path}.industry`),
    skills: arrayAt(detail.skills, `${path}.skills`, stringAt),
    bio: nullableStringAt(detail.bio, `${path}.bio`),
  };
}

function decodePagination(value: unknown, path: string): DirectoryPageDTO["pagination"] {
  const pagination = exactObjectAt(value, path, [
    "currentPage",
    "totalPages",
    "totalProfiles",
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
  const totalProfiles = safeIntegerAt(
    pagination.totalProfiles,
    `${path}.totalProfiles`,
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
  if ((totalProfiles === 0) !== (totalPages === 0)) {
    return contractError(path, "consistent totalProfiles and totalPages");
  }

  return { currentPage, totalPages, totalProfiles, hasNext, hasPrev };
}

export function decodeDirectoryPage(value: unknown): DirectoryPageDTO {
  const data = exactObjectAt(value, "data", ["profiles", "pagination"]);
  const profiles = arrayAt(data.profiles, "data.profiles", decodeDirectoryCard);
  if (profiles.length > 100) {
    return contractError("data.profiles", "at most 100 profiles");
  }
  return {
    profiles,
    pagination: decodePagination(data.pagination, "data.pagination"),
  };
}

export function decodeDirectoryDetailResponse(
  value: unknown,
): DirectoryDetailDTO {
  const data = exactObjectAt(value, "data", ["profile"]);
  return decodeDirectoryDetail(data.profile);
}

function nullableDateAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = stringAt(value, path);
  if (Number.isNaN(Date.parse(result))) {
    return contractError(path, "ISO date string or null");
  }
  return result;
}

function decodeReadinessIssue(
  value: unknown,
  path: string,
): AlumniProfilePublishReadinessIssueDTO {
  const issue = exactObjectAt(value, path, ["field", "code", "message"]);
  return {
    field: stringAt(issue.field, `${path}.field`),
    code: stringAt(issue.code, `${path}.code`),
    message: stringAt(issue.message, `${path}.message`),
  };
}

export function decodeOwnAlumniProfile(
  value: unknown,
  path = "data.profile",
): OwnAlumniProfileDTO {
  const profile = exactObjectAt(value, path, [
    ...CARD_KEYS,
    "industry",
    "skills",
    "bio",
    "publishStatus",
    "consentVersion",
    "hasCurrentPublicationConsent",
    "publicationConsent",
    "publishReadiness",
    "revision",
    "publishedAt",
    "withdrawnAt",
    "updatedAt",
  ]);
  const consent = exactObjectAt(
    profile.publicationConsent,
    `${path}.publicationConsent`,
    ["version", "text"],
  );
  const readiness = exactObjectAt(
    profile.publishReadiness,
    `${path}.publishReadiness`,
    ["ready", "issues"],
  );
  if (
    profile.publishStatus !== "draft" &&
    profile.publishStatus !== "published" &&
    profile.publishStatus !== "withdrawn"
  ) {
    return contractError(
      `${path}.publishStatus`,
      "draft, published, or withdrawn",
    );
  }
  return {
    ...decodeDirectoryDetail(
      Object.fromEntries(
        [...CARD_KEYS, "industry", "skills", "bio"].map((key) => [
          key,
          profile[key],
        ]),
      ),
      path,
    ),
    publishStatus: profile.publishStatus,
    consentVersion: nullableStringAt(
      profile.consentVersion,
      `${path}.consentVersion`,
    ),
    hasCurrentPublicationConsent: booleanAt(
      profile.hasCurrentPublicationConsent,
      `${path}.hasCurrentPublicationConsent`,
    ),
    publicationConsent: {
      version: nonemptyStringAt(
        consent.version,
        `${path}.publicationConsent.version`,
      ),
      text: nonemptyStringAt(
        consent.text,
        `${path}.publicationConsent.text`,
      ),
    },
    publishReadiness: {
      ready: booleanAt(readiness.ready, `${path}.publishReadiness.ready`),
      issues: arrayAt(
        readiness.issues,
        `${path}.publishReadiness.issues`,
        decodeReadinessIssue,
      ),
    },
    revision: safeIntegerAt(profile.revision, `${path}.revision`, 0),
    publishedAt: nullableDateAt(profile.publishedAt, `${path}.publishedAt`),
    withdrawnAt: nullableDateAt(profile.withdrawnAt, `${path}.withdrawnAt`),
    updatedAt: nullableDateAt(profile.updatedAt, `${path}.updatedAt`),
  };
}

export function decodeOwnAlumniProfileResponse(
  value: unknown,
): OwnAlumniProfileDTO {
  const data = exactObjectAt(value, "data", ["profile"]);
  return decodeOwnAlumniProfile(data.profile);
}
