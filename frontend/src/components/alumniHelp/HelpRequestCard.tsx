import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { Link } from "react-router-dom";
import type { AlumniHelpRequestSummaryDTO } from "../../services/api";
import ChatAvatar from "../chat/ChatAvatar";
import HelpStatusBadge from "./HelpStatusBadge";
import {
  HELP_TYPE_LABELS,
  formatHelpDate,
  outcomeLabel,
} from "./presentation";

/** One row in the Help Requests list; render inside a `<ul>`. */
export default function HelpRequestCard({
  request,
}: {
  request: AlumniHelpRequestSummaryDTO;
}) {
  const counterpart =
    request.viewerRole === "requester" ? request.provider : request.requester;
  const detailPath = `/dashboard/community/help-requests/${request.id}`;
  const helpTypes = [
    ["Requested", request.requestedHelpType],
    ["Proposed", request.proposedHelpType],
    ["Agreed", request.agreedHelpType],
  ] as const;

  return (
    <li className="relative transition-colors hover:bg-gray-50">
      <article className="flex min-w-0 gap-3.5 px-4 py-4 sm:px-5">
        <span className="relative mt-0.5">
          <ChatAvatar
            avatar={counterpart.avatar}
            displayName={counterpart.displayName}
          />
          {request.hasUnreadUpdate && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-brand-600 ring-2 ring-white"
            />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="min-w-0 break-words text-[0.9375rem] font-semibold text-gray-900">
              <Link
                className="rounded-sm text-gray-900 after:absolute after:inset-0 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                to={detailPath}
              >
                {counterpart.displayName}
              </Link>
            </h2>
            <HelpStatusBadge status={request.status} />
          </div>

          <p className="mt-1 text-sm text-gray-500">
            <span>
              {request.viewerRole === "requester" ? "Sent to" : "Received from"}
            </span>
            {helpTypes.map(([label, type]) =>
              type ? (
                <span key={label}>
                  <span aria-hidden="true" className="px-1.5 text-gray-300">
                    ·
                  </span>
                  {label}:{" "}
                  <span className="text-gray-700">{HELP_TYPE_LABELS[type]}</span>
                </span>
              ) : null,
            )}
          </p>

          <p className="mt-1 text-xs text-gray-400 sm:hidden">
            Updated <time dateTime={request.updatedAt}>{formatHelpDate(request.updatedAt)}</time>
          </p>

          {request.latestOutcome && (
            <p className="mt-1 text-sm text-gray-600">
              Latest reported result: {outcomeLabel(
                request.latestOutcome.agreedHelpType,
                request.latestOutcome.outcomeCode,
              )}{" "}
              <span className="font-medium">({request.latestOutcome.status})</span>
            </p>
          )}

          {(request.hasUnreadUpdate || request.actionRequiredForViewer) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {request.hasUnreadUpdate && (
                <span className="whitespace-nowrap rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                  New update
                </span>
              )}
              {request.actionRequiredForViewer && (
                <span className="whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                  Action required
                </span>
              )}
            </div>
          )}
        </div>

        <div className="hidden shrink-0 flex-col items-end justify-between gap-2 sm:flex">
          <p className="text-xs text-gray-400">
            Updated <time dateTime={request.updatedAt}>{formatHelpDate(request.updatedAt)}</time>
          </p>
          {/* Sits above the row-wide link so it stays individually clickable. */}
          <Link
            className="relative z-10 inline-flex items-center gap-0.5 rounded-sm text-sm font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            to={detailPath}
          >
            View Request
            <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </article>
    </li>
  );
}
