import { isIP } from "net";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IPV4_PATTERN = /(?:\d{1,3}\.){3}\d{1,3}/g;
const BEARER_PATTERN = /Bearer\s+[^\s,;]+/gi;
const SECRET_QUERY_PATTERN =
  /([?&](?:token|secret|password|api_key|apikey|access_key)=)[^&#\s]*/gi;

const IPV6_MAX_TEXT_LENGTH = 45;
const IPV6_CHARACTER = /^[A-Fa-f0-9:.]$/;

function redactIpv6(value: string): string {
  let cursor = 0;
  let result = "";

  while (cursor < value.length) {
    let matchStart = -1;
    let matchEnd = -1;

    for (let start = cursor; start < value.length; start += 1) {
      if (!IPV6_CHARACTER.test(value[start])) continue;

      let colonCount = 0;
      let longestEnd = -1;
      const maximumEnd = Math.min(
        value.length,
        start + IPV6_MAX_TEXT_LENGTH,
      );
      for (let end = start + 1; end <= maximumEnd; end += 1) {
        const character = value[end - 1];
        if (!IPV6_CHARACTER.test(character)) break;
        if (character === ":") colonCount += 1;
        if (
          colonCount >= 2 &&
          isIP(value.slice(start, end)) === 6
        ) {
          longestEnd = end;
        }
      }

      if (longestEnd !== -1) {
        matchStart = start;
        matchEnd = longestEnd;
        break;
      }
    }

    if (matchStart === -1) {
      result += value.slice(cursor);
      break;
    }

    result += `${value.slice(cursor, matchStart)}[IP_REDACTED]`;
    cursor = matchEnd;
  }

  return result;
}

/** Redact common secret and contact-data patterns from bounded log strings. */
export function scrubSensitiveString(value: string): string {
  const scrubbed = value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SECRET_QUERY_PATTERN, "$1[REDACTED]")
    .replace(EMAIL_PATTERN, "[EMAIL_REDACTED]")
    .replace(IPV4_PATTERN, "[IP_REDACTED]");

  return redactIpv6(scrubbed).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  );
}
