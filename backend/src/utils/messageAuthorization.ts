export type MessageRoleVisibilityClause = Record<string, unknown>;

/**
 * Match messages without a role restriction, plus messages that include the
 * user's current role. Omitting the role is fail-closed for restricted
 * messages.
 */
export function buildMessageRoleVisibilityClauses(
  userRole?: string
): MessageRoleVisibilityClause[] {
  const clauses: MessageRoleVisibilityClause[] = [
    { targetRoles: { $exists: false } },
    { targetRoles: { $size: 0 } },
  ];

  if (userRole) {
    clauses.push({ targetRoles: userRole });
  }

  return clauses;
}

export function isMessageRoleVisible(
  targetRoles: unknown,
  userRole?: string
): boolean {
  if (typeof targetRoles === "undefined") {
    return true;
  }
  if (!Array.isArray(targetRoles)) return false;
  if (targetRoles.length === 0) return true;
  return Boolean(userRole && targetRoles.includes(userRole));
}
