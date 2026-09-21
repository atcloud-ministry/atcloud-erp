import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmationModal from "../common/ConfirmationModal";
import type {
  AlumniNetworkMode,
  RuntimeConfig,
} from "../../config/runtimeConfig";
import { featureControlsService } from "../../services/api/featureControls.api";

interface AlumniNetworkModeControlProps {
  readonly onRuntimeConfigRefresh: () => Promise<void>;
}

type HttpError = Error & { status?: number };

const MODE_LABELS: Readonly<Record<AlumniNetworkMode, string>> = Object.freeze({
  off: "Off",
  read_only: "Read-only",
  on: "On",
});

const MODE_DESCRIPTIONS: Readonly<Record<AlumniNetworkMode, string>> =
  Object.freeze({
    off: "Alumni Network is unavailable.",
    read_only:
      "Alumni Network content can be viewed, but changes are unavailable.",
    on: "Directory, Alumni Help, and Chat Rooms are available.",
  });

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }
  const value = Number((error as HttpError).status);
  return Number.isInteger(value) ? value : null;
}

function updateErrorMessage(error: unknown): string {
  switch (errorStatus(error)) {
    case 401:
    case 403:
      return "Your session cannot change this setting. Please sign in again.";
    case 503:
      return "Alumni Network controls are temporarily unavailable. Try again.";
    default:
      return "Unable to update the Alumni Network setting. Try again.";
  }
}

export default function AlumniNetworkModeControl({
  onRuntimeConfigRefresh,
}: AlumniNetworkModeControlProps) {
  const [control, setControl] = useState<RuntimeConfig | null>(null);
  const [selectedMode, setSelectedMode] = useState<AlumniNetworkMode | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [pendingMode, setPendingMode] = useState<AlumniNetworkMode | null>(
    null,
  );
  const requestSequence = useRef(0);

  const loadControl = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError(null);
    setUpdateError(null);

    try {
      const next = await featureControlsService.get(signal);
      if (signal?.aborted || sequence !== requestSequence.current) return null;
      setControl(next);
      setSelectedMode(next.alumniNetwork.mode);
      return next;
    } catch {
      if (signal?.aborted || sequence !== requestSequence.current) return null;
      setControl(null);
      setSelectedMode(null);
      setLoadError("Unable to load the Alumni Network setting. Try again.");
      return null;
    } finally {
      if (!signal?.aborted && sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadControl(controller.signal);
    return () => {
      controller.abort();
      requestSequence.current += 1;
    };
  }, [loadControl]);

  const openConfirmation = () => {
    if (
      !control ||
      !selectedMode ||
      selectedMode === control.alumniNetwork.mode ||
      loading ||
      updateBusy
    ) {
      return;
    }
    setPendingMode(selectedMode);
    setUpdateError(null);
    setNotice(null);
  };

  const confirmModeChange = async () => {
    const current = control;
    const target = pendingMode;
    if (!current || !target || updateBusy) return;

    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const updated = await featureControlsService.updateAlumniNetworkMode({
        mode: target,
        expectedRevision: current.revision,
      });
      setControl(updated);
      setSelectedMode(updated.alumniNetwork.mode);
      setPendingMode(null);
      setNotice(`Alumni Network is now ${MODE_LABELS[updated.alumniNetwork.mode]}.`);

      try {
        await onRuntimeConfigRefresh();
      } catch {
        setNotice(
          `Alumni Network is now ${MODE_LABELS[updated.alumniNetwork.mode]}. Refresh the page if navigation does not update.`,
        );
      }
    } catch (error) {
      if (errorStatus(error) === 409) {
        setPendingMode(null);
        const currentControl = await loadControl();
        if (currentControl) {
          setNotice(
            "The setting changed before your update. Its current value has been reloaded; select a mode and confirm again.",
          );
        }
      } else {
        setUpdateError(updateErrorMessage(error));
      }
    } finally {
      setUpdateBusy(false);
    }
  };

  const currentMode: AlumniNetworkMode = control?.alumniNetwork.mode ?? "off";
  const canApply =
    !!control &&
    !!selectedMode &&
    selectedMode !== currentMode &&
    !loading &&
    !updateBusy;
  const confirmationType = pendingMode === "on" ? "info" : "warning";

  return (
    <section
      aria-labelledby="alumni-network-control-heading"
      className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            className="text-lg font-semibold text-indigo-950"
            id="alumni-network-control-heading"
          >
            Alumni Network
          </h2>
          <p className="mt-1 text-sm text-indigo-900">
            Control access to Directory, Alumni Help, and Chat Rooms.
          </p>
        </div>
        <button
          className="min-h-11 rounded-md border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-indigo-800 hover:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || updateBusy}
          onClick={() => void loadControl()}
          type="button"
        >
          Refresh setting
        </button>
      </div>

      {loading && !control ? (
        <p className="mt-4 text-sm text-indigo-900" role="status">
          Loading Alumni Network setting…
        </p>
      ) : null}

      {loadError ? (
        <div className="mt-4" role="alert">
          <p className="text-sm text-red-800">{loadError}</p>
          <button
            className="mt-3 min-h-11 rounded-md bg-indigo-700 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            onClick={() => void loadControl()}
            type="button"
          >
            Retry setting load
          </button>
        </div>
      ) : null}

      {control ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-indigo-950">
            Current mode: <span className="font-semibold">{MODE_LABELS[currentMode]}</span>
            <span className="text-indigo-700"> · Revision {control.revision}</span>
          </p>
          <p className="text-sm text-indigo-800">
            {MODE_DESCRIPTIONS[currentMode]}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex max-w-xs flex-1 flex-col gap-1 text-sm font-medium text-indigo-950">
              Alumni Network mode
              <select
                aria-label="Alumni Network mode"
                className="min-h-11 rounded-md border border-indigo-300 bg-white px-3 py-2 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={loading || updateBusy}
                onChange={(event) =>
                  setSelectedMode(event.target.value as AlumniNetworkMode)
                }
                value={selectedMode ?? currentMode}
              >
                <option value="off">Off</option>
                <option value="read_only">Read-only</option>
                <option value="on">On</option>
              </select>
            </label>
            <button
              className="min-h-11 rounded-md bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canApply}
              onClick={openConfirmation}
              type="button"
            >
              Apply Alumni Network mode
            </button>
          </div>
        </div>
      ) : null}

      {updateError ? (
        <p className="mt-4 text-sm text-red-800" role="alert">
          {updateError}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 text-sm text-green-800" role="status">
          {notice}
        </p>
      ) : null}

      <ConfirmationModal
        cancelText="Cancel"
        confirmText={
          pendingMode ? `Set mode to ${MODE_LABELS[pendingMode]}` : "Confirm"
        }
        isLoading={updateBusy}
        isOpen={pendingMode !== null}
        message={
          pendingMode && currentMode
            ? `Current mode: ${MODE_LABELS[currentMode]}. New mode: ${MODE_LABELS[pendingMode]}.\n\n${MODE_DESCRIPTIONS[pendingMode]}\n\nContinue?`
            : ""
        }
        onClose={() => setPendingMode(null)}
        onConfirm={() => void confirmModeChange()}
        title="Change Alumni Network mode"
        type={confirmationType}
      />
    </section>
  );
}
