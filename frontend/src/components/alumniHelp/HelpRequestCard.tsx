import { Link } from "react-router-dom";
import type { AlumniHelpRequestSummaryDTO } from "../../services/api";
import { Card } from "../ui";
import HelpStatusBadge from "./HelpStatusBadge";
import {
  HELP_TYPE_LABELS,
  formatHelpDate,
  outcomeLabel,
} from "./presentation";

export default function HelpRequestCard({
  request,
}: {
  request: AlumniHelpRequestSummaryDTO;
}) {
  const counterpart =
    request.viewerRole === "requester" ? request.provider : request.requester;
  const detailPath = `/dashboard/community/help-requests/${request.id}`;

  return (
    <Card padding="md">
      <article className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              {request.viewerRole === "requester" ? "Sent to" : "Received from"}
            </p>
            <h2 className="mt-1 break-words text-lg font-semibold text-gray-900">
              <Link
                className="rounded-sm hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                to={detailPath}
              >
                {counterpart.displayName}
              </Link>
            </h2>
          </div>
          <HelpStatusBadge status={request.status} />
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium text-gray-500">Requested</dt>
            <dd className="mt-1 text-gray-900">
              {HELP_TYPE_LABELS[request.requestedHelpType]}
            </dd>
          </div>
          {request.proposedHelpType && (
            <div>
              <dt className="font-medium text-gray-500">Proposed</dt>
              <dd className="mt-1 text-gray-900">
                {HELP_TYPE_LABELS[request.proposedHelpType]}
              </dd>
            </div>
          )}
          {request.agreedHelpType && (
            <div>
              <dt className="font-medium text-gray-500">Agreed</dt>
              <dd className="mt-1 text-gray-900">
                {HELP_TYPE_LABELS[request.agreedHelpType]}
              </dd>
            </div>
          )}
        </dl>

        {request.latestOutcome && (
          <p className="mt-4 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
            Latest reported result: {outcomeLabel(
              request.latestOutcome.agreedHelpType,
              request.latestOutcome.outcomeCode,
            )}{" "}
            <span className="font-medium">({request.latestOutcome.status})</span>
          </p>
        )}

        <div className="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-500">
            Updated <time dateTime={request.updatedAt}>{formatHelpDate(request.updatedAt)}</time>
          </p>
          <div className="flex items-center gap-3">
            {request.actionRequiredForViewer && (
              <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
                Action required
              </span>
            )}
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              to={detailPath}
            >
              View Request
            </Link>
          </div>
        </div>
      </article>
    </Card>
  );
}
