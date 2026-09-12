const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export const ALUMNI_HELP_WORKFLOW_METADATA_KIND =
  "alumni_help_workflow" as const;

/** Derives a fixed internal route; arbitrary URLs in notification metadata are ignored. */
export function getAlumniHelpRequestPath(
  metadata: unknown,
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const candidate = metadata as Record<string, unknown>;
  if (
    candidate.kind !== ALUMNI_HELP_WORKFLOW_METADATA_KIND ||
    typeof candidate.requestId !== "string" ||
    !OBJECT_ID_PATTERN.test(candidate.requestId)
  ) {
    return null;
  }
  return `/dashboard/community/help-requests/${candidate.requestId.toLowerCase()}`;
}
