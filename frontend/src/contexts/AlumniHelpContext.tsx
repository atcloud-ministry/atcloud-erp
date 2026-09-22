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
import {
  alumniHelpService,
  type AlumniHelpNotificationCountsDTO,
} from "../services/api";
import type { AlumniHelpUpdate } from "../types/realtime";
import { socketService } from "../services/socketService";
import { useNavigate } from "react-router-dom";
import { useNotification } from "./NotificationModalContext";
import { useRuntimeConfig } from "./RuntimeConfigContext";

export type AlumniHelpUpdatePayload = AlumniHelpUpdate;

interface AlumniHelpContextValue {
  helpActionRequiredCount: number;
  helpNotificationCount: number;
  helpRefreshSequence: number;
  countLoading: boolean;
  refreshHelpActionRequiredCount: () => Promise<void>;
  setHelpActionRequiredCount: (count: number) => void;
  setHelpNotificationCounts: (
    counts: AlumniHelpNotificationCountsDTO,
    expectedGeneration?: number,
  ) => void;
  captureHelpCounterGeneration: () => number;
  announceHelpRoomCreated: (requestId: string, conversationId: string) => void;
  announceHelpRoomGraceStarted: (
    requestId: string,
    conversationId: string,
    writeAccessEndsAt?: string,
  ) => void;
}

const AlumniHelpContext = createContext<AlumniHelpContextValue | undefined>(
  undefined,
);
const FOREGROUND_RECONCILIATION_MS = 15_000;

export function isAlumniHelpUpdatePayload(
  value: unknown,
): value is AlumniHelpUpdatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  const hasNotificationCount = Object.prototype.hasOwnProperty.call(
    update,
    "helpNotificationCount",
  );
  const hasRoomCreated = Object.prototype.hasOwnProperty.call(
    update,
    "roomCreated",
  );
  const hasRoomGraceStarted = Object.prototype.hasOwnProperty.call(
    update,
    "roomGraceStarted",
  );
  const roomCreated = update.roomCreated;
  const hasValidRoomCreated =
    !hasRoomCreated ||
    (roomCreated !== null &&
      typeof roomCreated === "object" &&
      !Array.isArray(roomCreated) &&
      Object.keys(roomCreated).length === 1 &&
      Object.prototype.hasOwnProperty.call(roomCreated, "conversationId") &&
      typeof (roomCreated as Record<string, unknown>).conversationId ===
        "string" &&
      /^[a-f\d]{24}$/i.test(
        (roomCreated as Record<string, unknown>).conversationId as string,
      ));
  const roomGraceStarted = update.roomGraceStarted;
  const hasValidRoomGraceStarted =
    !hasRoomGraceStarted ||
    (roomGraceStarted !== null &&
      typeof roomGraceStarted === "object" &&
      !Array.isArray(roomGraceStarted) &&
      Object.keys(roomGraceStarted).length === 2 &&
      Object.prototype.hasOwnProperty.call(roomGraceStarted, "conversationId") &&
      Object.prototype.hasOwnProperty.call(roomGraceStarted, "writeAccessEndsAt") &&
      typeof (roomGraceStarted as Record<string, unknown>).conversationId ===
        "string" &&
      /^[a-f\d]{24}$/i.test(
        (roomGraceStarted as Record<string, unknown>).conversationId as string,
      ) &&
      typeof (roomGraceStarted as Record<string, unknown>).writeAccessEndsAt ===
        "string" &&
      !Number.isNaN(
        Date.parse(
          (roomGraceStarted as Record<string, unknown>)
            .writeAccessEndsAt as string,
        ),
      ) &&
      new Date(
        (roomGraceStarted as Record<string, unknown>)
          .writeAccessEndsAt as string,
      ).toISOString() ===
        (roomGraceStarted as Record<string, unknown>)
          .writeAccessEndsAt);
  return (
    Object.keys(update).length ===
      4 +
        Number(hasRoomCreated) +
        Number(hasRoomGraceStarted) +
        Number(hasNotificationCount) &&
    [
      "requestId",
      "requestRevision",
      "helpActionRequiredCount",
      "timestamp",
    ]
      .concat(hasRoomCreated ? ["roomCreated"] : [])
      .concat(hasRoomGraceStarted ? ["roomGraceStarted"] : [])
      .concat(hasNotificationCount ? ["helpNotificationCount"] : [])
      .every((key) => Object.prototype.hasOwnProperty.call(update, key)) &&
    typeof update.requestId === "string" &&
    /^[a-f\d]{24}$/i.test(update.requestId) &&
    Number.isSafeInteger(update.requestRevision) &&
    Number(update.requestRevision) >= 0 &&
    Number.isSafeInteger(update.helpActionRequiredCount) &&
    Number(update.helpActionRequiredCount) >= 0 &&
    (!hasNotificationCount ||
      (Number.isSafeInteger(update.helpNotificationCount) &&
        Number(update.helpNotificationCount) >= Number(update.helpActionRequiredCount))) &&
    typeof update.timestamp === "string" &&
    !Number.isNaN(Date.parse(update.timestamp)) &&
    new Date(update.timestamp).toISOString() === update.timestamp &&
    hasValidRoomCreated &&
    hasValidRoomGraceStarted &&
    !(hasRoomCreated && hasRoomGraceStarted)
  );
}

export function AlumniHelpProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const { config, status } = useRuntimeConfig();
  const { showNotification } = useNotification();
  const navigate = useNavigate();
  useSocket();
  const [helpActionRequiredCount, setCount] = useState(0);
  const [helpNotificationCount, setNotificationCount] = useState(0);
  const [helpRefreshSequence, setHelpRefreshSequence] = useState(0);
  const [countLoading, setCountLoading] = useState(false);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const counterGenerationRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const announcedRoomsRef = useRef(new Set<string>());
  const roomAnnouncementOwnerRef = useRef<string | null>(currentUser?.id ?? null);
  const counterOwnerRef = useRef<string | null>(currentUser?.id ?? null);
  const seenRequestRevisionsRef = useRef(new Map<string, number>());
  const latestEventTimeRef = useRef(0);
  const userId = currentUser?.id ?? null;

  const canRead =
    !!currentUser && status === "ready" && config.alumniNetwork.readable;

  useEffect(() => {
    if (roomAnnouncementOwnerRef.current === (currentUser?.id ?? null)) return;
    roomAnnouncementOwnerRef.current = currentUser?.id ?? null;
    announcedRoomsRef.current.clear();
  }, [currentUser?.id]);

  const setHelpActionRequiredCount = useCallback((count: number) => {
    if (!Number.isSafeInteger(count) || count < 0) return;
    counterGenerationRef.current += 1;
    setCount(count);
    setNotificationCount((current) => Math.max(current, count));
  }, []);

  const captureHelpCounterGeneration = useCallback(
    () => counterGenerationRef.current,
    [],
  );

  const setHelpNotificationCounts = useCallback((
    counts: AlumniHelpNotificationCountsDTO,
    expectedGeneration?: number,
  ) => {
    const notificationCount = counts.helpNotificationCount ?? counts.helpActionRequiredCount;
    if (
      !Number.isSafeInteger(counts.helpActionRequiredCount) ||
      counts.helpActionRequiredCount < 0 ||
      !Number.isSafeInteger(notificationCount) ||
      notificationCount < counts.helpActionRequiredCount ||
      (expectedGeneration !== undefined && expectedGeneration !== counterGenerationRef.current)
    ) return;
    counterGenerationRef.current += 1;
    setCount(counts.helpActionRequiredCount);
    setNotificationCount(notificationCount);
  }, []);

  const announceHelpRoomCreated = useCallback(
    (requestId: string, conversationId: string) => {
      if (
        !/^[a-f\d]{24}$/i.test(requestId) ||
        !/^[a-f\d]{24}$/i.test(conversationId)
      ) {
        return;
      }
      const key = `created:${requestId.toLowerCase()}:${conversationId.toLowerCase()}`;
      if (announcedRoomsRef.current.has(key)) return;
      announcedRoomsRef.current.add(key);
      showNotification({
        title: "Chat Room created",
        message:
          "Your private Alumni Help Chat Room is ready. You can open it now.",
        type: "success",
        actionButton: {
          text: "Open Chat Room",
          onClick: () =>
            navigate(
              `/dashboard/chat-rooms/${encodeURIComponent(conversationId)}`,
            ),
        },
        closeButtonText: "Later",
        lockUntilClose: true,
      });
    },
    [navigate, showNotification],
  );

  const announceHelpRoomGraceStarted = useCallback(
    (
      requestId: string,
      conversationId: string,
      writeAccessEndsAt?: string,
    ) => {
      if (
        !/^[a-f\d]{24}$/i.test(requestId) ||
        !/^[a-f\d]{24}$/i.test(conversationId) ||
        (writeAccessEndsAt !== undefined &&
          (Number.isNaN(Date.parse(writeAccessEndsAt)) ||
            new Date(writeAccessEndsAt).toISOString() !== writeAccessEndsAt))
      ) {
        return;
      }
      const key = `grace:${requestId.toLowerCase()}:${conversationId.toLowerCase()}`;
      if (announcedRoomsRef.current.has(key)) return;
      announcedRoomsRef.current.add(key);
      const message = writeAccessEndsAt
        ? `This Help Request is closed. You can continue using its private Chat Room until ${new Date(writeAccessEndsAt).toLocaleString()}.`
        : "This Help Request is closed. You can continue using its private Chat Room for the next 7 days.";
      showNotification({
        title: "Help request closed",
        message,
        type: "info",
        actionButton: {
          text: "Open Chat Room",
          onClick: () =>
            navigate(
              `/dashboard/chat-rooms/${encodeURIComponent(conversationId)}`,
            ),
        },
        closeButtonText: "Later",
        lockUntilClose: true,
      });
    },
    [navigate, showNotification],
  );

  const refreshHelpActionRequiredCount = useCallback(async () => {
    if (!canRead) {
      if (mountedRef.current) {
        setCount(0);
        setNotificationCount(0);
        setCountLoading(false);
      }
      return;
    }

    const requestSequence = ++requestSequenceRef.current;
    const expectedGeneration = captureHelpCounterGeneration();
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    if (mountedRef.current) setCountLoading(true);

    try {
      const counts = await alumniHelpService.getNotificationCounts(
        controller.signal,
      );
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestSequence === requestSequenceRef.current
      ) {
        setHelpNotificationCounts(counts, expectedGeneration);
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
  }, [canRead, captureHelpCounterGeneration, setHelpNotificationCounts]);

  useEffect(() => {
    mountedRef.current = true;
    if (counterOwnerRef.current !== userId) {
      counterOwnerRef.current = userId;
      counterGenerationRef.current += 1;
      seenRequestRevisionsRef.current.clear();
      latestEventTimeRef.current = 0;
      setCount(0);
      setNotificationCount(0);
    }
    void refreshHelpActionRequiredCount();
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [refreshHelpActionRequiredCount, userId]);

  useEffect(() => {
    if (!canRead) return;
    return socketService.on<unknown>("alumni_help_update", (payload) => {
      if (isAlumniHelpUpdatePayload(payload)) {
        const previousRevision = seenRequestRevisionsRef.current.get(payload.requestId);
        if (previousRevision !== undefined && payload.requestRevision < previousRevision) {
          // The request may have received a later update before its durable
          // closure delivery arrived. The one-time room-grace prompt remains
          // useful and is independently de-duplicated.
          if (payload.roomGraceStarted) {
            announceHelpRoomGraceStarted(
              payload.requestId,
              payload.roomGraceStarted.conversationId,
              payload.roomGraceStarted.writeAccessEndsAt,
            );
          }
          return;
        }
        seenRequestRevisionsRef.current.set(payload.requestId, payload.requestRevision);
        const eventTime = Date.parse(payload.timestamp);
        if (eventTime >= latestEventTimeRef.current) {
          latestEventTimeRef.current = eventTime;
          setHelpNotificationCounts({
            helpActionRequiredCount: payload.helpActionRequiredCount,
            helpNotificationCount: payload.helpNotificationCount ?? payload.helpActionRequiredCount,
          });
        }
        setHelpRefreshSequence((sequence) => sequence + 1);
        if (payload.roomCreated) {
          announceHelpRoomCreated(
            payload.requestId,
            payload.roomCreated.conversationId,
          );
        }
        if (payload.roomGraceStarted) {
          announceHelpRoomGraceStarted(
            payload.requestId,
            payload.roomGraceStarted.conversationId,
            payload.roomGraceStarted.writeAccessEndsAt,
          );
        }
      } else {
        setHelpRefreshSequence((sequence) => sequence + 1);
        void refreshHelpActionRequiredCount();
      }
    });
  }, [announceHelpRoomCreated, announceHelpRoomGraceStarted, canRead, refreshHelpActionRequiredCount, setHelpNotificationCounts]);

  useEffect(() => {
    if (!canRead) return;
    let lastRecoveryAt = -Infinity;
    const refreshAfterReconnect = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      // Browser focus and visibility frequently arrive together on iPhone.
      // Reconcile once, without repeatedly aborting the same request.
      if (Date.now() - lastRecoveryAt < 250) return;
      lastRecoveryAt = Date.now();
      setHelpRefreshSequence((sequence) => sequence + 1);
      void refreshHelpActionRequiredCount();
    };
    window.addEventListener("online", refreshAfterReconnect);
    window.addEventListener("focus", refreshAfterReconnect);
    document.addEventListener("visibilitychange", refreshAfterReconnect);
    const stopConnect = socketService.on("connect", refreshAfterReconnect);
    // Socket delivery is immediate. A bounded foreground reconciliation also
    // repairs missed events after mobile suspension or a silent connection loss.
    const timer = window.setInterval(() => {
      if (!activeRequestRef.current) refreshAfterReconnect();
    }, FOREGROUND_RECONCILIATION_MS);
    return () => {
      window.removeEventListener("online", refreshAfterReconnect);
      window.removeEventListener("focus", refreshAfterReconnect);
      document.removeEventListener("visibilitychange", refreshAfterReconnect);
      window.clearInterval(timer);
      stopConnect();
    };
  }, [canRead, refreshHelpActionRequiredCount]);

  const value = useMemo<AlumniHelpContextValue>(
    () => ({
      helpActionRequiredCount: counterOwnerRef.current === userId ? helpActionRequiredCount : 0,
      helpNotificationCount: counterOwnerRef.current === userId ? helpNotificationCount : 0,
      helpRefreshSequence,
      countLoading,
      refreshHelpActionRequiredCount,
      setHelpActionRequiredCount,
      setHelpNotificationCounts,
      captureHelpCounterGeneration,
      announceHelpRoomCreated,
      announceHelpRoomGraceStarted,
    }),
    [
      announceHelpRoomCreated,
      announceHelpRoomGraceStarted,
      countLoading,
      helpActionRequiredCount,
      helpNotificationCount,
      helpRefreshSequence,
      refreshHelpActionRequiredCount,
      setHelpActionRequiredCount,
      setHelpNotificationCounts,
      captureHelpCounterGeneration,
      userId,
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

export function useOptionalAlumniHelp(): AlumniHelpContextValue | undefined {
  return useContext(AlumniHelpContext);
}
