import {
  codePointLength,
  normalizeSearchText,
} from "@atcloud/shared-time/registration-profile";
import type { AlumniProfileSearchProjection } from "../../models/AlumniProfile";

const MAX_SEARCH_TEXT_CODE_POINTS = 4_000;
const MAX_SEARCH_KEY_CODE_POINTS = 200;
const MAX_SKILLS = 20;

export const ALUMNI_PROFILE_SEARCH_USER_PROJECTION = [
  "username",
  "firstName",
  "lastName",
  "company",
  "occupation",
  "residenceCity",
  "residenceRegion",
  "residenceCountryCode",
].join(" ");

export interface AlumniProjectionUserSource {
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly company?: string | null;
  readonly occupation?: string | null;
  readonly residenceCity?: string | null;
  readonly residenceRegion?: string | null;
  readonly residenceCountryCode?: string | null;
}

export interface AlumniProjectionProfileSource {
  readonly professionalHeadline?: string | null;
  readonly industry?: string | null;
  readonly skills?: readonly string[];
}

export interface AlumniProjectionAffiliationSource {
  readonly programName?: string | null;
  readonly cohortLabel?: string | null;
}

export function alumniDisplayName(source: AlumniProjectionUserSource): string {
  const fullName = [source.firstName, source.lastName]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .trim();
  return fullName || source.username?.trim() || "Member";
}

export function alumniGeneralLocation(
  source: AlumniProjectionUserSource,
): string | null {
  const city = source.residenceCity?.trim();
  if (city) return city;
  const region = source.residenceRegion?.trim();
  if (region) return region;
  return source.residenceCountryCode?.trim() || null;
}

function boundedSearchKey(value: string | null | undefined): string {
  if (!value) return "";
  return Array.from(normalizeSearchText(value))
    .slice(0, MAX_SEARCH_KEY_CODE_POINTS)
    .join("");
}

function normalizedUnique(
  values: readonly (string | null | undefined)[],
  maximum: number,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = boundedSearchKey(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function boundedSearchText(values: readonly (string | null | undefined)[]): string {
  const tokens = normalizedUnique(values, Number.MAX_SAFE_INTEGER);
  let result = "";
  for (const token of tokens) {
    const candidate = result ? `${result} ${token}` : token;
    if (codePointLength(candidate) <= MAX_SEARCH_TEXT_CODE_POINTS) {
      result = candidate;
      continue;
    }
    const remaining = MAX_SEARCH_TEXT_CODE_POINTS - codePointLength(result) - 1;
    if (remaining > 0) {
      const suffix = Array.from(token).slice(0, remaining).join("");
      result = result ? `${result} ${suffix}` : suffix;
    }
    break;
  }
  return result;
}

/** Build the complete, rebuildable projection from canonical source records. */
export function buildAlumniProfileSearchProjection(input: {
  readonly user: AlumniProjectionUserSource;
  readonly profile: AlumniProjectionProfileSource;
  readonly affiliations: readonly AlumniProjectionAffiliationSource[];
}): AlumniProfileSearchProjection {
  const displayName = alumniDisplayName(input.user);
  const generalLocation = alumniGeneralLocation(input.user);
  const skillKeys = normalizedUnique(input.profile.skills ?? [], MAX_SKILLS);
  const cohortKeys = normalizedUnique(
    input.affiliations.flatMap((affiliation) => {
      const combined = [affiliation.programName, affiliation.cohortLabel]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .join(" ");
      return [affiliation.programName, affiliation.cohortLabel, combined];
    }),
    Number.MAX_SAFE_INTEGER,
  );
  const searchText = boundedSearchText([
    displayName,
    input.user.company,
    input.profile.industry,
    ...(input.profile.skills ?? []),
    generalLocation,
    ...cohortKeys,
  ]);

  return Object.freeze({
    searchText,
    displayNameKey: boundedSearchKey(displayName),
    companyKey: boundedSearchKey(input.user.company),
    occupationKey: boundedSearchKey(input.user.occupation),
    industryKey: boundedSearchKey(input.profile.industry),
    skillKeys,
    generalLocationKey: boundedSearchKey(generalLocation),
    cohortKeys,
  });
}
