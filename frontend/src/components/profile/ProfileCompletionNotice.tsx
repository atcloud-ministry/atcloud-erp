import { Link } from "react-router-dom";
import { ArrowRightIcon, UserCircleIcon } from "@heroicons/react/24/outline";
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
      className={`rounded-xl border border-accent-200 bg-accent-50/70 px-4 py-3 text-sm text-accent-900 ${className}`}
      aria-labelledby={headingId}
      data-testid={testId}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span
          aria-hidden="true"
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-700 sm:flex"
        >
          <UserCircleIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p>
            <span id={headingId} className="font-semibold">
              Complete your profile
            </span>
            <span className="text-accent-800">
              {" "}
              · Add or correct: {issueLabels.join(", ")}.
            </span>
          </p>
          <details className="group mt-0.5">
            <summary className="inline-flex cursor-pointer list-none items-center text-xs font-medium text-accent-700 underline decoration-accent-300 underline-offset-2 hover:text-accent-900 [&::-webkit-details-marker]:hidden">
              Why is this needed?
            </summary>
            <p className="mt-1 text-xs text-accent-800">
              This is required before publishing an Alumni Profile. Phone and
              birth year are not shown in Community or the Alumni Directory;
              other ERP features remain available.
            </p>
          </details>
        </div>
        {showAction && (
          <Link
            to="/dashboard/profile?mode=complete"
            className="group inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-accent-700 px-4 py-1.5 font-medium text-white transition-colors hover:bg-accent-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-2"
          >
            Complete profile
            <ArrowRightIcon
              aria-hidden="true"
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        )}
      </div>
    </section>
  );
}
