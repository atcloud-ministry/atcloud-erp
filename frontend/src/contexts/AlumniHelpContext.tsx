import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../hooks/useAuth";
import { useSocket } from "../hooks/useSocket";
import { alumniHelpService } from "../services/api";
import { socketService } from "../services/socketService";
import { useRuntimeConfig } from "./RuntimeConfigContext";

export interface AlumniHelpUpdatePayload {
  requestId: string;
  requestRevision: number;
  helpActionRequiredCount: number;
  timestamp: string;
}

interface AlumniHelpContextValue {
  helpActionRequiredCount: number;
  countLoading: boolean;
  refreshHelpActionRequiredCount: () => Promise<void>;
  setHelpActionRequiredCount: (count: number) => void;
}

const AlumniHelpContext = createContext<AlumniHelpContextValue | undefined>(
  undefined,
);

export function isAlumniHelpUpdatePayload(
  value: unknown,
): value is AlumniHelpUpdatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  return (
    Object.keys(update).length === 4 &&
    [
      "requestId",
      "requestRevision",
      "helpActionRequiredCount",
      "timestamp",
    ].every((key) => Object.prototype.hasOwnProperty.call(update, key)) &&
    typeof update.requestId === "string" &&
    /^[a-f\d]{24}$/i.test(update.requestId) &&
    Number.isSafeInteger(update.requestRevision) &&
    Number(update.requestRevision) >= 0 &&
    Number.isSafeInteger(update.helpActionRequiredCount) &&
    Number(update.helpActionRequiredCount) >= 0 &&
    typeof update.timestamp === "string" &&
    !Number.isNaN(Date.parse(update.timestamp)) &&
    new Date(update.timestamp).toISOString() === update.timestamp
  );
}

export function AlumniHelpProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const { config, status } = useRuntimeConfig();
  useSocket();
  const [helpActionRequiredCount, setCount] = useState(0);
  const [countLoading, setCountLoading] = useState(false);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);

  const canRead =
    !!currentUser && status === "ready" && config.alumniNetwork.readable;

  const setHelpActionRequiredCount = useCallback((count: number) => {
    if (Number.isSafeInteger(count) && count >= 0) setCount(count);
  }, []);

  const refreshHelpActionRequiredCount = useCallback(async () => {
    if (!canRead) {
      if (mountedRef.current) {
        setCount(0);
        setCountLoading(false);
      }
      return;
    }

    const requestSequence = ++requestSequenceRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    if (mountedRef.current) setCountLoading(true);

    try {
      const count = await alumniHelpService.getActionRequiredCount(
        controller.signal,
      );
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestSequence === requestSequenceRef.current
      ) {
        setCount(count);
      }
    } catch {
      // The badge is supplementary. Keep the last trusted count and let the
      // page surface any request-loading error in context.
    } finally {
      if (
        mountedRef.current &&
        requestSequence === requestSequenceRef.current
      ) {
        setCountLoading(false);
        activeRequestRef.current = null;
      }
    }
  }, [canRead]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshHelpActionRequiredCount();
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [refreshHelpActionRequiredCount]);

  useEffect(() => {
    if (!canRead) return;
    return socketService.on<unknown>("alumni_help_update", (payload) => {
      if (isAlumniHelpUpdatePayload(payload)) {
        setCount(payload.helpActionRequiredCount);
      } else {
        void refreshHelpActionRequiredCount();
      }
    });
  }, [canRead, refreshHelpActionRequiredCount]);

  const value = useMemo<AlumniHelpContextValue>(
    () => ({
      helpActionRequiredCount,
      countLoading,
      refreshHelpActionRequiredCount,
      setHelpActionRequiredCount,
    }),
    [
      countLoading,
      helpActionRequiredCount,
      refreshHelpActionRequiredCount,
      setHelpActionRequiredCount,
    ],
  );

  return (
    <AlumniHelpContext.Provider value={value}>
      {children}
    </AlumniHelpContext.Provider>
  );
}

export function useAlumniHelp(): AlumniHelpContextValue {
  const value = useContext(AlumniHelpContext);
  if (!value) {
    throw new Error("useAlumniHelp must be used within AlumniHelpProvider");
  }
  return value;
}
