import type { AlumniHelpTimelineEntryDTO } from "../../services/api";
import {
  HELP_TYPE_LABELS,
  LIFECYCLE_ACTION_LABELS,
  formatHelpDate,
} from "./presentation";

export default function HelpTimeline({
  entries,
}: {
  entries: AlumniHelpTimelineEntryDTO[];
}) {
  return (
    <section aria-labelledby="help-timeline-heading">
      <h2 className="text-lg font-semibold text-gray-900" id="help-timeline-heading">
        Request progress
      </h2>
      <ol className="mt-4 space-y-4 border-l-2 border-blue-100 pl-5">
        {entries.map((entry) => (
          <li className="relative" key={entry.id}>
            <span
              aria-hidden="true"
              className="absolute -left-[1.7rem] top-1.5 h-3 w-3 rounded-full bg-blue-600 ring-4 ring-white"
            />
            <p className="font-medium text-gray-900">
              {LIFECYCLE_ACTION_LABELS[entry.action]}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {entry.actorRole === "requester" ? "Requester" : "Provider"} ·{" "}
              <time dateTime={entry.occurredAt}>
                {formatHelpDate(entry.occurredAt)}
              </time>
            </p>
            {entry.helpType && (
              <p className="mt-1 text-sm text-gray-700">
                {HELP_TYPE_LABELS[entry.helpType]}
              </p>
            )}
            {entry.note && (
              <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-gray-50 p-3 text-sm text-gray-700">
                {entry.note}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
