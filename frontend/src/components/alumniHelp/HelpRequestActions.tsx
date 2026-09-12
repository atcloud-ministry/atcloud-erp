import { useEffect, useState } from "react";
import type {
  AlumniHelpAvailableAction,
  AlumniHelpRequestDetailDTO,
  AlumniHelpType,
} from "../../services/api";
import { Button } from "../ui";
import { ACTION_LABELS, HELP_TYPE_LABELS } from "./presentation";

const NOTE_MAX_CODE_POINTS = 4_000;

interface HelpRequestActionsProps {
  request: AlumniHelpRequestDetailDTO;
  writable: boolean;
  busy: boolean;
  onSimpleAction: (action: AlumniHelpAvailableAction) => void;
  onNoteAction: (
    action: "request_information" | "provide_information",
    note: string,
  ) => void;
  onAlternative: (helpType: AlumniHelpType, note?: string) => void;
}

const SIMPLE_ACTIONS: readonly AlumniHelpAvailableAction[] = [
  "confirm_alternative",
  "reject_alternative",
  "accept",
  "decline",
  "withdraw",
  "start",
  "complete",
  "close",
];

export default function HelpRequestActions({
  request,
  writable,
  busy,
  onSimpleAction,
  onNoteAction,
  onAlternative,
}: HelpRequestActionsProps) {
  const [formAction, setFormAction] = useState<
    "request_information" | "provide_information" | "propose_alternative" | null
  >(null);
  const [note, setNote] = useState("");
  const [alternativeType, setAlternativeType] = useState<AlumniHelpType | "">(
    "",
  );
  const noteLength = Array.from(note).length;

  useEffect(() => {
    setFormAction(null);
    setNote("");
    setAlternativeType("");
  }, [request.revision]);

  const lifecycleActions = request.availableActions.filter((action) =>
    [
      ...SIMPLE_ACTIONS,
      "request_information",
      "provide_information",
      "propose_alternative",
    ].includes(action),
  );

  if (lifecycleActions.length === 0) return null;

  if (!writable) {
    return (
      <section aria-labelledby="help-actions-heading" className="rounded-lg bg-amber-50 p-4">
        <h2 className="font-semibold text-amber-900" id="help-actions-heading">
          Available actions
        </h2>
        <p className="mt-1 text-sm text-amber-800">
          Alumni Help is currently read-only. You can review this request, but cannot update it.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="help-actions-heading" className="rounded-lg border border-blue-100 bg-blue-50 p-4">
      <h2 className="font-semibold text-gray-900" id="help-actions-heading">
        Available actions
      </h2>
      {request.proposedHelpType &&
        (request.availableActions.includes("confirm_alternative") ||
          request.availableActions.includes("reject_alternative")) && (
          <p className="mt-2 text-sm text-gray-700">
            Proposed help type: {HELP_TYPE_LABELS[request.proposedHelpType]}
          </p>
        )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {request.availableActions.includes("request_information") && (
          <Button
            disabled={busy}
            onClick={() => setFormAction("request_information")}
            type="button"
            variant="secondary"
          >
            {ACTION_LABELS.request_information}
          </Button>
        )}
        {request.availableActions.includes("provide_information") && (
          <Button
            disabled={busy}
            onClick={() => setFormAction("provide_information")}
            type="button"
            variant="secondary"
          >
            {ACTION_LABELS.provide_information}
          </Button>
        )}
        {request.availableActions.includes("propose_alternative") &&
          request.availableAlternativeHelpTypes.length > 0 && (
          <Button
            disabled={busy}
            onClick={() => setFormAction("propose_alternative")}
            type="button"
            variant="secondary"
          >
            {ACTION_LABELS.propose_alternative}
          </Button>
        )}
        {SIMPLE_ACTIONS.filter((action) =>
          request.availableActions.includes(action),
        ).map((action) => (
          <Button
            disabled={busy}
            key={action}
            onClick={() => onSimpleAction(action)}
            type="button"
            variant={
              action === "decline" || action === "withdraw" || action === "close"
                ? "danger"
                : action === "reject_alternative"
                  ? "secondary"
                  : "primary"
            }
          >
            {ACTION_LABELS[action]}
          </Button>
        ))}
      </div>

      {request.availableActions.includes("propose_alternative") &&
        request.availableAlternativeHelpTypes.length === 0 && (
          <p className="mt-3 text-sm text-gray-600">
            No other help type is currently available to propose.
          </p>
        )}

      {formAction && (
        <form
          className="mt-4 space-y-3 rounded-md bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (formAction === "propose_alternative") {
              if (alternativeType && noteLength <= NOTE_MAX_CODE_POINTS) {
                onAlternative(alternativeType, note.trim() ? note : undefined);
              }
            } else if (note.trim() && noteLength <= NOTE_MAX_CODE_POINTS) {
              onNoteAction(formAction, note);
            }
          }}
        >
          {formAction === "propose_alternative" ? (
            <fieldset>
              <legend className="text-sm font-medium text-gray-900">
                Select another help type
              </legend>
              <div className="mt-2 space-y-2">
                {request.availableAlternativeHelpTypes.map((type) => (
                  <label className="flex min-h-11 items-center gap-3" key={type}>
                    <input
                      checked={alternativeType === type}
                      name="alternativeHelpType"
                      onChange={() => setAlternativeType(type)}
                      type="radio"
                    />
                    <span>{HELP_TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div>
            <label className="block text-sm font-medium text-gray-900" htmlFor="help-action-note">
              {formAction === "request_information"
                ? "What information do you need?"
                : formAction === "provide_information"
                  ? "Your response"
                  : "Note (optional)"}
            </label>
            <textarea
              className="mt-2 min-h-24 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              id="help-action-note"
              onChange={(event) => setNote(event.target.value)}
              required={formAction !== "propose_alternative"}
              value={note}
            />
            <p className="mt-1 text-right text-xs text-gray-500">
              {noteLength}/{NOTE_MAX_CODE_POINTS}
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={busy}
              onClick={() => setFormAction(null)}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                noteLength > NOTE_MAX_CODE_POINTS ||
                (formAction === "propose_alternative"
                  ? !alternativeType
                  : !note.trim())
              }
              loading={busy}
              type="submit"
            >
              Submit
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
