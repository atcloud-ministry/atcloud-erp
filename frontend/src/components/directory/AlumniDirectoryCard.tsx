import { MapPinIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";
import type { DirectoryCardDTO } from "../../services/api";
import { Button, Card } from "../ui";
import DirectoryAvatar from "./DirectoryAvatar";
import DirectoryHelpOfferings from "./DirectoryHelpOfferings";
import { hasEnabledHelpOffering } from "../alumniHelp/presentation";

function occupationAndCompany(profile: DirectoryCardDTO): string | null {
  return [profile.occupation, profile.company].filter(Boolean).join(" · ") || null;
}

export function affiliationLabel(
  affiliation: DirectoryCardDTO["affiliations"][number],
): string {
  return [affiliation.programName, affiliation.cohortLabel]
    .filter(Boolean)
    .join(" ");
}

export default function AlumniDirectoryCard({
  profile,
  writable = true,
}: {
  profile: DirectoryCardDTO;
  writable?: boolean;
}) {
  const professionalLine = occupationAndCompany(profile);
  const profilePath = `/dashboard/community/alumni/${profile.id}`;
  const canRequestHelp = writable && hasEnabledHelpOffering(profile);

  return (
    <Card className="flex h-full min-w-0 flex-col" padding="md">
      <article className="flex h-full min-w-0 flex-col">
        <div className="flex min-w-0 items-start gap-4">
          <DirectoryAvatar avatar={profile.avatar} displayName={profile.displayName} />
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-lg font-semibold text-gray-900">
              <Link
                className="rounded-sm hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                to={profilePath}
              >
                {profile.displayName}
              </Link>
            </h2>
            {profile.professionalHeadline && (
              <p className="mt-1 break-words text-sm text-gray-700">
                {profile.professionalHeadline}
              </p>
            )}
            {professionalLine && (
              <p className="mt-1 break-words text-sm text-gray-600">
                {professionalLine}
              </p>
            )}
          </div>
        </div>

        {(profile.generalLocation || profile.affiliations.length > 0) && (
          <div className="mt-4 space-y-2 text-sm text-gray-600">
            {profile.generalLocation && (
              <p className="flex items-start gap-1.5">
                <MapPinIcon
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span className="break-words">{profile.generalLocation}</span>
              </p>
            )}
            {profile.affiliations.length > 0 && (
              <ul aria-label="Verified alumni affiliations" className="flex flex-wrap gap-2">
                {profile.affiliations.map((affiliation) => (
                  <li
                    className="max-w-full break-words rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700"
                    key={affiliation.id}
                  >
                    {affiliationLabel(affiliation)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-5 flex-1 border-t border-gray-100 pt-4">
          <DirectoryHelpOfferings offerings={profile.helpOfferings} />
        </div>

        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Link
            className="inline-flex min-h-10 items-center justify-center rounded-md border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            to={profilePath}
          >
            View Profile
          </Link>
          {canRequestHelp ? (
            <Link
              className="inline-flex min-h-10 w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              to={`${profilePath}?requestHelp=1`}
            >
              Request Help
            </Link>
          ) : (
            <>
              <span
                title={
                  writable
                    ? "This alumni member is not currently offering help"
                    : "Alumni Help is currently read-only"
                }
              >
                <Button
                  aria-describedby={`request-help-note-${profile.id}`}
                  className="min-h-10 w-full"
                  disabled
                  size="small"
                  type="button"
                >
                  Request Help
                </Button>
              </span>
              <span className="sr-only" id={`request-help-note-${profile.id}`}>
                {writable
                  ? "This alumni member is not currently offering help."
                  : "Alumni Help is currently read-only."}
              </span>
            </>
          )}
        </div>
      </article>
    </Card>
  );
}
