import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useAlumniHelp } from "../../contexts/AlumniHelpContext";
import {
  alumniHelpService,
  type AlumniHelpRequestMutationDTO,
  type AlumniHelpTermsDTO,
  type AlumniHelpType,
  type DirectoryDetailDTO,
} from "../../services/api";
import { createIdempotencyKey } from "../../utils/idempotencyKey";
import { Button, LoadingState } from "../ui";
import { enabledHelpTypes, HELP_TYPE_LABELS } from "./presentation";

const NOTE_MAX_CODE_POINTS = 4_000;

interface RequestHelpDialogProps {
  profile: DirectoryDetailDTO;
  open: boolean;
  writable: boolean;
  onClose: () => void;
  onCreated: (result: AlumniHelpRequestMutationDTO) => void;
}

export default function RequestHelpDialog({
  profile,
  open,
  writable,
  onClose,
  onCreated,
}: RequestHelpDialogProps) {
  const { setHelpNotificationCounts } = useAlumniHelp();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const retryRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [terms, setTerms] = useState<AlumniHelpTermsDTO | null>(null);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [termsReload, setTermsReload] = useState(0);
  const [helpType, setHelpType] = useState<AlumniHelpType | "">("");
  const [openingNote, setOpeningNote] = useState("");
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const availableTypes = useMemo(() => enabledHelpTypes(profile), [profile]);
  const noteLength = Array.from(openingNote).length;
  const noteTooLong = noteLength > NOTE_MAX_CODE_POINTS;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setHelpType("");
    setOpeningNote("");
    setConsentAccepted(false);
    setDisclaimerAccepted(false);
    setSubmitError(null);
    retryRef.current = null;
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !writable) return;
    const controller = new AbortController();
    setTermsLoading(true);
    setTermsError(null);
    void alumniHelpService
      .getTerms(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setTerms(result);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setTerms(null);
        setTermsError(
          reason instanceof Error
            ? reason.message
            : "Unable to load the request terms.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setTermsLoading(false);
      });
    return () => controller.abort();
  }, [open, termsReload, writable]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, submitting]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !writable ||
      !terms ||
      !helpType ||
      !availableTypes.includes(helpType) ||
      !consentAccepted ||
      !disclaimerAccepted ||
      noteLength > NOTE_MAX_CODE_POINTS
    ) {
      setSubmitError("Complete the required selections and acknowledgements.");
      return;
    }

    const input = {
      alumniProfileId: profile.id,
      requestedHelpType: helpType,
      ...(openingNote.trim() ? { openingNote } : {}),
      consentVersion: terms.consent.version,
      consentAccepted: true as const,
      disclaimerVersion: terms.disclaimer.version,
      disclaimerAccepted: true as const,
    };
    const fingerprint = JSON.stringify(input);
    if (retryRef.current?.fingerprint !== fingerprint) {
      retryRef.current = { fingerprint, key: createIdempotencyKey() };
    }
    const idempotencyKey = retryRef.current.key;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await alumniHelpService.create(input, idempotencyKey);
      retryRef.current = null;
      setHelpNotificationCounts(result);
      onCreated(result);
    } catch (reason) {
      const status = (reason as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status < 500) retryRef.current = null;
      setSubmitError(
        reason instanceof Error
          ? reason.message
          : "Unable to create the help request.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div
        aria-describedby="request-help-description"
        aria-labelledby="request-help-title"
        aria-modal="true"
        className="max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl"
        ref={dialogRef}
        role="dialog"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900" id="request-help-title">
              Request help from {profile.displayName}
            </h2>
            <p className="mt-1 text-sm text-gray-600" id="request-help-description">
              Choose the kind of help you would like to discuss. Details can be
              worked out together after the request is accepted.
            </p>
          </div>
          <button
            aria-label="Close Request Help dialog"
            className="min-h-11 min-w-11 rounded-md p-2 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={submitting}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <XMarkIcon aria-hidden="true" className="h-6 w-6" />
          </button>
        </header>

        {!writable ? (
          <div className="p-6" role="status">
            Alumni Help is currently read-only. New requests cannot be sent.
          </div>
        ) : termsLoading ? (
          <LoadingState message="Loading request terms..." />
        ) : termsError || !terms ? (
          <div className="space-y-4 p-6 text-center">
            <p className="text-sm text-red-700" role="alert">
              {termsError ?? "Unable to load the request terms."}
            </p>
            <Button onClick={() => setTermsReload((value) => value + 1)} type="button">
              Try Again
            </Button>
          </div>
        ) : (
          <form className="space-y-6 p-5 sm:p-6" onSubmit={submit}>
            <fieldset>
              <legend className="text-base font-semibold text-gray-900">
                Help requested
              </legend>
              <div className="mt-3 space-y-2">
                {availableTypes.map((type) => (
                  <label
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 hover:bg-blue-50"
                    key={type}
                  >
                    <input
                      checked={helpType === type}
                      name="requestedHelpType"
                      onChange={() => setHelpType(type)}
                      required
                      type="radio"
                      value={type}
                    />
                    <span>{HELP_TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label className="block text-sm font-medium text-gray-900" htmlFor="help-opening-note">
                Opening note <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <textarea
                aria-describedby={
                  noteTooLong
                    ? "help-opening-note-count help-opening-note-error"
                    : "help-opening-note-count"
                }
                aria-invalid={noteTooLong}
                className="mt-2 min-h-28 w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                id="help-opening-note"
                onChange={(event) => setOpeningNote(event.target.value)}
                placeholder="Briefly describe what you would like help with."
                value={openingNote}
              />
              <p
                className="mt-1 text-right text-xs text-gray-500"
                id="help-opening-note-count"
              >
                {noteLength}/{NOTE_MAX_CODE_POINTS}
              </p>
              {noteTooLong && (
                <p
                  className="mt-1 text-sm text-red-700"
                  id="help-opening-note-error"
                  role="alert"
                >
                  Opening note must be 4,000 characters or fewer.
                </p>
              )}
            </div>

            <section aria-labelledby="help-consent-heading" className="rounded-lg bg-gray-50 p-4">
              <h3 className="font-medium text-gray-900" id="help-consent-heading">
                Consent
              </h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
                {terms.consent.text}
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm text-gray-800">
                <input
                  checked={consentAccepted}
                  className="mt-1"
                  onChange={(event) => setConsentAccepted(event.target.checked)}
                  required
                  type="checkbox"
                />
                <span>I agree to the Alumni Help consent above.</span>
              </label>
            </section>

            <p className="text-sm text-gray-600">
              Learn how these records are used and retained in{" "}
              <a
                className="font-medium text-blue-700 underline hover:text-blue-900"
                href="/#/privacy"
              >
                Privacy &amp; Data Use
              </a>
              .
            </p>

            <section aria-labelledby="help-disclaimer-heading" className="rounded-lg bg-gray-50 p-4">
              <h3 className="font-medium text-gray-900" id="help-disclaimer-heading">
                Disclaimer
              </h3>
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
                {terms.disclaimer.text}
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm text-gray-800">
                <input
                  checked={disclaimerAccepted}
                  className="mt-1"
                  onChange={(event) => setDisclaimerAccepted(event.target.checked)}
                  required
                  type="checkbox"
                />
                <span>I acknowledge the Alumni Help disclaimer above.</span>
              </label>
            </section>

            {submitError && (
              <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
                {submitError}
              </p>
            )}

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                disabled={submitting}
                onClick={onClose}
                type="button"
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                disabled={
                  !helpType ||
                  !consentAccepted ||
                  !disclaimerAccepted ||
                  noteTooLong
                }
                loading={submitting}
                type="submit"
              >
                Send Request
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
