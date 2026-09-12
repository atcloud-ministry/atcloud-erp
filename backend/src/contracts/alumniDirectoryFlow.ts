import {
  codePointLength,
  isValidDisplayText,
  normalizeDisplayText,
} from "@atcloud/shared-time/registration-profile";
import type { DirectoryCardDTO } from "./userReadContracts";

export const DIRECTORY_DEFAULT_PAGE_SIZE = 24;
export const DIRECTORY_MAX_PAGE_SIZE = 100;
export const DIRECTORY_MAX_PAGE = Math.floor(
  (Number.MAX_SAFE_INTEGER - (DIRECTORY_MAX_PAGE_SIZE - 1)) /
    DIRECTORY_MAX_PAGE_SIZE,
);

export const DIRECTORY_OFFERINGS = [
  "career_advice",
  "warm_introduction",
  "formal_employee_referral",
] as const;

export type DirectoryOffering = (typeof DIRECTORY_OFFERINGS)[number];

export interface AlumniDirectoryQuery {
  readonly page: number;
  readonly limit: number;
  readonly q?: string;
  readonly company?: string;
  readonly industry?: string;
  readonly skill?: string;
  readonly location?: string;
  readonly cohort?: string;
  readonly offering?: DirectoryOffering;
}

export interface AlumniDirectoryPageDTO {
  readonly profiles: readonly DirectoryCardDTO[];
  readonly pagination: {
    readonly currentPage: number;
    readonly totalPages: number;
    readonly totalProfiles: number;
    readonly hasNext: boolean;
    readonly hasPrev: boolean;
  };
}

export interface AlumniDirectoryQueryIssue {
  readonly path: string;
  readonly msg: string;
}

export class AlumniDirectoryQueryValidationError extends Error {
  readonly name = "AlumniDirectoryQueryValidationError";
  readonly code = "ALUMNI_DIRECTORY_QUERY_INVALID";

  constructor(public readonly issues: readonly AlumniDirectoryQueryIssue[]) {
    super("Validation failed");
  }
}

type QueryObject = Readonly<Record<string, unknown>>;

function issue(path: string, msg: string): never {
  throw new AlumniDirectoryQueryValidationError([
    Object.freeze({ path, msg }),
  ]);
}

function scalar(
  query: QueryObject,
  key: string,
): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return issue(key, `${key} must be a string`);
  return value;
}

function positiveInteger(
  query: QueryObject,
  key: string,
  defaultValue: number,
  maximum: number,
): number {
  const value = scalar(query, key);
  if (value === undefined || value === "") return defaultValue;
  if (!/^\d+$/u.test(value)) {
    return issue(key, `${key} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return issue(key, `${key} is outside the supported range`);
  }
  return parsed;
}

function queryText(query: QueryObject, key: string): string | undefined {
  const value = scalar(query, key);
  if (value === undefined) return undefined;
  const normalized = normalizeDisplayText(value);
  if (!normalized) return undefined;
  if (
    codePointLength(normalized) > 100 ||
    !isValidDisplayText(normalized, 1, 100)
  ) {
    return issue(key, `${key} must contain 1-100 single-line characters`);
  }
  return normalized;
}

export function parseAlumniDirectoryQuery(
  value: unknown,
): AlumniDirectoryQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return issue("query", "query must be an object");
  }
  const allowed = new Set([
    "page",
    "limit",
    "q",
    "company",
    "industry",
    "skill",
    "location",
    "cohort",
    "offering",
  ]);
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return issue("query", "query must be a plain data object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return issue("query", "query must be a plain data object");
  }
  const query: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return issue(
        typeof key === "string" ? key : "query",
        "Unknown query parameter",
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      return issue(key, "Accessor query parameters are not allowed");
    }
    query[key] = descriptor.value;
  }

  const offering = scalar(query, "offering");
  if (
    offering !== undefined &&
    offering !== "" &&
    !(DIRECTORY_OFFERINGS as readonly string[]).includes(offering)
  ) {
    return issue(
      "offering",
      `offering must be one of: ${DIRECTORY_OFFERINGS.join(", ")}`,
    );
  }

  const q = queryText(query, "q");
  const company = queryText(query, "company");
  const industry = queryText(query, "industry");
  const skill = queryText(query, "skill");
  const location = queryText(query, "location");
  const cohort = queryText(query, "cohort");

  return Object.freeze({
    page: positiveInteger(query, "page", 1, DIRECTORY_MAX_PAGE),
    limit: positiveInteger(
      query,
      "limit",
      DIRECTORY_DEFAULT_PAGE_SIZE,
      DIRECTORY_MAX_PAGE_SIZE,
    ),
    ...(q ? { q } : {}),
    ...(company ? { company } : {}),
    ...(industry ? { industry } : {}),
    ...(skill ? { skill } : {}),
    ...(location ? { location } : {}),
    ...(cohort ? { cohort } : {}),
    ...(offering ? { offering: offering as DirectoryOffering } : {}),
  });
}

export function buildAlumniDirectoryPageDTO(input: {
  readonly profiles: readonly DirectoryCardDTO[];
  readonly page: number;
  readonly limit: number;
  readonly totalProfiles: number;
}): AlumniDirectoryPageDTO {
  if (
    !Number.isSafeInteger(input.totalProfiles) ||
    input.totalProfiles < 0 ||
    input.profiles.length > input.limit ||
    input.limit < 1 ||
    input.limit > DIRECTORY_MAX_PAGE_SIZE ||
    input.page < 1 ||
    input.page > DIRECTORY_MAX_PAGE
  ) {
    return issue("page", "Invalid directory page result");
  }
  const totalPages = Math.ceil(input.totalProfiles / input.limit);
  return Object.freeze({
    profiles: Object.freeze([...input.profiles]),
    pagination: Object.freeze({
      currentPage: input.page,
      totalPages,
      totalProfiles: input.totalProfiles,
      hasNext: input.page < totalPages,
      hasPrev: input.page > 1,
    }),
  });
}
