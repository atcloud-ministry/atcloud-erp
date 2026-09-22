import { io, type Socket } from "socket.io-client";
import type {
  EventUpdate,
  ConnectedPayload,
  AuthExpiredPayload,
  ConnectionLimitPayload,
  SocketRoomAck,
  SocketRoomErrorCode,
  ConversationRoomAck,
  ConversationRoomErrorCode,
} from "../types/realtime";
import { resolveSocketURL } from "../config/apiUrl";

const DEFAULT_SOCKET_URL = resolveSocketURL(
  import.meta.env.VITE_API_URL,
  import.meta.env.VITE_SOCKET_URL,
);
const ROOM_JOIN_TIMEOUT_MS = 10_000;

export interface UserUpdateData {
  userId: string;
  type: "role_changed" | "status_changed" | "deleted" | "profile_edited";
  user: {
    id: string;
    role?: string;
    avatar?: string;
    phone?: string;
    isAtCloudLeader?: boolean;
    roleInAtCloud?: string;
    isActive?: boolean;
  };
  changes?: Record<string, boolean>;
  timestamp?: string;
}

export interface SocketEventHandlers {
  event_update: (data: EventUpdate) => void;
  connected: (data: ConnectedPayload) => void;
  auth_expired: (data: AuthExpiredPayload) => void;
  connection_limit: (data: ConnectionLimitPayload) => void;
  user_update: (data: UserUpdateData) => void;
  connect: () => void;
  disconnect: (reason: string) => void;
}

export class SocketRoomJoinError extends Error {
  readonly eventId: string;
  readonly code: SocketRoomErrorCode;

  constructor(
    eventId: string,
    code: SocketRoomErrorCode,
  ) {
    super(`Unable to join event room (${code})`);
    this.name = "SocketRoomJoinError";
    this.eventId = eventId;
    this.code = code;
  }
}

export class ConversationRoomJoinError extends Error {
  readonly conversationId: string;
  readonly code: ConversationRoomErrorCode;

  constructor(conversationId: string, code: ConversationRoomErrorCode) {
    super(`Unable to join conversation room (${code})`);
    this.name = "ConversationRoomJoinError";
    this.conversationId = conversationId;
    this.code = code;
  }
}

type StoredSocketHandler = (data: never) => void;

export function decodeConnectionLimitPayload(
  value: unknown,
): ConnectionLimitPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid connection_limit payload");
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 2 ||
    !("limit" in payload) ||
    !("disconnectedAt" in payload) ||
    !Number.isSafeInteger(payload.limit) ||
    (payload.limit as number) < 1 ||
    typeof payload.disconnectedAt !== "string" ||
    Number.isNaN(Date.parse(payload.disconnectedAt)) ||
    new Date(payload.disconnectedAt).toISOString() !== payload.disconnectedAt
  ) {
    throw new TypeError("Invalid connection_limit payload");
  }
  return {
    limit: payload.limit as number,
    disconnectedAt: payload.disconnectedAt,
  };
}

/**
 * Owns the browser's single authenticated Socket.IO connection.
 *
 * Components subscribe through this service (or `useSocket`) instead of
 * creating sockets themselves. Subscriptions survive a token-driven socket
 * replacement, while rooms and the connection are reference counted so one
 * consumer cannot tear down another consumer's realtime state.
 */
export class SocketServiceFrontend {
  private socketInstance: Socket | null = null;
  private currentToken: string | null = null;
  private currentUrl: string | null = null;
  private isConnecting = false;
  private connectionLimited = false;
  private consumerCount = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventHandlers = new Map<
    string,
    Set<StoredSocketHandler>
  >();
  private readonly socketDispatchers = new Map<
    string,
    (data: unknown) => void
  >();
  private readonly roomSubscribers = new Map<string, number>();
  private readonly joinedRooms = new Set<string>();
  private readonly roomJoinRequests = new Map<
    string,
    { promise: Promise<void>; cancel: () => void }
  >();
  private readonly conversationRoomSubscribers = new Map<string, number>();
  private readonly joinedConversationRooms = new Set<string>();
  private readonly conversationRoomJoinRequests = new Map<
    string,
    { promise: Promise<void>; cancel: () => void }
  >();

  /** Create or reuse the shared connection without claiming ownership. */
  connect(token: string, url = DEFAULT_SOCKET_URL): Socket {
    const canReuse =
      this.socketInstance &&
      this.currentToken === token &&
      this.currentUrl === url;

    if (canReuse && this.socketInstance) {
      if (
        !this.connectionLimited &&
        !this.socketInstance.connected &&
        !this.socketInstance.active
      ) {
        this.isConnecting = true;
        this.socketInstance.connect();
      }
      return this.socketInstance;
    }

    this.destroySocket();
    this.currentToken = token;
    this.currentUrl = url;
    this.isConnecting = true;
    this.connectionLimited = false;

    const socket = io(url, {
      auth: { token },
      transports: ["websocket", "polling"],
      withCredentials: true,
      timeout: 20000,
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    this.socketInstance = socket;
    this.attachCoreListeners(socket);
    this.eventHandlers.forEach((_handlers, event) => {
      this.attachDispatcher(event);
    });

    return socket;
  }

  /** Replace an existing socket after HTTP refreshes its access token. */
  updateAuthenticationToken(token: string | null): void {
    if (!token) {
      if (this.socketInstance) this.disconnect();
      return;
    }
    if (
      this.socketInstance &&
      token !== this.currentToken
    ) {
      this.connect(token, this.currentUrl ?? DEFAULT_SOCKET_URL);
    }
  }

  /**
   * Claim the shared connection for a mounted consumer.
   * The returned cleanup releases that claim and disconnects only after the
   * final consumer is gone. The zero-delay grace period absorbs StrictMode's
   * development-only mount/cleanup/remount cycle.
   */
  acquire(token: string, url = DEFAULT_SOCKET_URL): () => void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    this.consumerCount += 1;
    this.connect(token, url);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.consumerCount = Math.max(0, this.consumerCount - 1);

      if (this.consumerCount === 0) {
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (this.consumerCount === 0) this.disconnect();
        }, 0);
      }
    };
  }

  /** Disconnect the shared socket and clear room ownership. */
  disconnect(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    this.destroySocket();
    this.currentToken = null;
    this.currentUrl = null;
    this.isConnecting = false;
    this.connectionLimited = false;
    this.consumerCount = 0;
    this.roomSubscribers.clear();
    this.joinedRooms.clear();
    this.cancelRoomJoinRequests();
    this.conversationRoomSubscribers.clear();
    this.joinedConversationRooms.clear();
    this.cancelConversationRoomJoinRequests();
  }

  private destroySocket(): void {
    const socket = this.socketInstance;
    if (!socket) return;

    this.joinedRooms.forEach((eventId) => {
      if (socket.connected) socket.emit("leave_event_room", eventId);
    });
    this.joinedConversationRooms.forEach((conversationId) => {
      if (socket.connected) {
        socket.emit("leave_conversation_room", conversationId);
      }
    });

    socket.disconnect();
    socket.removeAllListeners();
    this.socketInstance = null;
    this.socketDispatchers.clear();
    this.joinedRooms.clear();
    this.cancelRoomJoinRequests();
    this.joinedConversationRooms.clear();
    this.cancelConversationRoomJoinRequests();
  }

  private attachCoreListeners(socket: Socket): void {
    let accessTokenExpired = false;

    socket.on("connection_limit", (payload: unknown) => {
      if (socket !== this.socketInstance) return;
      try {
        decodeConnectionLimitPayload(payload);
      } catch {
        return;
      }
      this.connectionLimited = true;
      this.isConnecting = false;
    });

    socket.on("auth_expired", () => {
      if (socket !== this.socketInstance) return;
      accessTokenExpired = true;
      this.isConnecting = false;
    });

    socket.on("connect", () => {
      if (socket !== this.socketInstance) return;
      this.connectionLimited = false;
      this.isConnecting = false;
      this.joinedRooms.clear();

      this.roomSubscribers.forEach((count, eventId) => {
        if (count <= 0) return;
        void this.requestRoomJoin(socket, eventId).catch((error: unknown) => {
          if (import.meta.env.DEV) {
            console.warn("Socket event room join failed:", error);
          }
        });
      });
      this.conversationRoomSubscribers.forEach((count, conversationId) => {
        if (count <= 0) return;
        void this.requestConversationRoomJoin(socket, conversationId).catch(
          (error: unknown) => {
            if (import.meta.env.DEV) {
              console.warn("Socket conversation room join failed:", error);
            }
          },
        );
      });
    });

    socket.on("disconnect", (reason: string) => {
      if (socket !== this.socketInstance) return;
      this.joinedRooms.clear();
      this.cancelRoomJoinRequests();
      this.joinedConversationRooms.clear();
      this.cancelConversationRoomJoinRequests();
      const shouldReauthenticate =
        reason === "io server disconnect" &&
        !accessTokenExpired &&
        !this.connectionLimited &&
        (this.consumerCount > 0 ||
          this.roomSubscribers.size > 0 ||
          this.conversationRoomSubscribers.size > 0);
      this.isConnecting = this.connectionLimited
        ? false
        : socket.active || shouldReauthenticate;
      if (shouldReauthenticate) socket.connect();
    });

    socket.on("connect_error", (error) => {
      if (socket !== this.socketInstance) return;
      this.isConnecting = socket.active;
      if (import.meta.env.DEV) {
        console.error("Socket connection error:", error.message);
      }
    });

    socket.on("auth_error", (error) => {
      if (import.meta.env.DEV) {
        console.error("Socket authentication error:", error);
      }
      if (socket === this.socketInstance) this.disconnect();
    });
  }

  private attachDispatcher(event: string): void {
    const socket = this.socketInstance;
    const handlers = this.eventHandlers.get(event);
    if (!socket || !handlers?.size || this.socketDispatchers.has(event)) return;

    const dispatcher = (data: unknown) => {
      let dispatchedData = data;
      if (event === "connection_limit") {
        try {
          dispatchedData = decodeConnectionLimitPayload(data);
        } catch {
          return;
        }
      }
      Array.from(this.eventHandlers.get(event) ?? []).forEach((handler) => {
        handler(dispatchedData as never);
      });
    };

    this.socketDispatchers.set(event, dispatcher);
    socket.on(event, dispatcher);
  }

  private detachDispatcher(event: string): void {
    const dispatcher = this.socketDispatchers.get(event);
    if (dispatcher && this.socketInstance) {
      this.socketInstance.off(event, dispatcher);
    }
    this.socketDispatchers.delete(event);
  }

  /** Join once for the first consumer and retain the room for later consumers. */
  async joinEventRoom(eventId: string): Promise<void> {
    const currentCount = this.roomSubscribers.get(eventId) ?? 0;
    this.roomSubscribers.set(eventId, currentCount + 1);
    if (this.joinedRooms.has(eventId)) return;

    if (this.socketInstance?.connected) {
      const socket = this.socketInstance;
      try {
        await this.requestRoomJoin(socket, eventId);
      } catch (error) {
        // A connection loss or token-driven socket replacement is transient;
        // retain the mounted consumer's ownership so the connect handler can
        // re-authorize the room. A live-server denial/timeout releases this
        // failed acquisition and lets the caller retry explicitly.
        if (socket === this.socketInstance && socket.connected) {
          const nextCount = (this.roomSubscribers.get(eventId) ?? 1) - 1;
          if (nextCount > 0) this.roomSubscribers.set(eventId, nextCount);
          else this.roomSubscribers.delete(eventId);
        }
        throw error;
      }
    }
  }

  private requestRoomJoin(socket: Socket, eventId: string): Promise<void> {
    const existing = this.roomJoinRequests.get(eventId);
    if (existing) return existing.promise;

    let cancelRequest: () => void = () => undefined;
    const request = new Promise<void>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (code: SocketRoomErrorCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new SocketRoomJoinError(eventId, code));
      };
      const timeout = setTimeout(() => {
        rejectOnce("AUTHORIZATION_FAILED");
      }, ROOM_JOIN_TIMEOUT_MS);
      cancelRequest = () => rejectOnce("AUTHORIZATION_FAILED");

      socket.emit("join_event_room", eventId, (result: SocketRoomAck) => {
        if (settled) {
          // A late successful ACK can arrive after the caller left or the
          // request timed out. Compensate for the server-side join so a room
          // with no browser subscribers never remains attached.
          if (
            result?.ok === true &&
            socket === this.socketInstance &&
            socket.connected
          ) {
            if ((this.roomSubscribers.get(eventId) ?? 0) > 0) {
              this.joinedRooms.add(eventId);
            } else {
              socket.emit("leave_event_room", eventId);
              this.joinedRooms.delete(eventId);
            }
          }
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (socket !== this.socketInstance || !socket.connected) {
          reject(new SocketRoomJoinError(eventId, "AUTHORIZATION_FAILED"));
          return;
        }

        if (result?.ok === true) {
          if ((this.roomSubscribers.get(eventId) ?? 0) <= 0) {
            socket.emit("leave_event_room", eventId);
            this.joinedRooms.delete(eventId);
            resolve();
            return;
          }
          this.joinedRooms.add(eventId);
          resolve();
          return;
        }

        const code = result?.code ?? "AUTHORIZATION_FAILED";
        reject(new SocketRoomJoinError(eventId, code));
      });
    }).finally(() => {
      if (this.roomJoinRequests.get(eventId)?.promise === request) {
        this.roomJoinRequests.delete(eventId);
      }
    });

    this.roomJoinRequests.set(eventId, {
      promise: request,
      cancel: () => cancelRequest(),
    });
    return request;
  }

  private cancelRoomJoinRequests(): void {
    const requests = Array.from(this.roomJoinRequests.values());
    this.roomJoinRequests.clear();
    requests.forEach(({ cancel }) => cancel());
  }

  /** Join a viewer-authorized chat room once for all mounted consumers. */
  async joinConversationRoom(conversationId: string): Promise<void> {
    const currentCount =
      this.conversationRoomSubscribers.get(conversationId) ?? 0;
    this.conversationRoomSubscribers.set(conversationId, currentCount + 1);
    if (this.joinedConversationRooms.has(conversationId)) return;

    if (this.socketInstance?.connected) {
      const socket = this.socketInstance;
      try {
        await this.requestConversationRoomJoin(socket, conversationId);
      } catch (error) {
        if (socket === this.socketInstance && socket.connected) {
          const nextCount =
            (this.conversationRoomSubscribers.get(conversationId) ?? 1) - 1;
          if (nextCount > 0) {
            this.conversationRoomSubscribers.set(conversationId, nextCount);
          } else {
            this.conversationRoomSubscribers.delete(conversationId);
          }
        }
        throw error;
      }
    }
  }

  private requestConversationRoomJoin(
    socket: Socket,
    conversationId: string,
  ): Promise<void> {
    const existing = this.conversationRoomJoinRequests.get(conversationId);
    if (existing) return existing.promise;

    let cancelRequest: () => void = () => undefined;
    const request = new Promise<void>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (code: ConversationRoomErrorCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new ConversationRoomJoinError(conversationId, code));
      };
      const timeout = setTimeout(
        () => rejectOnce("AUTHORIZATION_FAILED"),
        ROOM_JOIN_TIMEOUT_MS,
      );
      cancelRequest = () => rejectOnce("AUTHORIZATION_FAILED");

      socket.emit(
        "join_conversation_room",
        conversationId,
        (result: ConversationRoomAck) => {
          if (settled) {
            if (
              result?.ok === true &&
              socket === this.socketInstance &&
              socket.connected
            ) {
              if (
                (this.conversationRoomSubscribers.get(conversationId) ?? 0) >
                0
              ) {
                this.joinedConversationRooms.add(conversationId);
              } else {
                socket.emit("leave_conversation_room", conversationId);
                this.joinedConversationRooms.delete(conversationId);
              }
            }
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (socket !== this.socketInstance || !socket.connected) {
            reject(
              new ConversationRoomJoinError(
                conversationId,
                "AUTHORIZATION_FAILED",
              ),
            );
            return;
          }
          if (result?.ok === true) {
            if (
              (this.conversationRoomSubscribers.get(conversationId) ?? 0) <= 0
            ) {
              socket.emit("leave_conversation_room", conversationId);
              this.joinedConversationRooms.delete(conversationId);
              resolve();
              return;
            }
            this.joinedConversationRooms.add(conversationId);
            resolve();
            return;
          }
          reject(
            new ConversationRoomJoinError(
              conversationId,
              result?.code ?? "AUTHORIZATION_FAILED",
            ),
          );
        },
      );
    }).finally(() => {
      if (
        this.conversationRoomJoinRequests.get(conversationId)?.promise ===
        request
      ) {
        this.conversationRoomJoinRequests.delete(conversationId);
      }
    });

    this.conversationRoomJoinRequests.set(conversationId, {
      promise: request,
      cancel: () => cancelRequest(),
    });
    return request;
  }

  private cancelConversationRoomJoinRequests(): void {
    const requests = Array.from(this.conversationRoomJoinRequests.values());
    this.conversationRoomJoinRequests.clear();
    requests.forEach(({ cancel }) => cancel());
  }

  /** Leave only after the final chat-room consumer releases ownership. */
  leaveConversationRoom(conversationId: string): void {
    const currentCount =
      this.conversationRoomSubscribers.get(conversationId) ?? 0;
    if (currentCount <= 0) return;
    if (currentCount > 1) {
      this.conversationRoomSubscribers.set(conversationId, currentCount - 1);
      return;
    }
    this.conversationRoomSubscribers.delete(conversationId);
    if (
      this.socketInstance?.connected &&
      this.joinedConversationRooms.has(conversationId)
    ) {
      this.socketInstance.emit("leave_conversation_room", conversationId);
    }
    this.joinedConversationRooms.delete(conversationId);
  }

  /** Leave only when the final consumer of this room releases it. */
  leaveEventRoom(eventId: string): void {
    const currentCount = this.roomSubscribers.get(eventId) ?? 0;
    if (currentCount <= 0) return;

    if (currentCount > 1) {
      this.roomSubscribers.set(eventId, currentCount - 1);
      return;
    }

    this.roomSubscribers.delete(eventId);
    if (this.socketInstance?.connected && this.joinedRooms.has(eventId)) {
      this.socketInstance.emit("leave_event_room", eventId);
    }
    this.joinedRooms.delete(eventId);
  }

  on<K extends keyof SocketEventHandlers>(
    event: K,
    handler: SocketEventHandlers[K],
  ): () => void;
  on<T>(event: string, handler: (data: T) => void): () => void;
  on(event: string, handler: StoredSocketHandler): () => void {
    const handlers = this.eventHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(event, handlers);
    this.attachDispatcher(event);
    return () => this.off(event, handler);
  }

  off<K extends keyof SocketEventHandlers>(
    event: K,
    handler?: SocketEventHandlers[K],
  ): void;
  off<T>(event: string, handler?: (data: T) => void): void;
  off(event: string, handler?: StoredSocketHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;

    if (handler) handlers.delete(handler);
    else handlers.clear();

    if (handlers.size === 0) {
      this.eventHandlers.delete(event);
      this.detachDispatcher(event);
    }
  }

  get socket(): Socket | null {
    return this.socketInstance;
  }

  get isConnected(): boolean {
    return this.socketInstance?.connected ?? false;
  }

  get connectionStatus(): {
    connected: boolean;
    connecting: boolean;
    connectionLimited: boolean;
    consumers: number;
    joinedRooms: string[];
    pendingRooms: string[];
    joinedConversationRooms: string[];
    pendingConversationRooms: string[];
  } {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      connectionLimited: this.connectionLimited,
      consumers: this.consumerCount,
      joinedRooms: Array.from(this.joinedRooms),
      pendingRooms: Array.from(this.roomSubscribers.keys()).filter(
        (eventId) => !this.joinedRooms.has(eventId),
      ),
      joinedConversationRooms: Array.from(this.joinedConversationRooms),
      pendingConversationRooms: Array.from(
        this.conversationRoomSubscribers.keys(),
      ).filter(
        (conversationId) =>
          !this.joinedConversationRooms.has(conversationId),
      ),
    };
  }
}

export const socketService = new SocketServiceFrontend();
export type {
  EventUpdate,
  SocketRoomAck,
  SocketRoomErrorCode,
  ConversationRoomAck,
  ConversationRoomErrorCode,
};
