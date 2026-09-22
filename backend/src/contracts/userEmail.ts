/**
 * Canonical validation contract for email addresses persisted on User.
 *
 * Keep consumers aligned with the existing registration constraint until a
 * separately approved migration broadens that contract.
 */
export const USER_PERSISTED_EMAIL_PATTERN =
  /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;

export function isValidPersistedUserEmail(value: string): boolean {
  return USER_PERSISTED_EMAIL_PATTERN.test(value);
}
