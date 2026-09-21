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
import { useNavigate } from "react-router-dom";
import { useNotification } from "./NotificationModalContext";
import { useRuntimeConfig } from "./RuntimeConfigContext";

export interface AlumniHelpUpdatePayload {
  requestId: string;
  requestRevision: number;
  helpActionRequiredCount: number;
  roomCreated?: {
    conversationId: string;
  };
  timestamp: string;
}

interface AlumniHelpContextValue {
  helpActionRequiredCount: number;
  countLoading: boolean;
  refreshHelpActionRequiredCount: () => Promise<void>;
  setHelpActionRequiredCount: (count: number) => void;
  announceHelpRoomCreated: (requestId: string, conversationId: string) => void;
}

const AlumniHelpContext = createContext<AlumniHelpContextValue | undefined>(
  undefined,
);

export function isAlumniHelpUpdatePayload(
  value: unknown,
): value is AlumniHelpUpdatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  const hasRoomCreated = Object.prototype.hasOwnProperty.call(
    update,
    "roomCreated",
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
  return (
    Object.keys(update).length === (hasRoomCreated ? 5 : 4) &&
    [
      "requestId",
      "requestRevision",
      "helpActionRequiredCount",
      "timestamp",
    ]
      .concat(hasRoomCreated ? ["roomCreated"] : [])
      .every((key) => Object.prototype.hasOwnProperty.call(update, key)) &&
    typeof update.requestId === "string" &&
    /^[a-f\d]{24}$/i.test(update.requestId) &&
    Number.isSafeInteger(update.requestRevision) &&
    Number(update.requestRevision) >= 0 &&
    Number.isSafeInteger(update.helpActionRequiredCount) &&
    Number(update.helpActionRequiredCount) >= 0 &&
    typeof update.timestamp === "string" &&
    !Number.isNaN(Date.parse(update.timestamp)) &&
    new Date(update.timestamp).toISOString() === update.timestamp &&
    hasValidRoomCreated
  );
}

export function AlumniHelpProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const { config, status } = useRuntimeConfig();
  const { showNotification } = useNotification();
  const navigate = useNavigate();
  useSocket();
  const [helpActionRequiredCount, setCount] = useState(0);
  const [countLoading, setCountLoading] = useState(false);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const announcedRoomsRef = useRef(new Set<string>());
  const roomAnnouncementOwnerRef = useRef<string | null>(currentUser?.id ?? null);

  const canRead =
    !!currentUser && status === "ready" && config.alumniNetwork.readable;

  useEffect(() => {
    if (roomAnnouncementOwnerRef.current === (currentUser?.id ?? null)) return;
    roomAnnouncementOwnerRef.current = currentUser?.id ?? null;
    announcedRoomsRef.current.clear();
  }, [currentUser?.id]);

  const setHelpActionRequiredCount = useCallback((count: number) => {
    if (Number.isSafeInteger(count) && count >= 0) setCount(count);
  }, []);

  const announceHelpRoomCreated = useCallback(
    (requestId: string, conversationId: string) => {
      if (
        !/^[a-f\d]{24}$/i.test(requestId) ||
        !/^[a-f\d]{24}$/i.test(conversationId)
      ) {
        return;
      }
      const key = `${requestId.toLowerCase()}:${conversationId.toLowerCase()}`;
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
        if (payload.roomCreated) {
          announceHelpRoomCreated(
            payload.requestId,
            payload.roomCreated.conversationId,
          );
        }
      } else {
        void refreshHelpActionRequiredCount();
      }
    });
  }, [announceHelpRoomCreated, canRead, refreshHelpActionRequiredCount]);

  useEffect(() => {
    if (!canRead) return;
    const refreshAfterReconnect = () => {
      void refreshHelpActionRequiredCount();
    };
    window.addEventListener("online", refreshAfterReconnect);
    const stopConnect = socketService.on("connect", refreshAfterReconnect);
    return () => {
      window.removeEventListener("online", refreshAfterReconnect);
      stopConnect();
    };
  }, [canRead, refreshHelpActionRequiredCount]);

  const value = useMemo<AlumniHelpContextValue>(
    () => ({
      helpActionRequiredCount,
      countLoading,
      refreshHelpActionRequiredCount,
      setHelpActionRequiredCount,
      announceHelpRoomCreated,
    }),
    [
      announceHelpRoomCreated,
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
