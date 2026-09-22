import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useRuntimeConfig } from "../../contexts/RuntimeConfigContext";
import { alumniDirectoryService } from "../../services/api";
import type { AuthUser } from "../../types";
import { isRegistrationProfileComplete } from "../../utils/registrationProfile";

interface Props {
  user: AuthUser;
  pathname: string;
}

export default function AlumniProfileOnboardingNotice({ user, pathname }: Props) {
  const { config } = useRuntimeConfig();
  const [draftAt, setDraftAt] = useState<{
    userId: string;
    pathname: string;
    missing: boolean;
  } | null>(null);
  const [dismissedUserId, setDismissedUserId] = useState<string | null>(null);
  const accountComplete = isRegistrationProfileComplete(user);

  useEffect(() => {
    if (!config.alumniNetwork.readable || !accountComplete) {
      setDraftAt(null);
      return;
    }

    const controller = new AbortController();
    void alumniDirectoryService.getOwn(controller.signal).then(
      (profile) => {
        if (!controller.signal.aborted) {
          setDraftAt(profile.publishStatus === "draft"
            ? { userId: user.id, pathname, missing: false }
            : null);
        }
      },
      (error) => {
        if (controller.signal.aborted) return;
        const missing = Boolean(
          error &&
          typeof error === "object" &&
          "status" in error &&
          (error as { status?: unknown }).status === 404,
        );
        setDraftAt(missing && config.alumniNetwork.writable
          ? { userId: user.id, pathname, missing: true }
          : null);
      },
    );

    return () => controller.abort();
  }, [accountComplete, config.alumniNetwork.readable, config.alumniNetwork.writable, pathname, user.id]);

  if (
    draftAt?.userId !== user.id ||
    draftAt.pathname !== pathname ||
    !accountComplete ||
    dismissedUserId === user.id ||
    /^\/dashboard\/community\/alumni\/me\/?$/i.test(pathname)
  ) {
    return null;
  }

  return (
    <section
      aria-labelledby="alumni-profile-onboarding-heading"
      className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 shadow-sm"
      data-testid="alumni-profile-onboarding-notice"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="alumni-profile-onboarding-heading" className="font-semibold">
            Complete your Alumni Profile
          </h2>
          <p className="mt-1">
            {draftAt.missing
              ? "Set up your private draft, add your career details, and choose what to share with the Alumni Directory."
              : "Your private draft is ready. Add your career details and choose what to share with the Alumni Directory."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2"
            to="/dashboard/community/alumni/me"
          >
            Continue to Alumni Profile
          </Link>
          <button
            aria-label="Dismiss Alumni Profile reminder"
            className="rounded-md px-2 py-2 text-blue-800 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            onClick={() => setDismissedUserId(user.id)}
            type="button"
          >
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
