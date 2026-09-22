import { Link } from "react-router-dom";
import type { RegistrationProfileInput } from "@atcloud/shared-time/registration-profile";
import {
  getRegistrationProfileIssueLabels,
  getRegistrationProfileIssues,
} from "../../utils/registrationProfile";

interface ProfileCompletionNoticeProps {
  profile: RegistrationProfileInput;
  placement?: "global" | "profile";
  showAction?: boolean;
  className?: string;
}

export default function ProfileCompletionNotice({
  profile,
  placement = "global",
  showAction = true,
  className = "",
}: ProfileCompletionNoticeProps) {
  const issueLabels = getRegistrationProfileIssueLabels(
    getRegistrationProfileIssues(profile),
  );

  if (issueLabels.length === 0) return null;

  const testId =
    placement === "profile"
      ? "profile-completion-callout"
      : "profile-completion-banner";
  const headingId = `${testId}-heading`;

  return (
    <section
      className={`rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-sm ${className}`}
      aria-labelledby={headingId}
      data-testid={testId}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id={headingId} className="font-semibold">
            Complete your profile
          </h2>
          <p className="mt-1">
            Add or correct: {issueLabels.join(", ")}.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            This is required before publishing an Alumni Profile. Phone and
            birth year are not shown in Community or the Alumni Directory;
            other ERP features remain available.
          </p>
        </div>
        {showAction && (
          <Link
            to="/dashboard/profile?mode=complete"
            className="inline-flex shrink-0 items-center justify-center rounded-md bg-amber-700 px-4 py-2 font-medium text-white transition-colors hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2"
          >
            Complete profile
          </Link>
        )}
      </div>
    </section>
  );
}
