import { normalizeSearchText } from "@atcloud/shared-time/registration-profile";
import {
  ISO_COUNTRY_OPTIONS,
  ISO_SUBDIVISION_OPTIONS,
} from "@atcloud/shared-time/registration-profile-options";
import { escapeRegex } from "../../utils/search";

const MAX_SEARCH_TOKENS = 12;
const MAX_QUALIFIER_WORDS = 5;
const SYMBOL_PATTERN = /[\p{P}\p{S}]/u;

/**
 * Normalized names and codes of countries and states/provinces. Users often
 * type these as trailing qualifiers ("San Diego, CA"), but the Directory only
 * searches the public general location, so they are dropped rather than
 * matched against private residence fields.
 */
const LOCATION_QUALIFIERS: ReadonlySet<string> = (() => {
  const values = new Set<string>(["usa", "us", "uk", "united states of america"]);
  const add = (value: string) => {
    const normalized = normalizeSearchText(value);
    if (normalized) values.add(normalized);
  };
  for (const country of ISO_COUNTRY_OPTIONS) {
    add(country.code);
    add(country.name);
    add(country.name.split(",")[0]);
  }
  for (const subdivision of ISO_SUBDIVISION_OPTIONS) {
    add(subdivision.code.slice(subdivision.code.indexOf("-") + 1));
    add(subdivision.name);
  }
  return values;
})();

/**
 * Split user input into normalized words. A symbol-bearing word such as C++
 * normalizes to a single letter; that lossy key would match unrelated
 * profiles, so it is skipped and left to the escaped raw-field matching.
 */
function wordsOf(value: string): string[] {
  const tokens: string[] = [];
  for (const word of value.split(/\s+/u)) {
    const normalized = normalizeSearchText(word);
    if (!normalized) continue;
    if (SYMBOL_PATTERN.test(word) && normalized.replace(/\s+/gu, "").length < 2) {
      continue;
    }
    tokens.push(...normalized.split(" "));
  }
  return tokens;
}

/**
 * Remove trailing country/state qualifiers while at least one word remains.
 * The longest qualifier wins, so "New York" stays whole instead of losing the
 * "York" that is also a region name elsewhere.
 */
function withoutTrailingQualifiers(tokens: readonly string[]): string[] {
  const result = [...tokens];
  let stripped = true;
  while (stripped && result.length > 1) {
    stripped = false;
    const longest = Math.min(MAX_QUALIFIER_WORDS, result.length);
    for (let size = longest; size >= 1; size -= 1) {
      if (!LOCATION_QUALIFIERS.has(result.slice(-size).join(" "))) continue;
      if (size === result.length) return result;
      result.splice(-size, size);
      stripped = true;
      break;
    }
  }
  return result;
}

function unique(tokens: readonly string[]): string[] {
  return Array.from(new Set(tokens)).slice(0, MAX_SEARCH_TOKENS);
}

/**
 * Words for the free-text search. Comma-separated trailing segments that are
 * only a country or state ("San Diego, CA, USA") are dropped.
 */
export function freeTextSearchTokens(value: string): string[] {
  const segments = value.split(",");
  while (segments.length > 1) {
    const last = normalizeSearchText(segments[segments.length - 1]);
    if (last && !LOCATION_QUALIFIERS.has(last)) break;
    segments.pop();
  }
  return unique(wordsOf(segments.join(" ")));
}

/** Words for a field filter such as company, industry, skill, or cohort. */
export function filterSearchTokens(value: string): string[] {
  return unique(wordsOf(value));
}

/** Words for the location filter, without trailing country/state qualifiers. */
export function locationSearchTokens(value: string): string[] {
  return unique(withoutTrailingQualifiers(wordsOf(value)));
}

/** Matches a normalized key containing a word that starts with `token`. */
export function wordPrefixRegex(token: string): RegExp {
  return new RegExp(`(?:^| )${escapeRegex(token)}`);
}

/**
 * Every token must start a word in at least one of the normalized projection
 * fields. Returns null when no usable token remains.
 */
export function everyTokenMatch(
  tokens: readonly string[],
  fields: readonly string[],
): Record<string, unknown> | null {
  if (tokens.length === 0 || fields.length === 0) return null;
  const clauses = tokens.map((token) => {
    const regex = wordPrefixRegex(token);
    const alternatives = fields.map((field) => ({ [field]: regex }));
    return alternatives.length === 1 ? alternatives[0] : { $or: alternatives };
  });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}
