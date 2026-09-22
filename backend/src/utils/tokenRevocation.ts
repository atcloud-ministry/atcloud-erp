export interface TokenIssuedAtClaim {
  readonly iat?: unknown;
}

export interface PasswordChangeMarker {
  readonly passwordChangedAt?: unknown;
}

/**
 * JWT iat uses whole seconds, while passwordChangedAt has millisecond precision.
 * Fail closed at the same-second boundary because issuance order is ambiguous.
 */
export function isTokenCurrentForPasswordChange(
  token: TokenIssuedAtClaim,
  user: PasswordChangeMarker,
): boolean {
  if (user.passwordChangedAt == null) return true;
  const changedAt =
    user.passwordChangedAt instanceof Date
      ? user.passwordChangedAt
      : new Date(user.passwordChangedAt as string | number);
  if (Number.isNaN(changedAt.getTime())) return false;
  if (
    typeof token.iat !== "number" ||
    !Number.isSafeInteger(token.iat) ||
    token.iat < 0
  ) {
    return false;
  }
  return token.iat > Math.floor(changedAt.getTime() / 1_000);
}
