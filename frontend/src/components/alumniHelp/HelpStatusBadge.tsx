import type { AlumniHelpRequestStatus } from "../../services/api";
import { HELP_STATUS_LABELS } from "./presentation";

const STATUS_STYLES: Readonly<Record<AlumniHelpRequestStatus, string>> = {
  requested: "bg-blue-50 text-blue-800 ring-blue-600/20",
  needs_information: "bg-amber-50 text-amber-800 ring-amber-600/20",
  alternative_proposed: "bg-purple-50 text-purple-800 ring-purple-600/20",
  accepted: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  declined: "bg-gray-100 text-gray-700 ring-gray-500/20",
  withdrawn: "bg-gray-100 text-gray-700 ring-gray-500/20",
  in_progress: "bg-cyan-50 text-cyan-800 ring-cyan-600/20",
  completed: "bg-green-50 text-green-800 ring-green-600/20",
  closed: "bg-gray-100 text-gray-700 ring-gray-500/20",
};

export default function HelpStatusBadge({
  status,
}: {
  status: AlumniHelpRequestStatus;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {HELP_STATUS_LABELS[status]}
    </span>
  );
}
