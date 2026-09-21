import { useEffect, useState } from "react";
import type {
  AlumniHelpOutcomeCode,
  AlumniHelpRequestDetailDTO,
} from "../../services/api";
import { Button } from "../ui";
import { formatHelpDate, outcomeLabel, outcomeOptions } from "./presentation";

interface HelpOutcomePanelProps {
  request: AlumniHelpRequestDetailDTO;
  writable: boolean;
  busy: boolean;
  onSubmit: (outcomeCode: AlumniHelpOutcomeCode) => void;
  onDecision: (decision: "confirm" | "deny") => void;
}

export default function HelpOutcomePanel({
  request,
  writable,
  busy,
  onSubmit,
  onDecision,
}: HelpOutcomePanelProps) {
  const [outcomeCode, setOutcomeCode] = useState<AlumniHelpOutcomeCode | "">(
    "",
  );
  const canSubmit =
    request.availableActions.includes("submit_outcome") ||
    request.availableActions.includes("resubmit_outcome");
  const agreedType = request.agreedHelpType;

  useEffect(() => setOutcomeCode(""), [request.revision]);

  return (
    <section aria-labelledby="help-outcome-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900" id="help-outcome-heading">
          Reported result
        </h2>
        <p className="text-xs text-gray-500">
          Results are submitted by the help recipient.
        </p>
      </div>

      {request.outcomes.length === 0 && !canSubmit && (
        <p className="mt-3 text-sm text-gray-600">No result has been submitted.</p>
      )}

      {request.outcomes.length > 0 && (
        <ol className="mt-4 space-y-3">
          {[...request.outcomes].reverse().map((outcome) => (
            <li className="rounded-lg border border-gray-200 p-4" key={outcome.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-gray-900">
                    Revision {outcome.revisionNumber}: {outcomeLabel(
                      outcome.agreedHelpType,
                      outcome.outcomeCode,
                    )}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Submitted{" "}
                    <time dateTime={outcome.submittedAt}>
                      {formatHelpDate(outcome.submittedAt)}
                    </time>
                  </p>
                </div>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium capitalize text-gray-700">
                  {outcome.status}
                </span>
              </div>
              {outcome.status === "pending" && (
                <p className="mt-3 text-sm text-amber-800">
                  Awaiting provider confirmation until{" "}
                  <time dateTime={outcome.dueAt}>{formatHelpDate(outcome.dueAt)}</time>.
                </p>
              )}
              {outcome.status === "confirmed" && outcome.confirmationMethod && (
                <p className="mt-3 text-sm text-green-800">
                  Confirmed {outcome.confirmationMethod === "automatic_20_day"
                    ? "automatically after 20 days"
                    : "by the provider"}. This request is closed.
                </p>
              )}
              {outcome.status === "denied" && (
                <p className="mt-3 text-sm text-red-700">
                  The provider denied this revision. The recipient can submit a new revision.
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

      {writable &&
        request.latestOutcome?.status === "pending" &&
        (request.availableActions.includes("confirm_outcome") ||
          request.availableActions.includes("deny_outcome")) && (
          <div className="mt-4 flex flex-col gap-3 rounded-lg bg-blue-50 p-4 sm:flex-row">
            {request.availableActions.includes("confirm_outcome") && (
              <Button
                disabled={busy}
                onClick={() => onDecision("confirm")}
                type="button"
                variant="success"
              >
                Confirm Result
              </Button>
            )}
            {request.availableActions.includes("deny_outcome") && (
              <Button
                disabled={busy}
                onClick={() => onDecision("deny")}
                type="button"
                variant="danger"
              >
                Deny Result
              </Button>
            )}
          </div>
        )}

      {writable && canSubmit && agreedType && (
        <form
          className="mt-5 rounded-lg border border-blue-100 bg-blue-50 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (outcomeCode) onSubmit(outcomeCode);
          }}
        >
          <fieldset>
            <legend className="font-medium text-gray-900">
              {request.availableActions.includes("resubmit_outcome")
                ? "Submit a revised result"
                : "Record the result"}
            </legend>
            <div className="mt-3 space-y-2">
              {outcomeOptions(agreedType).map((option) => (
                <label
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md bg-white px-3 py-2 text-sm text-gray-800"
                  key={option.value}
                >
                  <input
                    checked={outcomeCode === option.value}
                    className="mt-1"
                    name="outcomeCode"
                    onChange={() => setOutcomeCode(option.value)}
                    type="radio"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button
            className="mt-4 w-full sm:w-auto"
            disabled={!outcomeCode || busy}
            loading={busy}
            type="submit"
          >
            {request.availableActions.includes("resubmit_outcome")
              ? "Submit Revised Result"
              : "Submit Result"}
          </Button>
        </form>
      )}
    </section>
  );
}
