import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { alumniHelpService, type ConversationDTO } from "../../services/api";

const linkClass =
  "inline-flex min-h-8 items-center rounded font-medium text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

/**
 * Links an Alumni Help Room back to its request and, for the requester, to
 * the alumni member's Directory profile. The requester's own profile is not
 * linked for the provider because a requester need not have a public profile.
 */
export default function ChatRoomProfileLinks({
  conversation,
}: {
  conversation: Pick<ConversationDTO, "kind" | "helpRequestId" | "viewer">;
}) {
  const helpRequestId =
    conversation.kind === "alumni_help" ? conversation.helpRequestId : null;
  const isRequester = conversation.viewer.role === "requester";
  const [profile, setProfile] = useState<{
    requestId: string;
    profileId: string;
  } | null>(null);

  useEffect(() => {
    if (!helpRequestId || !isRequester) return;
    const controller = new AbortController();
    void alumniHelpService
      .get(helpRequestId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setProfile({
            requestId: helpRequestId,
            profileId: result.request.alumniProfileId,
          });
        }
      })
      .catch(() => {
        // The profile link is optional; the Room works without it.
      });
    return () => controller.abort();
  }, [helpRequestId, isRequester]);

  if (!helpRequestId) return null;
  const profileId =
    profile?.requestId === helpRequestId ? profile.profileId : null;

  return (
    <p className="mt-1 flex flex-wrap gap-x-4 text-xs">
      {profileId && (
        <Link
          className={linkClass}
          to={`/dashboard/community/alumni/${encodeURIComponent(profileId)}`}
        >
          View profile
        </Link>
      )}
      <Link
        className={linkClass}
        to={`/dashboard/community/help-requests/${encodeURIComponent(helpRequestId)}`}
      >
        View help request
      </Link>
    </p>
  );
}
