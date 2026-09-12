import { ArrowLeftIcon, MapPinIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DirectoryAvatar from "../components/directory/DirectoryAvatar";
import DirectoryHelpOfferings from "../components/directory/DirectoryHelpOfferings";
import { affiliationLabel } from "../components/directory/AlumniDirectoryCard";
import { Button, Card, ErrorState, LoadingState } from "../components/ui";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import {
  alumniDirectoryService,
  type DirectoryDetailDTO,
} from "../services/api";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function professionalLine(profile: DirectoryDetailDTO): string | null {
  return [profile.occupation, profile.company].filter(Boolean).join(" · ") || null;
}

export default function AlumniDirectoryDetail() {
  const { profileId = "" } = useParams<{ profileId: string }>();
  const { config, status: runtimeStatus } = useRuntimeConfig();
  const [loadedProfile, setLoadedProfile] = useState<{
    profileId: string;
    value: DirectoryDetailDTO;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);

  useEffect(() => {
    if (
      runtimeStatus !== "ready" ||
      !config.alumniNetwork.readable ||
      !OBJECT_ID_PATTERN.test(profileId)
    ) {
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void alumniDirectoryService
      .get(profileId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setLoadedProfile({ profileId, value: result });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const status = (reason as { status?: unknown } | null)?.status;
        setError(
          status === 404
            ? "This alumni profile is not available."
            : reason instanceof Error
              ? reason.message
              : "Unable to load this alumni profile.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [config.alumniNetwork.readable, profileId, reloadSequence, runtimeStatus]);

  const profile =
    loadedProfile?.profileId === profileId ? loadedProfile.value : null;

  if (runtimeStatus === "loading") {
    return <LoadingState message="Loading alumni profile..." />;
  }

  if (runtimeStatus !== "ready" || !config.alumniNetwork.readable) {
    return (
      <ErrorState
        message="The Alumni Directory is temporarily unavailable."
        title="Alumni Directory unavailable"
      />
    );
  }

  if (!OBJECT_ID_PATTERN.test(profileId)) {
    return (
      <ErrorState
        action={
          <Link className="font-medium text-blue-700 hover:text-blue-800" to="/dashboard/community/alumni">
            Return to Alumni Directory
          </Link>
        }
        message="This alumni profile is not available."
        title="Profile not found"
      />
    );
  }

  if (loading && !profile) {
    return <LoadingState message="Loading alumni profile..." />;
  }

  if (error || !profile) {
    return (
      <ErrorState
        action={
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <button
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              onClick={() => setReloadSequence((value) => value + 1)}
              type="button"
            >
              Try Again
            </button>
            <Link className="font-medium text-blue-700 hover:text-blue-800" to="/dashboard/community/alumni">
              Back to Directory
            </Link>
          </div>
        }
        message={error ?? "This alumni profile is not available."}
        title="Unable to load profile"
      />
    );
  }

  const roleAndCompany = professionalLine(profile);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link
        className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        to="/dashboard/community/alumni"
      >
        <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
        Alumni Directory
      </Link>

      <Card padding="lg">
        <article aria-busy={loading} className="min-w-0">
          <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <DirectoryAvatar
              avatar={profile.avatar}
              displayName={profile.displayName}
              size="detail"
            />
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-2xl font-bold text-gray-900 sm:text-3xl">
                {profile.displayName}
              </h1>
              {profile.professionalHeadline && (
                <p className="mt-2 break-words text-base text-gray-700">
                  {profile.professionalHeadline}
                </p>
              )}
              {roleAndCompany && (
                <p className="mt-1 break-words text-sm text-gray-600">
                  {roleAndCompany}
                </p>
              )}
              {profile.generalLocation && (
                <p className="mt-2 flex items-start gap-1.5 text-sm text-gray-600">
                  <MapPinIcon
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span className="break-words">{profile.generalLocation}</span>
                </p>
              )}
            </div>
          </header>

          <div className="mt-6 grid grid-cols-1 gap-6 border-t border-gray-200 pt-6 md:grid-cols-[minmax(0,1fr)_minmax(15rem,0.7fr)]">
            <div className="min-w-0 space-y-6">
              {profile.bio && (
                <section aria-labelledby="alumni-bio-title">
                  <h2 className="text-lg font-semibold text-gray-900" id="alumni-bio-title">
                    About
                  </h2>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">
                    {profile.bio}
                  </p>
                </section>
              )}

              {profile.industry && (
                <section aria-labelledby="alumni-industry-title">
                  <h2 className="text-lg font-semibold text-gray-900" id="alumni-industry-title">
                    Industry
                  </h2>
                  <p className="mt-2 break-words text-sm text-gray-700">
                    {profile.industry}
                  </p>
                </section>
              )}

              {profile.skills.length > 0 && (
                <section aria-labelledby="alumni-skills-title">
                  <h2 className="text-lg font-semibold text-gray-900" id="alumni-skills-title">
                    Skills
                  </h2>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {profile.skills.map((skill, index) => (
                      <li
                        className="max-w-full break-words rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-800"
                        key={`${skill}-${index}`}
                      >
                        {skill}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-labelledby="alumni-affiliations-title">
                <h2 className="text-lg font-semibold text-gray-900" id="alumni-affiliations-title">
                  Verified alumni affiliations
                </h2>
                <ul className="mt-2 space-y-2">
                  {profile.affiliations.map((affiliation) => (
                    <li
                      className="break-words rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700"
                      key={affiliation.id}
                    >
                      {affiliationLabel(affiliation)}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <aside className="min-w-0 rounded-lg bg-gray-50 p-4">
              <DirectoryHelpOfferings offerings={profile.helpOfferings} />
              <span
                className="mt-5 block"
                title="Request Help will be enabled with the Alumni Help workflow"
              >
                <Button
                  aria-describedby={`request-help-note-${profile.id}`}
                  className="min-h-11 w-full"
                  disabled
                  type="button"
                >
                  Request Help
                </Button>
              </span>
              <span className="sr-only" id={`request-help-note-${profile.id}`}>
                Request Help is not available yet.
              </span>
            </aside>
          </div>
        </article>
      </Card>
    </div>
  );
}

export { professionalLine };
