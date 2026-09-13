import {
  ArrowLeftIcon,
  BellIcon,
  BellSlashIcon,
} from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import ChatAvatar from "../components/chat/ChatAvatar";
import AnnouncementComposer from "../components/chat/AnnouncementComposer";
import ChatComposer, {
  type ChatComposerValue,
} from "../components/chat/ChatComposer";
import ChatMessageList from "../components/chat/ChatMessageList";
import type { ChatDisplayMessage } from "../components/chat/ChatMessageItem";
import ConnectionStatus from "../components/chat/ConnectionStatus";
import { Button, ErrorState, LoadingState } from "../components/ui";
import { useChatRooms } from "../contexts/ChatRoomsContext";
import { isAlumniHelpUpdatePayload } from "../contexts/AlumniHelpContext";
import { useRuntimeConfig } from "../contexts/RuntimeConfigContext";
import { useAuth } from "../hooks/useAuth";
import { useSocket } from "../hooks/useSocket";
import {
  CHAT_HISTORY_DEFAULT_PAGE_SIZE,
  CHAT_HISTORY_MAX_PAGE_SIZE,
  conversationsService,
  decodeChatMessageEvent,
  decodeChatUnreadUpdate,
  type ChatHistoryDTO,
  type ChatMessageDTO,
  type ConversationDTO,
} from "../services/api";
import { socketService } from "../services/socketService";
import { createIdempotencyKey } from "../utils/idempotencyKey";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const LAST_MESSAGE_PREVIEW_CODE_POINTS = 160;
const PROGRAM_ROOM_ACCESS_REFRESH_RETRY_DELAYS_MS = Object.freeze([
  250, 750, 1_500,
]);

function retryableProgramRoomProjectionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = Number((error as { readonly status?: unknown }).status);
  return status === 404 || status === 409;
}

function waitForProgramRoomAccessRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function previewContent(value: string | null): string | null {
  if (!value) return null;
  const codePoints = Array.from(value);
  return codePoints.length <= LAST_MESSAGE_PREVIEW_CODE_POINTS
    ? value
    : `${codePoints.slice(0, LAST_MESSAGE_PREVIEW_CODE_POINTS).join("")}…`;
}

function mergeCanonicalMessages(
  current: readonly ChatMessageDTO[],
  incoming: readonly ChatMessageDTO[],
): ChatMessageDTO[] {
  const next = [...current];
  for (const message of incoming) {
    const conflict = next.findIndex(
      (entry) =>
        entry.id === message.id ||
        entry.sequence === message.sequence ||
        (entry.sender.id === message.sender.id &&
          entry.clientMessageId === message.clientMessageId),
    );
    if (conflict >= 0) next.splice(conflict, 1);
    next.push(message);
  }
  return next.sort((first, second) => first.sequence - second.sequence);
}

function advanceThroughBufferedSequence(
  currentSequence: number,
  messages: readonly ChatMessageDTO[],
): number {
  const availableSequences = new Set(
    messages
      .map((message) => message.sequence)
      .filter((sequence) => sequence > currentSequence),
  );
  let nextSequence = currentSequence;
  while (availableSequences.has(nextSequence + 1)) nextSequence += 1;
  return nextSequence;
}

function initialVerifiedSequence(
  messages: readonly ChatMessageDTO[],
  lastReadSequence: number,
): number {
  return Math.max(
    lastReadSequence,
    ...messages.map((message) => message.sequence),
  );
}

function historyHasOlder(history: ChatHistoryDTO): boolean {
  return (
    history.pagination.nextBeforeSequence !== null ||
    (history.pagination.beforeSequence === null &&
      history.pagination.afterSequence === null &&
      history.pagination.hasMore)
  );
}

export default function ChatRoom() {
  const { conversationId = "" } = useParams<{ conversationId: string }>();
  const { currentUser } = useAuth();
  const { config, status: runtimeStatus } = useRuntimeConfig();
  const { connected, connectionLimited } = useSocket();
  const { applyCounterSnapshot, captureCounterGeneration } = useChatRooms();
  const [conversation, setConversation] = useState<ConversationDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [pendingMessages, setPendingMessages] = useState<ChatDisplayMessage[]>([]);
  const [sentClientMessageIds, setSentClientMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [muteBusy, setMuteBusy] = useState(false);
  const [liveDegraded, setLiveDegraded] = useState(false);
  const [newMessageAvailable, setNewMessageAvailable] = useState(false);
  const [verifiedSequence, setVerifiedSequence] = useState(0);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [loadedRoomKey, setLoadedRoomKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const mountedRef = useRef(false);
  const conversationRef = useRef<ConversationDTO | null>(null);
  const messagesRef = useRef<ChatMessageDTO[]>([]);
  const pendingMessagesRef = useRef<ChatDisplayMessage[]>([]);
  const confirmedClientMessageIdsRef = useRef<Set<string>>(new Set());
  const readRequestedRef = useRef(0);
  const pendingReadSequenceRef = useRef(0);
  const readInFlightRef = useRef(false);
  const verifiedSequenceRef = useRef(0);
  const recoveryInFlightRef = useRef<Promise<void> | null>(null);
  const recoveryRequestedRef = useRef(false);
  const helpRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomSessionGenerationRef = useRef(0);
  const readable =
    runtimeStatus === "ready" && config.alumniNetwork.readable;
  const writable =
    runtimeStatus === "ready" && config.alumniNetwork.writable;
  const validId = OBJECT_ID_PATTERN.test(conversationId);
  const roomKey = `${currentUser?.id ?? "anonymous"}:${conversationId}`;
  const effectiveCanSend = !!conversation && writable && conversation.viewer.canSend;
  const effectiveCanAnnounce =
    !!conversation &&
    writable &&
    conversation.kind === "program" &&
    conversation.section === "current" &&
    conversation.viewer.canAnnounce;
  const realtimeEligible =
    conversation?.status === "current" &&
    conversation.viewer.status === "active";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    pendingMessagesRef.current = pendingMessages;
  }, [pendingMessages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = scrollRef.current;
    if (!container) return;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: container.scrollHeight, behavior });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    atBottomRef.current = true;
    setNewMessageAvailable(false);
  }, []);

  const mergeAndStoreMessages = useCallback(
    (
      incoming: readonly ChatMessageDTO[],
      restVerifiedThroughSequence?: number,
    ) => {
      const next = mergeCanonicalMessages(messagesRef.current, incoming);
      messagesRef.current = next;
      setMessages(next);
      const verifiedBaseline = Math.max(
        verifiedSequenceRef.current,
        restVerifiedThroughSequence ?? verifiedSequenceRef.current,
      );
      const nextVerifiedSequence = advanceThroughBufferedSequence(
        verifiedBaseline,
        next,
      );
      if (nextVerifiedSequence !== verifiedSequenceRef.current) {
        verifiedSequenceRef.current = nextVerifiedSequence;
        setVerifiedSequence(nextVerifiedSequence);
      }
      return nextVerifiedSequence;
    },
    [],
  );

  const advanceRead = useCallback(
    (throughSequence: number) => {
      const room = conversationRef.current;
      const safeThroughSequence = Math.min(
        throughSequence,
        verifiedSequenceRef.current,
      );
      if (
        !room ||
        room.id !== conversationId ||
        !writable ||
        room.viewer.status !== "active" ||
        !room.viewer.canSend ||
        safeThroughSequence <= room.viewer.lastReadSequence ||
        safeThroughSequence <= readRequestedRef.current ||
        !validId
      ) {
        return;
      }
      pendingReadSequenceRef.current = Math.max(
        pendingReadSequenceRef.current,
        safeThroughSequence,
      );
      if (readInFlightRef.current) return;
      readInFlightRef.current = true;

      void (async () => {
        let retriedConflict = false;
        try {
          while (mountedRef.current) {
            const activeRoom = conversationRef.current;
            const target = pendingReadSequenceRef.current;
            if (
              !activeRoom ||
              activeRoom.id !== conversationId ||
              activeRoom.viewer.status !== "active" ||
              !activeRoom.viewer.canSend ||
              target <= activeRoom.viewer.lastReadSequence
            ) {
              pendingReadSequenceRef.current = 0;
              break;
            }
            pendingReadSequenceRef.current = 0;
            readRequestedRef.current = target;
            const requestCounterGeneration = captureCounterGeneration();
            const requestRoomSession = roomSessionGenerationRef.current;
            try {
              const result = await conversationsService.markRead(
                conversationId,
                target,
              );
              if (
                !mountedRef.current ||
                requestRoomSession !== roomSessionGenerationRef.current ||
                result.conversationId !== conversationId ||
                conversationRef.current?.id !== conversationId
              ) {
                return;
              }
              retriedConflict = false;
              const currentRoom = conversationRef.current;
              const counterSnapshotCurrent =
                captureCounterGeneration() === requestCounterGeneration;
              if (
                currentRoom &&
                result.lastReadSequence >=
                  currentRoom.viewer.lastReadSequence
              ) {
                const nextRoom = {
                  ...currentRoom,
                  viewer: {
                    ...currentRoom.viewer,
                    lastReadSequence: result.lastReadSequence,
                    unreadCount: counterSnapshotCurrent
                      ? result.unreadCount
                      : currentRoom.viewer.unreadCount,
                  },
                };
                conversationRef.current = nextRoom;
                setConversation((current) =>
                  current &&
                  current.id === conversationId &&
                  result.lastReadSequence >=
                    current.viewer.lastReadSequence
                    ? nextRoom
                    : current,
                );
              }
              readRequestedRef.current = Math.max(
                readRequestedRef.current,
                result.lastReadSequence,
              );
              if (counterSnapshotCurrent) {
                applyCounterSnapshot(
                  result.chatUnreadTotal,
                  conversationId,
                  result.unreadCount,
                  result.lastReadSequence,
                );
              }
            } catch (reason) {
              if (
                requestRoomSession !== roomSessionGenerationRef.current
              ) {
                return;
              }
              readRequestedRef.current =
                conversationRef.current?.viewer.lastReadSequence ?? 0;
              pendingReadSequenceRef.current = Math.max(
                pendingReadSequenceRef.current,
                target,
              );
              const status = (reason as { status?: unknown } | null)?.status;
              if (status === 409 && !retriedConflict) {
                retriedConflict = true;
                continue;
              }
              break;
            }
          }
        } finally {
          readInFlightRef.current = false;
        }
      })();
    },
    [
      applyCounterSnapshot,
      captureCounterGeneration,
      conversationId,
      validId,
      writable,
    ],
  );

  useEffect(() => {
    const roomSession = ++roomSessionGenerationRef.current;
    setLoadedRoomKey(null);
    setConversation(null);
    conversationRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    setVerifiedSequence(0);
    verifiedSequenceRef.current = 0;
    recoveryRequestedRef.current = false;
    recoveryInFlightRef.current = null;
    setPendingMessages([]);
    pendingMessagesRef.current = [];
    readRequestedRef.current = 0;
    pendingReadSequenceRef.current = 0;
    readInFlightRef.current = false;
    setSentClientMessageIds(new Set());
    confirmedClientMessageIdsRef.current.clear();
    setNewMessageAvailable(false);
    setHasOlder(false);
    if (!readable || !validId || !currentUser?.id) return;
    const controller = new AbortController();
    const counterGeneration = captureCounterGeneration();
    setLoading(true);
    setError(null);
    setActionError(null);
    void Promise.all([
      conversationsService.get(conversationId, controller.signal),
      conversationsService.history(
        conversationId,
        { limit: CHAT_HISTORY_DEFAULT_PAGE_SIZE },
        controller.signal,
      ),
    ])
      .then(([detail, history]) => {
        if (
          controller.signal.aborted ||
          roomSession !== roomSessionGenerationRef.current
        ) {
          return;
        }
        if (history.conversationId !== conversationId) {
          throw new Error("Chat history did not match this Room");
        }
        setConversation(detail.conversation);
        conversationRef.current = detail.conversation;
        readRequestedRef.current = detail.conversation.viewer.lastReadSequence;
        pendingReadSequenceRef.current = 0;
        setMessages(history.messages);
        messagesRef.current = history.messages;
        const initialSequence = initialVerifiedSequence(
          history.messages,
          detail.conversation.viewer.lastReadSequence,
        );
        verifiedSequenceRef.current = initialSequence;
        setVerifiedSequence(initialSequence);
        setPendingMessages([]);
        pendingMessagesRef.current = [];
        confirmedClientMessageIdsRef.current.clear();
        setSentClientMessageIds(new Set());
        setHasOlder(historyHasOlder(history));
        setLoadedRoomKey(roomKey);
        applyCounterSnapshot(
          detail.chatUnreadTotal,
          conversationId,
          detail.conversation.viewer.unreadCount,
          detail.conversation.viewer.lastReadSequence,
          counterGeneration,
        );
        requestAnimationFrame(() => scrollToBottom());
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const status = (reason as { status?: unknown } | null)?.status;
        setError(
          status === 403 || status === 404
            ? "This Chat Room is not available to you."
            : reason instanceof Error
              ? reason.message
              : "Unable to load this Chat Room.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (roomSessionGenerationRef.current === roomSession) {
        roomSessionGenerationRef.current += 1;
      }
    };
  }, [
    applyCounterSnapshot,
    captureCounterGeneration,
    conversationId,
    currentUser?.id,
    readable,
    reloadSequence,
    roomKey,
    scrollToBottom,
    validId,
    writable,
  ]);

  useEffect(() => {
    if (
      verifiedSequence > 0 &&
      atBottomRef.current &&
      typeof document !== "undefined" &&
      document.visibilityState !== "hidden"
    ) {
      void advanceRead(verifiedSequence);
    }
  }, [advanceRead, verifiedSequence]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "hidden" ||
        !atBottomRef.current ||
        verifiedSequenceRef.current <= 0
      ) {
        return;
      }
      advanceRead(verifiedSequenceRef.current);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [advanceRead]);

  const recoverMessages = useCallback((): Promise<void> => {
    if (!validId) return Promise.resolve();
    recoveryRequestedRef.current = true;
    const activeRecovery = recoveryInFlightRef.current;
    if (activeRecovery) return activeRecovery;
    const roomSession = roomSessionGenerationRef.current;
    const recovery = (async () => {
      try {
        while (
          mountedRef.current &&
          roomSession === roomSessionGenerationRef.current &&
          recoveryRequestedRef.current
        ) {
          recoveryRequestedRef.current = false;
          for (;;) {
            const afterSequence = verifiedSequenceRef.current;
            const history = await conversationsService.history(conversationId, {
              afterSequence,
              limit: CHAT_HISTORY_MAX_PAGE_SIZE,
            });
            if (
              !mountedRef.current ||
              roomSession !== roomSessionGenerationRef.current ||
              history.conversationId !== conversationId
            ) {
              return;
            }
            const confirmedOwnIds = new Set(
              history.messages
                .filter((message) => message.sender.id === currentUser?.id)
                .map((message) => message.clientMessageId),
            );
            if (confirmedOwnIds.size > 0) {
              confirmedOwnIds.forEach((id) =>
                confirmedClientMessageIdsRef.current.add(id),
              );
              setSentClientMessageIds((current) => {
                const next = new Set(current);
                confirmedOwnIds.forEach((id) => next.add(id));
                return next;
              });
              const hadPendingMatch = pendingMessagesRef.current.some((message) =>
                confirmedOwnIds.has(message.clientMessageId),
              );
              if (hadPendingMatch) {
                pendingMessagesRef.current = pendingMessagesRef.current.filter(
                  (message) => !confirmedOwnIds.has(message.clientMessageId),
                );
                setPendingMessages((current) =>
                  current.filter(
                    (message) => !confirmedOwnIds.has(message.clientMessageId),
                  ),
                );
                setActionError(null);
              }
            }
            const restVerifiedThroughSequence = Math.max(
              afterSequence,
              ...history.messages.map((message) => message.sequence),
            );
            const nextVerifiedSequence = mergeAndStoreMessages(
              history.messages,
              restVerifiedThroughSequence,
            );
            if (
              !history.pagination.hasMore ||
              nextVerifiedSequence <= afterSequence
            ) {
              break;
            }
          }
        }
        if (atBottomRef.current) {
          const latestVerifiedSequence = verifiedSequenceRef.current;
          requestAnimationFrame(() => scrollToBottom());
          if (
            latestVerifiedSequence > 0 &&
            typeof document !== "undefined" &&
            document.visibilityState !== "hidden"
          ) {
            advanceRead(latestVerifiedSequence);
          }
        }
      } catch {
        // Keep the durable history already loaded. The visible reconnect state
        // remains until a later Socket event or manual refresh succeeds.
        if (
          mountedRef.current &&
          roomSession === roomSessionGenerationRef.current
        ) {
          setLiveDegraded(true);
        }
      }
    })();
    recoveryInFlightRef.current = recovery;
    return recovery.finally(() => {
      if (recoveryInFlightRef.current === recovery) {
        recoveryInFlightRef.current = null;
      }
    });
  }, [
    advanceRead,
    conversationId,
    currentUser?.id,
    mergeAndStoreMessages,
    scrollToBottom,
    validId,
  ]);

  useEffect(() => {
    if (!readable || !validId || !realtimeEligible) return;
    let released = false;
    const accessRefreshController = new AbortController();
    setLiveDegraded(false);
    void socketService
      .joinConversationRoom(conversationId)
      .then(() => {
        if (!released) void recoverMessages();
      })
      .catch(() => {
        if (!released) setLiveDegraded(true);
      });

    const stopMessage = socketService.on<unknown>("chat_message", (payload) => {
      try {
        const event = decodeChatMessageEvent(payload);
        if (event.message.conversationId !== conversationId) return;
        const previousVerifiedSequence = verifiedSequenceRef.current;
        const nextVerifiedSequence = mergeAndStoreMessages([event.message]);
        if (event.message.sender.id === currentUser?.id) {
          setPendingMessages((current) => {
            const next = current.filter(
              (message) =>
                message.clientMessageId !== event.message.clientMessageId,
            );
            pendingMessagesRef.current = next;
            return next;
          });
          confirmedClientMessageIdsRef.current.add(
            event.message.clientMessageId,
          );
          setSentClientMessageIds((current) => {
            const next = new Set(current);
            next.add(event.message.clientMessageId);
            return next;
          });
          setActionError(null);
        }
        const applyLastMessage = (current: ConversationDTO) =>
          event.message.sequence < current.lastSequence
            ? current
            : {
                ...current,
                lastSequence: event.message.sequence,
                lastMessage: {
                  id: event.message.id,
                  sequence: event.message.sequence,
                  kind: event.message.kind,
                  sender: event.message.sender,
                  contentPreview: previewContent(event.message.content),
                  safeLink: event.message.safeLink,
                  createdAt: event.message.createdAt,
                },
                updatedAt: event.message.createdAt,
              };
        if (conversationRef.current) {
          conversationRef.current = applyLastMessage(conversationRef.current);
        }
        setConversation((current) =>
          current ? applyLastMessage(current) : current,
        );
        if (atBottomRef.current) {
          requestAnimationFrame(() => scrollToBottom("smooth"));
        } else {
          setNewMessageAvailable(true);
        }
        if (
          event.message.sequence > previousVerifiedSequence + 1 &&
          nextVerifiedSequence < event.message.sequence
        ) {
          void recoverMessages();
        }
      } catch {
        void recoverMessages();
      }
    });
    const stopUnread = socketService.on<unknown>(
      "chat_unread_update",
      (payload) => {
        try {
          const update = decodeChatUnreadUpdate(payload);
          if (update.conversationId !== conversationId) return;
          const currentRoom = conversationRef.current;
          if (
            !currentRoom ||
            update.lastReadSequence < currentRoom.viewer.lastReadSequence
          ) {
            return;
          }
          const nextRoom = {
            ...currentRoom,
            viewer: {
              ...currentRoom.viewer,
              lastReadSequence: update.lastReadSequence,
              unreadCount: update.roomUnreadCount,
            },
          };
          conversationRef.current = nextRoom;
          readRequestedRef.current = Math.max(
            readRequestedRef.current,
            update.lastReadSequence,
          );
          if (pendingReadSequenceRef.current <= update.lastReadSequence) {
            pendingReadSequenceRef.current = 0;
          }
          setConversation((current) => {
            if (
              !current ||
              update.lastReadSequence < current.viewer.lastReadSequence
            ) {
              return current;
            }
            return {
              ...current,
              viewer: {
                ...current.viewer,
                lastReadSequence: update.lastReadSequence,
                unreadCount: update.roomUnreadCount,
              },
            };
          });
        } catch {
          void recoverMessages();
        }
      },
    );
    const stopHelp = socketService.on<unknown>(
      "alumni_help_update",
      (payload) => {
        if (
          !isAlumniHelpUpdatePayload(payload) ||
          payload.requestId !== conversationRef.current?.helpRequestId ||
          helpRefreshTimerRef.current !== null
        ) {
          return;
        }
        helpRefreshTimerRef.current = setTimeout(() => {
          helpRefreshTimerRef.current = null;
          setReloadSequence((value) => value + 1);
        }, 100);
      },
    );
    const refreshProgramRoomAccess = async () => {
      const currentRoom = conversationRef.current;
      if (
        currentRoom?.id !== conversationId ||
        currentRoom.kind !== "program"
      ) {
        setLiveDegraded(false);
        await recoverMessages();
        return;
      }

      const roomSession = roomSessionGenerationRef.current;
      const counterGeneration = captureCounterGeneration();
      for (
        let attempt = 0;
        attempt <= PROGRAM_ROOM_ACCESS_REFRESH_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        try {
          const detail = await conversationsService.get(
            conversationId,
            accessRefreshController.signal,
          );
          if (
            released ||
            accessRefreshController.signal.aborted ||
            roomSession !== roomSessionGenerationRef.current ||
            detail.conversation.id !== conversationId ||
            detail.conversation.kind !== "program"
          ) {
            return;
          }

          const previous = conversationRef.current;
          const staleReadSnapshot =
            previous?.id === conversationId &&
            detail.conversation.viewer.lastReadSequence <
              previous.viewer.lastReadSequence;
          const refreshed = staleReadSnapshot
            ? {
                ...detail.conversation,
                viewer: {
                  ...detail.conversation.viewer,
                  lastReadSequence: previous.viewer.lastReadSequence,
                  unreadCount: previous.viewer.unreadCount,
                },
              }
            : detail.conversation;
          conversationRef.current = refreshed;
          setConversation((room) =>
            room?.id === conversationId ? refreshed : room,
          );
          readRequestedRef.current = Math.max(
            readRequestedRef.current,
            refreshed.viewer.lastReadSequence,
          );
          if (!refreshed.viewer.canSend) {
            pendingReadSequenceRef.current = 0;
            pendingMessagesRef.current = [];
            setPendingMessages([]);
            setActionError(null);
          }
          applyCounterSnapshot(
            detail.chatUnreadTotal,
            conversationId,
            refreshed.viewer.unreadCount,
            refreshed.viewer.lastReadSequence,
            counterGeneration,
          );
          setLiveDegraded(false);
          await recoverMessages();
          return;
        } catch (reason) {
          if (
            released ||
            accessRefreshController.signal.aborted ||
            roomSession !== roomSessionGenerationRef.current
          ) {
            return;
          }
          const delayMs = PROGRAM_ROOM_ACCESS_REFRESH_RETRY_DELAYS_MS[attempt];
          if (
            delayMs === undefined ||
            !retryableProgramRoomProjectionError(reason)
          ) {
            setLiveDegraded(true);
            return;
          }
          if (
            !(await waitForProgramRoomAccessRetry(
              delayMs,
              accessRefreshController.signal,
            ))
          ) {
            return;
          }
        }
      }
    };
    const stopDisconnect = socketService.on("disconnect", (reason) => {
      if (
        reason !== "io server disconnect" ||
        socketService.connectionStatus?.connectionLimited
      ) {
        return;
      }
      const currentRoom = conversationRef.current;
      if (
        currentRoom?.id !== conversationId ||
        currentRoom.kind !== "program" ||
        !currentRoom.viewer.canSend
      ) {
        return;
      }
      const failClosedRoom: ConversationDTO = {
        ...currentRoom,
        viewer: {
          ...currentRoom.viewer,
          accessMode: "read_only",
          canSend: false,
          canAnnounce: false,
        },
      };
      conversationRef.current = failClosedRoom;
      setConversation((room) =>
        room?.id === conversationId ? failClosedRoom : room,
      );
      setLiveDegraded(true);
    });
    const stopReconnect = socketService.on("connect", () => {
      void refreshProgramRoomAccess();
    });
    return () => {
      released = true;
      accessRefreshController.abort();
      socketService.leaveConversationRoom(conversationId);
      stopMessage();
      stopUnread();
      stopHelp();
      stopDisconnect();
      stopReconnect();
      if (helpRefreshTimerRef.current !== null) {
        clearTimeout(helpRefreshTimerRef.current);
        helpRefreshTimerRef.current = null;
      }
    };
  }, [
    applyCounterSnapshot,
    captureCounterGeneration,
    conversationId,
    currentUser?.id,
    readable,
    realtimeEligible,
    recoverMessages,
    mergeAndStoreMessages,
    scrollToBottom,
    validId,
  ]);

  const deliverMessage = useCallback(
    async (optimistic: ChatDisplayMessage) => {
      setPendingMessages((current) =>
        {
          const next = current.map((message) =>
            message.clientMessageId === optimistic.clientMessageId
              ? { ...message, deliveryState: "sending" as const }
              : message,
          );
          pendingMessagesRef.current = next;
          return next;
        },
      );
      const roomSession = roomSessionGenerationRef.current;
      try {
        const result =
          optimistic.kind === "announcement"
            ? await conversationsService.publishAnnouncement(conversationId, {
                clientMessageId: optimistic.clientMessageId,
                content: optimistic.content ?? "",
              })
            : await conversationsService.send(conversationId, {
                clientMessageId: optimistic.clientMessageId,
                content: optimistic.content,
                ...(optimistic.safeLink
                  ? {
                      safeLink: {
                        url: optimistic.safeLink.url,
                        label: optimistic.safeLink.label,
                      },
                    }
                  : {}),
              });
        if (
          !mountedRef.current ||
          roomSession !== roomSessionGenerationRef.current
        ) {
          return;
        }
        const previousVerifiedSequence = verifiedSequenceRef.current;
        const nextVerifiedSequence = mergeAndStoreMessages([result.message]);
        setPendingMessages((current) => {
          const next = current.filter(
            (message) =>
              message.clientMessageId !== optimistic.clientMessageId,
          );
          pendingMessagesRef.current = next;
          return next;
        });
        setSentClientMessageIds((current) => {
          const next = new Set(current);
          next.add(result.message.clientMessageId);
          return next;
        });
        confirmedClientMessageIdsRef.current.add(
          result.message.clientMessageId,
        );
        setActionError(null);
        const applySentMessage = (current: ConversationDTO) =>
          result.message.sequence < current.lastSequence
            ? current
            : {
                ...current,
                lastSequence: result.message.sequence,
                lastMessage: {
                  id: result.message.id,
                  sequence: result.message.sequence,
                  kind: result.message.kind,
                  sender: result.message.sender,
                  contentPreview: previewContent(result.message.content),
                  safeLink: result.message.safeLink,
                  createdAt: result.message.createdAt,
                },
                updatedAt: result.message.createdAt,
              };
        if (conversationRef.current) {
          conversationRef.current = applySentMessage(conversationRef.current);
        }
        setConversation((current) =>
          current ? applySentMessage(current) : current,
        );
        requestAnimationFrame(() => scrollToBottom("smooth"));
        if (
          result.message.sequence > previousVerifiedSequence + 1 &&
          nextVerifiedSequence < result.message.sequence
        ) {
          void recoverMessages();
        }
      } catch (reason) {
        if (
          !mountedRef.current ||
          roomSession !== roomSessionGenerationRef.current
        ) {
          return;
        }
        if (
          confirmedClientMessageIdsRef.current.has(
            optimistic.clientMessageId,
          )
        ) {
          setActionError(null);
          return;
        }
        setPendingMessages((current) => {
          const next = current.map((message) =>
            message.clientMessageId === optimistic.clientMessageId
              ? { ...message, deliveryState: "failed" as const }
              : message,
          );
          pendingMessagesRef.current = next;
          return next;
        });
        setActionError(
          reason instanceof Error ? reason.message : "Unable to send message.",
        );
      }
    },
    [conversationId, mergeAndStoreMessages, recoverMessages, scrollToBottom],
  );

  const handleSend = (value: ChatComposerValue) => {
    if (!effectiveCanSend || !conversation || !currentUser) return;
    const clientMessageId = createIdempotencyKey();
    const sequence =
      Math.max(
        conversation.lastSequence,
        messagesRef.current.at(-1)?.sequence ?? 0,
      ) +
      pendingMessages.length +
      1;
    const optimistic: ChatDisplayMessage = {
      id: `pending-${clientMessageId}`,
      conversationId,
      sequence,
      kind: "text",
      sender: {
        id: currentUser.id,
        displayName:
          `${currentUser.firstName ?? ""} ${currentUser.lastName ?? ""}`.trim() ||
          currentUser.username,
        avatar: currentUser.avatar ?? null,
      },
      content: value.content,
      safeLink: value.safeLink
        ? {
            url: value.safeLink.url,
            label: value.safeLink.label?.trim() || value.safeLink.url,
          }
        : null,
      clientMessageId,
      createdAt: new Date().toISOString(),
      deliveryState: "sending",
    };
    setActionError(null);
    setPendingMessages((current) => {
      const next = [...current, optimistic];
      pendingMessagesRef.current = next;
      return next;
    });
    requestAnimationFrame(() => scrollToBottom("smooth"));
    void deliverMessage(optimistic);
  };

  const handleAnnouncement = (content: string) => {
    if (!effectiveCanAnnounce || !conversation || !currentUser) return;
    const clientMessageId = createIdempotencyKey();
    const sequence =
      Math.max(
        conversation.lastSequence,
        messagesRef.current.at(-1)?.sequence ?? 0,
      ) +
      pendingMessages.length +
      1;
    const optimistic: ChatDisplayMessage = {
      id: `pending-${clientMessageId}`,
      conversationId,
      sequence,
      kind: "announcement",
      sender: {
        id: currentUser.id,
        displayName:
          `${currentUser.firstName ?? ""} ${currentUser.lastName ?? ""}`.trim() ||
          currentUser.username,
        avatar: currentUser.avatar ?? null,
      },
      content,
      safeLink: null,
      clientMessageId,
      createdAt: new Date().toISOString(),
      deliveryState: "sending",
    };
    setActionError(null);
    setPendingMessages((current) => {
      const next = [...current, optimistic];
      pendingMessagesRef.current = next;
      return next;
    });
    requestAnimationFrame(() => scrollToBottom("smooth"));
    void deliverMessage(optimistic);
  };

  const loadOlder = async () => {
    const oldestSequence = messagesRef.current[0]?.sequence;
    if (!oldestSequence || loadingOlder) return;
    const container = scrollRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    setLoadingOlder(true);
    setActionError(null);
    const roomSession = roomSessionGenerationRef.current;
    try {
      const history = await conversationsService.history(conversationId, {
        beforeSequence: oldestSequence,
        limit: CHAT_HISTORY_DEFAULT_PAGE_SIZE,
      });
      if (
        !mountedRef.current ||
        roomSession !== roomSessionGenerationRef.current ||
        history.conversationId !== conversationId
      ) {
        return;
      }
      mergeAndStoreMessages(history.messages);
      setHasOlder(historyHasOlder(history));
      requestAnimationFrame(() => {
        if (container) container.scrollTop += container.scrollHeight - previousHeight;
      });
    } catch (reason) {
      if (roomSession === roomSessionGenerationRef.current) {
        setActionError(
          reason instanceof Error
            ? reason.message
            : "Unable to load older messages.",
        );
      }
    } finally {
      if (
        mountedRef.current &&
        roomSession === roomSessionGenerationRef.current
      ) {
        setLoadingOlder(false);
      }
    }
  };

  const toggleMute = async () => {
    if (!conversation || muteBusy || !writable) return;
    const nextMuted = !conversation.viewer.muted;
    setMuteBusy(true);
    setActionError(null);
    const roomSession = roomSessionGenerationRef.current;
    try {
      const result = await conversationsService.setMuted(
        conversationId,
        nextMuted,
      );
      if (
        !mountedRef.current ||
        roomSession !== roomSessionGenerationRef.current ||
        result.conversationId !== conversationId
      ) {
        return;
      }
      setConversation((current) =>
        current
          ? {
              ...current,
              viewer: { ...current.viewer, muted: result.muted },
            }
          : current,
      );
    } catch (reason) {
      if (roomSession === roomSessionGenerationRef.current) {
        setActionError(
          reason instanceof Error
            ? reason.message
            : "Unable to update Room notifications.",
        );
      }
    } finally {
      if (
        mountedRef.current &&
        roomSession === roomSessionGenerationRef.current
      ) {
        setMuteBusy(false);
      }
    }
  };

  const displayMessages = useMemo(
    () =>
      [
        ...messages.map((message) =>
          sentClientMessageIds.has(message.clientMessageId) &&
          message.sender.id === currentUser?.id
            ? ({ ...message, deliveryState: "sent" } as ChatDisplayMessage)
            : message,
        ),
        ...pendingMessages,
      ].sort(
        (first, second) =>
          first.sequence - second.sequence ||
          first.createdAt.localeCompare(second.createdAt),
      ),
    [currentUser?.id, messages, pendingMessages, sentClientMessageIds],
  );
  const anySending = pendingMessages.some(
    (message) => message.deliveryState === "sending",
  );

  if (runtimeStatus === "loading") {
    return <LoadingState message="Loading Chat Room..." />;
  }
  if (!readable) {
    return (
      <ErrorState
        message="Chat Rooms are temporarily unavailable."
        title="Chat Room unavailable"
      />
    );
  }
  if (!validId) {
    return (
      <ErrorState
        action={
          <Link className="font-medium text-blue-700" to="/dashboard/chat-rooms">
            Return to Chat Rooms
          </Link>
        }
        message="This Chat Room is not available."
        title="Room not found"
      />
    );
  }
  if (loading && !conversation) {
    return <LoadingState message="Loading Chat Room..." />;
  }
  if (error || !currentUser) {
    return (
      <ErrorState
        action={
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <Button onClick={() => setReloadSequence((value) => value + 1)} type="button">
              Try Again
            </Button>
            <Link className="font-medium text-blue-700" to="/dashboard/chat-rooms">
              Back to Chat Rooms
            </Link>
          </div>
        }
        message={error ?? "This Chat Room is not available."}
        title="Unable to load Chat Room"
      />
    );
  }
  if (loadedRoomKey !== roomKey) {
    return <LoadingState message="Loading Chat Room..." />;
  }
  if (!conversation) {
    return (
      <ErrorState
        action={
          <Link className="font-medium text-blue-700" to="/dashboard/chat-rooms">
            Back to Chat Rooms
          </Link>
        }
        message="This Chat Room is not available."
        title="Unable to load Chat Room"
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 lg:mb-4"
        to="/dashboard/chat-rooms"
      >
        <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
        Chat Rooms
      </Link>
      <section className="flex h-[calc(100dvh-10rem)] min-h-[32rem] max-h-[58rem] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <header className="flex items-center gap-3 border-b border-gray-200 px-3 py-3 sm:px-5">
          {conversation.counterpart && (
            <ChatAvatar
              avatar={conversation.counterpart.avatar}
              displayName={conversation.counterpart.displayName}
            />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-gray-900 sm:text-xl">
              {conversation.title}
            </h1>
            <p className="text-xs text-gray-600">
              {conversation.kind === "alumni_help" ? "Alumni Help Room" : "Program Room"}
              {` · ${conversation.section === "current" ? "Current" : "Past"}`}
              {` · ${
                conversation.viewer.accessMode === "read_write"
                  ? "Read/write"
                  : "Read-only"
              }`}
            </p>
          </div>
          <button
            aria-label={
              conversation.viewer.muted
                ? "Unmute Room notifications"
                : "Mute Room notifications"
            }
            aria-pressed={conversation.viewer.muted}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
            disabled={muteBusy || !writable}
            onClick={() => void toggleMute()}
            type="button"
          >
            {conversation.viewer.muted ? (
              <BellSlashIcon aria-hidden="true" className="h-5 w-5" />
            ) : (
              <BellIcon aria-hidden="true" className="h-5 w-5" />
            )}
          </button>
        </header>
        <ConnectionStatus
          connected={!realtimeEligible || connected}
          degraded={realtimeEligible && liveDegraded}
          limited={realtimeEligible && connectionLimited}
        />
        {actionError && (
          <div
            className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800"
            role="alert"
          >
            {actionError}
          </div>
        )}
        <div
          className="relative min-h-0 flex-1 overflow-y-auto bg-gray-50"
          onScroll={(event) => {
            const element = event.currentTarget;
            const atBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            atBottomRef.current = atBottom;
            if (atBottom) {
              setNewMessageAvailable(false);
              const latest = verifiedSequenceRef.current;
              if (latest > 0) void advanceRead(latest);
            }
          }}
          ref={scrollRef}
        >
          <ChatMessageList
            currentUserId={currentUser.id}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            messages={displayMessages}
            onLoadOlder={() => void loadOlder()}
            onRetry={(message) => {
              setActionError(null);
              void deliverMessage(message);
            }}
          />
          {newMessageAvailable && (
            <button
              className="sticky bottom-3 left-1/2 min-h-11 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              onClick={() => {
                scrollToBottom("smooth");
                const latest = verifiedSequenceRef.current;
                if (latest > 0) void advanceRead(latest);
              }}
              type="button"
            >
              New messages
            </button>
          )}
        </div>
        {effectiveCanAnnounce && (
          <AnnouncementComposer
            onPublish={handleAnnouncement}
            sending={anySending}
          />
        )}
        {effectiveCanSend ? (
          <ChatComposer onSend={handleSend} sending={anySending} />
        ) : (
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-4 text-center text-sm text-gray-700" role="status">
            This Room is read-only. You can review its available history.
          </div>
        )}
      </section>
    </div>
  );
}

export {
  advanceThroughBufferedSequence,
  historyHasOlder,
  initialVerifiedSequence,
  mergeCanonicalMessages,
  previewContent,
};
