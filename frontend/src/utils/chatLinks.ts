import { ISO_COUNTRY_OPTIONS } from "@atcloud/shared-time/registration-profile-options";
import { isValidChatSafeLinkUrl } from "../services/api";

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * Accept addresses typed without a scheme ("www.example.com",
 * "example.com/page") by assuming https://. Anything else is returned
 * trimmed so the existing validation can report it.
 */
export function normalizeChatLinkInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || SCHEME_PATTERN.test(trimmed) || trimmed.startsWith("//")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function withoutWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, "");
}

/** The destination's host name, shown under every link label. */
export function chatLinkDestinationHost(url: string): string | null {
  try {
    return withoutWww(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

// Kept in step with backend/src/contracts/chatRooms.ts.
const LABEL_HOST_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,}))/giu;

const ADDRESS_LIKE_ENDINGS: ReadonlySet<string> = new Set([
  ...ISO_COUNTRY_OPTIONS.map((country) => country.code.toLowerCase()),
  "uk",
  "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "io",
  "app", "dev", "ai", "co", "me", "xyz", "site", "online", "link", "click",
  "shop", "store", "top", "live", "page", "tech", "cloud", "church",
]);

/**
 * True when the label names a web address other than the link's real
 * destination, such as "google.com" pointing at another site.
 */
export function isDeceptiveChatLinkLabel(label: string, url: string): boolean {
  let destination: URL;
  try {
    destination = new URL(url);
  } catch {
    return true;
  }
  try {
    if (new URL(label.trim()).href === destination.href) return false;
  } catch {
    // Not a full URL; inspect it for embedded addresses below.
  }
  const destinationHost = withoutWww(destination.hostname);
  for (const match of label.matchAll(LABEL_HOST_PATTERN)) {
    const [, scheme, host, ending] = match;
    const addressLike =
      Boolean(scheme) ||
      /^www\./iu.test(host) ||
      ADDRESS_LIKE_ENDINGS.has(ending.toLowerCase());
    if (!addressLike) continue;
    let named: string;
    try {
      named = withoutWww(new URL(`https://${host}`).hostname);
    } catch {
      return true;
    }
    if (destinationHost !== named && !destinationHost.endsWith(`.${named}`)) {
      return true;
    }
  }
  return false;
}

export type ChatTextSegment =
  | { readonly text: string; readonly href?: undefined }
  | { readonly text: string; readonly href: string };

const TEXT_LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/u;

function trimTrailing(candidate: string): string {
  let result = candidate.replace(TRAILING_PUNCTUATION, "");
  // Drop a closing bracket that has no opening partner, e.g. "(see x.com)".
  while (/[)\]}]$/u.test(result)) {
    const close = result[result.length - 1];
    const open = { ")": "(", "]": "[", "}": "{" }[close] as string;
    if (result.split(open).length >= result.split(close).length) break;
    result = result.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return result;
}

/**
 * Split message text into plain and linked segments. The visible text of a
 * link is always the address itself, so it cannot disguise its destination.
 */
export function splitChatTextLinks(text: string): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TEXT_LINK_PATTERN)) {
    const start = match.index ?? 0;
    const linkText = trimTrailing(match[0]);
    const href = normalizeChatLinkInput(linkText);
    if (!linkText || !isValidChatSafeLinkUrl(href)) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: linkText, href });
    cursor = start + linkText.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
