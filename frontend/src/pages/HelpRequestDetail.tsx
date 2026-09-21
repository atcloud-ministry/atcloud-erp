import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import HelpOutcomePanel from "../components/alumniHelp/HelpOutcomePanel";
import HelpRequestActions from "../components/alumniHelp/HelpRequestActions";
import HelpStatusBadge from "../components/alumniHelp/HelpStatusBadge";
import HelpTimeline from "../components/alumniHelp/HelpTimeline";
import {
  HELP_TYPE_LABELS,
  formatHelpDate,
} from "../components/alumniHelp/presentation";
import { Button, Card, ErrorState, LoadingState } from "../components/ui";
import {
  isAlumniHelpUpdatePayload,
  useAlumniHelp,
} from "../contexts/AlumniHelpContext";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import {
  alumniHelpService,
  type AlumniHelpAvailableAction,
  type AlumniHelpOutcomeCode,
  type AlumniHelpRequestDetailDTO,
  type AlumniHelpRequestMutationDTO,
  type AlumniHelpType,
} from "../services/api";
import { socketService } from "../services/socketService";
import { createIdempotencyKey } from "../utils/idempotencyKey";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const SIMPLE_ENDPOINTS = {
  confirm_alternative: "confirm-alternative",
  reject_alternative: "reject-alternative",
  accept: "accept",
  decline: "decline",
  withdraw: "withdraw",
  start: "start",
  complete: "complete",
  close: "close",
} as const;

type SimpleAction = keyof typeof SIMPLE_ENDPOINTS;

function isSimpleAction(action: AlumniHelpAvailableAction): action is SimpleAction {
  return Object.prototype.hasOwnProperty.call(SIMPLE_ENDPOINTS, action);
}

export default function HelpRequestDetail() {
  const { requestId = "" } = useParams<{ requestId: string }>();
  const { config, status: runtimeStatus } = useRuntimeConfig();
  const { setHelpActionRequiredCount, announceHelpRoomCreated } = useAlumniHelp();
  const [loadedRequest, setLoadedRequest] = useState<{
    requestId: string;
    value: AlumniHelpRequestDetailDTO;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadSequence, setReloadSequence] = useState(0);
  const retryRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const readable =
    runtimeStatus === "ready" && config.alumniNetwork.readable;
  const writable =
    runtimeStatus === "ready" && config.alumniNetwork.writable;

  useEffect(() => {
    if (!readable || !OBJECT_ID_PATTERN.test(requestId)) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void alumniHelpService
      .get(requestId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoadedRequest({ requestId, value: result.request });
        setHelpActionRequiredCount(result.helpActionRequiredCount);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const status = (reason as { status?: unknown } | null)?.status;
        setError(
          status === 404 || status === 403
            ? "This help request is not available to you."
            : reason instanceof Error
              ? reason.message
              : "Unable to load this help request.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [readable, reloadSequence, requestId, setHelpActionRequiredCount]);

  useEffect(
    () =>
      socketService.on<unknown>("alumni_help_update", (update) => {
        if (isAlumniHelpUpdatePayload(update) && update.requestId === requestId) {
          setHelpActionRequiredCount(update.helpActionRequiredCount);
          setReloadSequence((value) => value + 1);
        }
      }),
    [requestId, setHelpActionRequiredCount],
  );

  const request =
    loadedRequest?.requestId === requestId ? loadedRequest.value : null;

  const applyResult = (result: AlumniHelpRequestMutationDTO, message: string) => {
    const previousConversationId = loadedRequest?.value.conversationId ?? null;
    setLoadedRequest({ requestId, value: result.request });
    setHelpActionRequiredCount(result.helpActionRequiredCount);
    if (
      result.request.conversationId &&
      result.request.conversationId !== previousConversationId
    ) {
      announceHelpRoomCreated(requestId, result.request.conversationId);
    }
    setSuccessMessage(message);
    setMutationError(null);
  };

  const runMutation = async (
    fingerprint: string,
    message: string,
    operation: (idempotencyKey: string) => Promise<AlumniHelpRequestMutationDTO>,
  ) => {
    if (!writable || busy) return;
    if (retryRef.current?.fingerprint !== fingerprint) {
      retryRef.current = { fingerprint, key: createIdempotencyKey() };
    }
    const key = retryRef.current.key;
    setBusy(true);
    setMutationError(null);
    setSuccessMessage(null);
    try {
      const result = await operation(key);
      retryRef.current = null;
      applyResult(result, message);
    } catch (reason) {
      const status = (reason as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status < 500) retryRef.current = null;
      setMutationError(
        reason instanceof Error
          ? reason.message
          : "Unable to update this help request.",
      );
      if (status === 409) setReloadSequence((value) => value + 1);
    } finally {
      setBusy(false);
    }
  };

  if (runtimeStatus === "loading") {
    return <LoadingState message="Loading help request..." />;
  }

  if (!readable) {
    return (
      <ErrorState
        message="Alumni Help is temporarily unavailable."
        title="Help Request unavailable"
      />
    );
  }

  if (!OBJECT_ID_PATTERN.test(requestId)) {
    return (
      <ErrorState
        action={
          <Link className="font-medium text-blue-700 hover:text-blue-800" to="/dashboard/community/help-requests">
            Return to Help Requests
          </Link>
        }
        message="This help request is not available."
        title="Request not found"
      />
    );
  }

  if (loading && !request) {
    return <LoadingState message="Loading help request..." />;
  }

  if (error || !request) {
    return (
      <ErrorState
        action={
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <Button onClick={() => setReloadSequence((value) => value + 1)} type="button">
              Try Again
            </Button>
            <Link className="font-medium text-blue-700 hover:text-blue-800" to="/dashboard/community/help-requests">
              Back to Help Requests
            </Link>
          </div>
        }
        message={error ?? "This help request is not available."}
        title="Unable to load request"
      />
    );
  }

  const counterpart =
    request.viewerRole === "requester" ? request.provider : request.requester;

  const onSimpleAction = (action: AlumniHelpAvailableAction) => {
    if (!isSimpleAction(action)) return;
    const endpoint = SIMPLE_ENDPOINTS[action];
    void runMutation(
      `${action}:${request.revision}`,
      `${action === "complete" ? "Help" : "Request"} updated.`,
      (key) =>
        alumniHelpService.transition(
          request.id,
          endpoint,
          request.revision,
          key,
        ),
    );
  };

  const onNoteAction = (
    action: "request_information" | "provide_information",
    note: string,
  ) => {
    void runMutation(
      `${action}:${request.revision}:${note}`,
      action === "request_information"
        ? "Information requested."
        : "Information provided.",
      (key) =>
        action === "request_information"
          ? alumniHelpService.requestInformation(
              request.id,
              request.revision,
              note,
              key,
            )
          : alumniHelpService.provideInformation(
              request.id,
              request.revision,
              note,
              key,
            ),
    );
  };

  const onAlternative = (helpType: AlumniHelpType, note?: string) => {
    void runMutation(
      `propose_alternative:${request.revision}:${helpType}:${note ?? ""}`,
      "Alternative proposed.",
      (key) =>
        alumniHelpService.proposeAlternative(
          request.id,
          request.revision,
          helpType,
          note,
          key,
        ),
    );
  };

  const onSubmitOutcome = (outcomeCode: AlumniHelpOutcomeCode) => {
    void runMutation(
      `outcome:${request.revision}:${outcomeCode}`,
      "Result submitted for provider confirmation.",
      (key) =>
        alumniHelpService.submitOutcome(
          request.id,
          request.revision,
          outcomeCode,
          key,
        ),
    );
  };

  const onOutcomeDecision = (decision: "confirm" | "deny") => {
    const outcome = request.latestOutcome;
    if (!outcome) return;
    void runMutation(
      `outcome:${outcome.id}:${decision}:${outcome.revision}`,
      decision === "confirm" ? "Result confirmed." : "Result denied.",
      (key) =>
        alumniHelpService.decideOutcome(
          request.id,
          outcome.id,
          decision,
          outcome.revision,
          key,
        ),
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link
        className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        to="/dashboard/community/help-requests"
      >
        <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
        Help Requests
      </Link>

      {!writable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
          Alumni Help is currently read-only. You can review this request, but cannot update it.
        </div>
      )}

      {(successMessage || mutationError) && (
        <div
          aria-live="polite"
          className={`rounded-lg p-4 text-sm ${
            mutationError
              ? "border border-red-200 bg-red-50 text-red-700"
              : "border border-green-200 bg-green-50 text-green-800"
          }`}
          role={mutationError ? "alert" : "status"}
        >
          {mutationError ?? successMessage}
        </div>
      )}

      <Card padding="lg">
        <article aria-busy={loading || busy} className="min-w-0">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-500">
                {request.viewerRole === "requester" ? "Help from" : "Request from"}
              </p>
              <h1 className="mt-1 break-words text-2xl font-bold text-gray-900 sm:text-3xl">
                {counterpart.displayName}
              </h1>
              <p className="mt-2 text-sm text-gray-600">
                Created <time dateTime={request.createdAt}>{formatHelpDate(request.createdAt)}</time>
              </p>
            </div>
            <HelpStatusBadge status={request.status} />
          </header>

          <dl className="mt-6 grid grid-cols-1 gap-4 border-y border-gray-200 py-5 sm:grid-cols-3">
            <div>
              <dt className="text-sm font-medium text-gray-500">Requested help</dt>
              <dd className="mt-1 text-gray-900">
                {HELP_TYPE_LABELS[request.requestedHelpType]}
              </dd>
            </div>
            {request.proposedHelpType && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Proposed help</dt>
                <dd className="mt-1 text-gray-900">
                  {HELP_TYPE_LABELS[request.proposedHelpType]}
                </dd>
              </div>
            )}
            {request.agreedHelpType && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Agreed help</dt>
                <dd className="mt-1 text-gray-900">
                  {HELP_TYPE_LABELS[request.agreedHelpType]}
                </dd>
              </div>
            )}
          </dl>

          {request.openingNote && (
            <section aria-labelledby="opening-note-heading" className="mt-6">
              <h2 className="text-lg font-semibold text-gray-900" id="opening-note-heading">
                Opening note
              </h2>
              <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-4 text-sm text-gray-700">
                {request.openingNote}
              </p>
            </section>
          )}

          <div className="mt-6">
            <HelpRequestActions
              busy={busy}
              onAlternative={onAlternative}
              onNoteAction={onNoteAction}
              onSimpleAction={onSimpleAction}
              request={request}
              writable={writable}
            />
          </div>

          {request.conversationId && (
            <section aria-labelledby="help-room-heading" className="mt-6 rounded-lg border border-green-200 bg-green-50 p-4">
              <h2 className="font-semibold text-green-900" id="help-room-heading">
                Help Room created
              </h2>
              <p className="mt-1 text-sm text-green-800">
                Your private two-person Help Room is ready.
              </p>
              <Link
                className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                to={`/dashboard/chat-rooms/${encodeURIComponent(request.conversationId)}`}
              >
                Open Help Room
              </Link>
            </section>
          )}

          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
            <HelpTimeline entries={request.lifecycleTimeline} />
            <HelpOutcomePanel
              busy={busy}
              onDecision={onOutcomeDecision}
              onSubmit={onSubmitOutcome}
              request={request}
              writable={writable}
            />
          </div>

          <details className="mt-8 rounded-lg border border-gray-200 p-4">
            <summary className="cursor-pointer font-medium text-gray-900">
              Accepted consent and disclaimer
            </summary>
            <p className="mt-3 text-xs text-gray-500">
              Accepted on{" "}
              <time dateTime={request.termsAcceptedAt}>
                {formatHelpDate(request.termsAcceptedAt)}
              </time>
            </p>
            <section
              aria-labelledby="accepted-help-consent-heading"
              className="mt-4"
            >
              <h2
                className="text-sm font-semibold text-gray-900"
                id="accepted-help-consent-heading"
              >
                Consent ({request.acceptedTerms.consent.version})
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
                {request.acceptedTerms.consent.text}
              </p>
            </section>
            <section
              aria-labelledby="accepted-help-disclaimer-heading"
              className="mt-4"
            >
              <h2
                className="text-sm font-semibold text-gray-900"
                id="accepted-help-disclaimer-heading"
              >
                Disclaimer ({request.acceptedTerms.disclaimer.version})
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
                {request.acceptedTerms.disclaimer.text}
              </p>
            </section>
            <Link
              className="mt-4 inline-flex min-h-11 items-center font-medium text-blue-700 underline hover:text-blue-900"
              to="/privacy"
            >
              Privacy &amp; Data Use
            </Link>
          </details>

          <p className="mt-8 border-t border-gray-100 pt-4 text-xs text-gray-500">
            Request ID: {request.id}
          </p>
        </article>
      </Card>
    </div>
  );
}
