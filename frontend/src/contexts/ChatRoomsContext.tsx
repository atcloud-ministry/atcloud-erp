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
import { useSocket } from "../hooks/useSocket";
import {
  conversationsService,
  decodeChatUnreadUpdate,
} from "../services/api";
import { socketService } from "../services/socketService";
import { useAuth } from "../hooks/useAuth";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import { isAlumniHelpUpdatePayload } from "./AlumniHelpContext";

interface ChatRoomsContextValue {
  chatUnreadTotal: number;
  roomUnreadCounts: Readonly<Record<string, number>>;
  countLoading: boolean;
  countReady: boolean;
  refreshChatUnreadTotal: () => Promise<void>;
  captureCounterGeneration: () => number;
  applyCounterSnapshot: (
    chatUnreadTotal: number,
    conversationId?: string,
    roomUnreadCount?: number,
    lastReadSequence?: number,
    expectedGeneration?: number,
  ) => void;
}

const ChatRoomsContext = createContext<ChatRoomsContextValue | undefined>(
  undefined,
);
const EMPTY_ROOM_COUNTS: Readonly<Record<string, number>> = Object.freeze({});
const UNREAD_RECONCILIATION_DEBOUNCE_MS = 100;

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function ChatRoomsProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const { config, status } = useRuntimeConfig();
  useSocket();
  const [chatUnreadTotal, setChatUnreadTotal] = useState(0);
  const [roomUnreadCounts, setRoomUnreadCounts] = useState<
    Record<string, number>
  >({});
  const [countLoading, setCountLoading] = useState(false);
  const [countReady, setCountReady] = useState(false);
  const mountedRef = useRef(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const reconciliationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const requestSequenceRef = useRef(0);
  const roomLastReadSequencesRef = useRef<Record<string, number>>({});
  const counterGenerationRef = useRef(0);
  const userId = currentUser?.id ?? null;
  const counterOwnerRef = useRef<string | null>(userId);
  const canRead =
    !!currentUser && status === "ready" && config.alumniNetwork.readable;

  const applyCounterSnapshot = useCallback(
    (
      total: number,
      conversationId?: string,
      roomUnreadCount?: number,
      lastReadSequence?: number,
      expectedGeneration?: number,
    ) => {
      if (!isNonNegativeSafeInteger(total)) return;
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== counterGenerationRef.current
      ) {
        return;
      }
      if (
        conversationId &&
        roomUnreadCount !== undefined &&
        isNonNegativeSafeInteger(roomUnreadCount)
      ) {
        if (
          lastReadSequence !== undefined &&
          isNonNegativeSafeInteger(lastReadSequence)
        ) {
          const known = roomLastReadSequencesRef.current[conversationId] ?? -1;
          if (lastReadSequence < known) return;
          roomLastReadSequencesRef.current[conversationId] = lastReadSequence;
        }
        setRoomUnreadCounts((current) => ({
          ...current,
          [conversationId]: roomUnreadCount,
        }));
      }
      setChatUnreadTotal(total);
      setCountReady(true);
      if (expectedGeneration === undefined) {
        counterGenerationRef.current += 1;
      }
    },
    [],
  );

  const captureCounterGeneration = useCallback(
    () => counterGenerationRef.current,
    [],
  );

  const refreshChatUnreadTotal = useCallback(async () => {
    if (!canRead) {
      if (mountedRef.current) {
        setChatUnreadTotal(0);
        setRoomUnreadCounts({});
        roomLastReadSequencesRef.current = {};
        setCountLoading(false);
        // Once runtime configuration is known, an unavailable Chat feature has
        // an authoritative zero count.
        setCountReady(Boolean(userId) && status === "ready");
      }
      return;
    }
    const requestSequence = ++requestSequenceRef.current;
    const expectedGeneration = counterGenerationRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    if (mountedRef.current) setCountLoading(true);
    try {
      const total = await conversationsService.getUnreadCount(
        controller.signal,
      );
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestSequence === requestSequenceRef.current
      ) {
        if (expectedGeneration === counterGenerationRef.current) {
          setChatUnreadTotal(total);
          setCountReady(true);
        }
      }
    } catch {
      // The navigation badge is supplementary. Preserve the last trusted
      // absolute count and let Chat Rooms show contextual loading errors.
    } finally {
      if (
        mountedRef.current &&
        requestSequence === requestSequenceRef.current
      ) {
        setCountLoading(false);
        activeRequestRef.current = null;
      }
    }
  }, [canRead, status, userId]);

  const scheduleAuthoritativeUnreadRefresh = useCallback(() => {
    if (reconciliationTimerRef.current) return;
    const reconcileWhenIdle = () => {
      if (!mountedRef.current) {
        reconciliationTimerRef.current = null;
        return;
      }
      if (activeRequestRef.current) {
        reconciliationTimerRef.current = setTimeout(
          reconcileWhenIdle,
          UNREAD_RECONCILIATION_DEBOUNCE_MS,
        );
        return;
      }
      reconciliationTimerRef.current = null;
      void refreshChatUnreadTotal();
    };
    reconciliationTimerRef.current = setTimeout(
      reconcileWhenIdle,
      UNREAD_RECONCILIATION_DEBOUNCE_MS,
    );
  }, [refreshChatUnreadTotal]);

  useEffect(() => {
    mountedRef.current = true;
    if (counterOwnerRef.current !== userId) {
      counterOwnerRef.current = userId;
      setChatUnreadTotal(0);
      setRoomUnreadCounts({});
      roomLastReadSequencesRef.current = {};
      counterGenerationRef.current += 1;
      setCountLoading(false);
      setCountReady(false);
    }
    void refreshChatUnreadTotal();
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      if (reconciliationTimerRef.current) {
        clearTimeout(reconciliationTimerRef.current);
        reconciliationTimerRef.current = null;
      }
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [refreshChatUnreadTotal, userId]);

  useEffect(() => {
    if (!canRead) return;
    const reconcileAfterReconnect = () => {
      void refreshChatUnreadTotal();
    };
    window.addEventListener("online", reconcileAfterReconnect);
    return () => window.removeEventListener("online", reconcileAfterReconnect);
  }, [canRead, refreshChatUnreadTotal]);

  useEffect(() => {
    if (!canRead) return;
    const stopUnread = socketService.on<unknown>(
      "chat_unread_update",
      (payload) => {
        try {
          const update = decodeChatUnreadUpdate(payload);
          applyCounterSnapshot(
            update.chatUnreadTotal,
            update.conversationId,
            update.roomUnreadCount,
            update.lastReadSequence,
          );
          scheduleAuthoritativeUnreadRefresh();
        } catch {
          void refreshChatUnreadTotal();
        }
      },
    );
    const stopReconnect = socketService.on("connect", () => {
      void refreshChatUnreadTotal();
    });
    const stopHelp = socketService.on<unknown>(
      "alumni_help_update",
      (payload) => {
        if (isAlumniHelpUpdatePayload(payload)) {
          void refreshChatUnreadTotal();
        }
      },
    );
    return () => {
      stopUnread();
      stopReconnect();
      stopHelp();
    };
  }, [
    applyCounterSnapshot,
    canRead,
    refreshChatUnreadTotal,
    scheduleAuthoritativeUnreadRefresh,
  ]);

  const value = useMemo<ChatRoomsContextValue>(
    () => {
      const identityMatches = counterOwnerRef.current === userId;
      return {
        chatUnreadTotal: identityMatches ? chatUnreadTotal : 0,
        roomUnreadCounts: identityMatches
          ? roomUnreadCounts
          : EMPTY_ROOM_COUNTS,
        countLoading: identityMatches ? countLoading : false,
        countReady: identityMatches ? countReady : false,
        refreshChatUnreadTotal,
        captureCounterGeneration,
        applyCounterSnapshot,
      };
    },
    [
      applyCounterSnapshot,
      captureCounterGeneration,
      chatUnreadTotal,
      countLoading,
      countReady,
      refreshChatUnreadTotal,
      roomUnreadCounts,
      userId,
    ],
  );

  return (
    <ChatRoomsContext.Provider value={value}>
      {children}
    </ChatRoomsContext.Provider>
  );
}

export function useChatRooms(): ChatRoomsContextValue {
  const value = useContext(ChatRoomsContext);
  if (!value) {
    throw new Error("useChatRooms must be used within ChatRoomsProvider");
  }
  return value;
}

export function useOptionalChatRooms(): ChatRoomsContextValue | undefined {
  return useContext(ChatRoomsContext);
}
