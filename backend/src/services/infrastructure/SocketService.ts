import { Server as SocketIOServer, Socket } from "socket.io";
import { Server as HTTPServer } from "http";
import { Types } from "mongoose";
import { getAllowedFrontendOrigins } from "../../middleware/security";
import { TokenService } from "../../middleware/auth";
import { User } from "../../models";
import { Logger } from "../../services/LoggerService";
import { PERMISSIONS } from "../../utils/roleUtils";
import {
  authorizationService,
  createUserAuthorizationPrincipal,
} from "../authorization/AuthorizationService";
import { AUTHORIZATION_ACTIONS } from "../authorization/types";
import { recordAuthorizationDenial } from "../authorization/AuthorizationAuditService";
import type {
  EventUpdate,
  EventUpdateType,
  SocketRoomAck,
  SystemMessageUpdate,
  BellNotificationUpdate,
  UnreadCountUpdate,
  AlumniHelpUpdate,
  ConnectedPayload,
  AuthExpiredPayload,
} from "@/types/realtime";

export type SocketResourceType = "event" | "program" | "conversation";

interface AuthenticatedSocket extends Socket {
  userId: string;
  authorizationRevision: number;
  tokenExpiresAt: number;
  user: {
    id: string;
    firstName: string;
    lastName: string;
  };
  canManageUsers: boolean;
}

const ADMIN_USERS_ROOM = "permission:manage_users";
const EVENT_JOIN_WINDOW_MS = 60_000;
const MAX_EVENT_JOINS_PER_WINDOW = 20;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const VALID_PRESENCE_STATUSES = new Set(["online", "away", "busy"]);
const VALID_RESOURCE_TYPES = new Set<SocketResourceType>([
  "event",
  "program",
  "conversation",
]);

const normalizeObjectId = (value: unknown): string | null => {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) return null;
  return new Types.ObjectId(value).toString();
};

const buildResourceRoom = (
  resourceType: SocketResourceType,
  resourceId: string,
): string => `${resourceType}:${resourceId}`;

/**
 * Real-time WebSocket service for system messages and notifications
 * Handles instant updates for read status, deletions, and new messages
 */
class SocketService {
  private io: SocketIOServer | null = null;
  private authenticatedSockets = new Map<string, AuthenticatedSocket>();
  private userSockets = new Map<string, Set<string>>(); // userId -> Set of socketIds
  private userAuthorizationRevisions = new Map<string, number>();
  private resourceAuthorizationRevisions = new Map<string, number>();
  private eventJoinGuards = new Map<
    string,
    { attempts: number[]; inFlight: Set<string> }
  >();
  private log = Logger.getInstance().child("SocketService");

  /** Stop accepting realtime work and disconnect clients during deployment. */
  async shutdown(timeoutMs: number = 5_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("Socket shutdown timeout is invalid");
    }

    const io = this.io;
    this.io = null;
    this.authenticatedSockets.clear();
    this.userSockets.clear();
    this.userAuthorizationRevisions.clear();
    this.resourceAuthorizationRevisions.clear();
    this.eventJoinGuards.clear();
    if (!io) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.log.warn("Socket shutdown exceeded its drain deadline");
        finish();
      }, timeoutMs);
      timeout.unref?.();
      io.close(finish);
    });
  }

  /**
   * Initialize the WebSocket server
   */
  initialize(httpServer: HTTPServer): void {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: getAllowedFrontendOrigins(),
        methods: ["GET", "POST"],
        credentials: true,
      },
      path: "/socket.io/",
      allowEIO3: true,
    });

    this.setupSocketHandlers();
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketHandlers(): void {
    if (!this.io) return;

    // Add authentication middleware
    this.io.use(this.authenticateSocket.bind(this));

    // Handle authentication errors at the namespace level
    this.io.engine.on("connection_error", (err) => {
      console.error(
        "Socket.IO engine connection error:",
        err.req,
        err.code,
        err.message,
      );
      this.log.error(
        "Socket.IO engine connection error",
        undefined,
        undefined,
        {
          code: err.code,
          message: err.message,
        },
      );
    });

    this.io.on("connection", (socket: Socket) => {
      const authSocket = socket as AuthenticatedSocket;

      if (
        authSocket.authorizationRevision !==
          this.getUserAuthorizationRevision(authSocket.userId) ||
        !Number.isFinite(authSocket.tokenExpiresAt) ||
        authSocket.tokenExpiresAt <= Date.now()
      ) {
        this.log.warn(
          "Socket authorization changed during authentication",
          undefined,
          {
            socketId: authSocket.id,
            userId: authSocket.userId,
          },
        );
        authSocket.disconnect(true);
        return;
      }

      const tokenExpiryTimer = setTimeout(() => {
        const payload: AuthExpiredPayload = {
          expiredAt: new Date(authSocket.tokenExpiresAt).toISOString(),
        };
        authSocket.emit("auth_expired", payload);
        authSocket.disconnect(true);
      }, Math.min(authSocket.tokenExpiresAt - Date.now(), MAX_TIMER_DELAY_MS));
      tokenExpiryTimer.unref?.();

      // Handle any connection errors
      authSocket.on("error", (error) => {
        console.error("Socket error:", error);
        this.log.error("Socket error", error as Error);
      }); // Track authenticated socket
      this.authenticatedSockets.set(authSocket.id, authSocket);

      // Track user sockets
      if (!this.userSockets.has(authSocket.userId)) {
        this.userSockets.set(authSocket.userId, new Set());
      }
      this.userSockets.get(authSocket.userId)!.add(authSocket.id);

      // Join user-specific room
      authSocket.join(`user:${authSocket.userId}`);
      if (authSocket.canManageUsers) {
        authSocket.join(ADMIN_USERS_ROOM);
      }

      // Structured log for connection
      this.log.info("Socket connected", undefined, {
        socketId: authSocket.id,
        userId: authSocket.userId,
      });

      // Handle disconnection
      authSocket.on("disconnect", () => {
        clearTimeout(tokenExpiryTimer);
        this.authenticatedSockets.delete(authSocket.id);
        this.eventJoinGuards.delete(authSocket.id);

        const userSocketSet = this.userSockets.get(authSocket.userId);
        if (userSocketSet) {
          userSocketSet.delete(authSocket.id);
          if (userSocketSet.size === 0) {
            this.userSockets.delete(authSocket.userId);
          }
        }

        // Structured log for disconnection
        this.log.info("Socket disconnected", undefined, {
          socketId: authSocket.id,
          userId: authSocket.userId,
        });
      });

      // Handle status updates
      authSocket.on("update_status", (status: unknown) => {
        if (
          typeof status !== "string" ||
          !VALID_PRESENCE_STATUSES.has(status)
        ) {
          return;
        }
        authSocket.broadcast.emit("user_status_update", {
          userId: authSocket.userId,
          status,
          user: {
            id: authSocket.user.id,
            firstName: authSocket.user.firstName,
            lastName: authSocket.user.lastName,
          },
        });
      });

      // Handle event room management
      authSocket.on("join_event_room", (eventId: unknown, ack?: SocketRoomAck) => {
        return this.handleJoinEventRoom(authSocket, eventId, ack).catch(
          (error: unknown) => {
            this.log.error(
              "Unexpected event room join failure",
              error instanceof Error ? error : undefined,
              undefined,
              { socketId: authSocket.id },
            );
            if (typeof ack === "function") {
              ack({ ok: false, code: "AUTHORIZATION_FAILED" });
            }
          },
        );
      });

      authSocket.on("leave_event_room", (eventId: unknown, ack?: SocketRoomAck) => {
        this.handleLeaveEventRoom(authSocket, eventId, ack);
      });

      // Send initial connection confirmation
      const payload: ConnectedPayload = {
        message: "Real-time notifications enabled",
        userId: authSocket.userId,
      };
      authSocket.emit("connected", payload);
    });
  }

  /**
   * Authenticate socket connection using JWT token
   */
  private async authenticateSocket(
    socket: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    try {
      const token = (
        socket.handshake?.auth as Record<string, unknown> | undefined
      )?.token as string | undefined;

      if (!token) {
        return next(new Error("Authentication token required"));
      }

      const decoded = TokenService.verifyAccessToken(token);
      const decodedUserId = normalizeObjectId(decoded.userId);
      const tokenExpiresAt =
        typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
          ? decoded.exp * 1000
          : 0;
      if (!decodedUserId || tokenExpiresAt <= Date.now()) {
        return next(new Error("Authentication failed"));
      }
      const authorizationRevision =
        this.getUserAuthorizationRevision(decodedUserId);

      const user = await User.findById(
        decodedUserId,
        "_id firstName lastName role isActive isVerified",
      );

      if (!user || !user.isActive || !user.isVerified) {
        return next(new Error("Invalid, inactive, or unverified user"));
      }

      const principal = createUserAuthorizationPrincipal(user);
      if (!principal || normalizeObjectId(principal.userId) !== decodedUserId) {
        return next(new Error("Authentication failed"));
      }

      const adminRoomDecision = await authorizationService.authorize({
        source: "socket",
        principal,
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.MANAGE_USERS },
      });

      // Attach user info to socket (support both Mongoose _id and id virtual)
      const authSocket = socket as AuthenticatedSocket;
      const userIdStr = principal.userId;
      authSocket.userId = userIdStr;
      authSocket.authorizationRevision = authorizationRevision;
      authSocket.tokenExpiresAt = tokenExpiresAt;
      authSocket.user = {
        id: userIdStr,
        firstName: user.firstName || "",
        lastName: user.lastName || "",
      };
      authSocket.canManageUsers = adminRoomDecision.allowed;

      next();
    } catch (error: unknown) {
      const err = error as Error;
      this.log.error("Socket authentication error", err);
      return next(new Error("Authentication failed"));
    }
  }

  /**
   * Emit system message update to specific user
   */
  emitSystemMessageUpdate<T = unknown>(
    userId: string,
    event: string,
    data: T,
  ): void {
    if (!this.io) {
      return;
    }

    const payload: SystemMessageUpdate<T> = {
      event,
      data,
      timestamp: new Date().toISOString(),
    };

    // Structured log without PII payloads
    this.log.debug("Emitting system_message_update", undefined, {
      userId,
      event,
      hasData: data != null,
    });
    this.io.to(`user:${userId}`).emit("system_message_update", payload);
  }

  /**
   * Emit bell notification update to specific user
   */
  emitBellNotificationUpdate<T = unknown>(
    userId: string,
    event: string,
    data: T,
  ): void {
    if (!this.io) return;

    const payload: BellNotificationUpdate<T> = {
      event,
      data,
      timestamp: new Date().toISOString(),
    };
    this.log.debug("Emitting bell_notification_update", undefined, {
      userId,
      event,
      hasData: data != null,
    });
    this.io.to(`user:${userId}`).emit("bell_notification_update", payload);
  }

  /**
   * Get online users count
   */
  getOnlineUsersCount(): number {
    return this.userSockets.size;
  }

  /**
   * Check if user is online
   */
  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }

  /**
   * Get all online user IDs
   */
  getOnlineUserIds(): string[] {
    return Array.from(this.userSockets.keys());
  }

  /**
   * Emit unread count update to specific user
   */
  emitUnreadCountUpdate(
    userId: string,
    counts: UnreadCountUpdate["counts"],
  ): void {
    if (!this.io) return;

    const payload: UnreadCountUpdate = {
      counts,
      timestamp: new Date().toISOString(),
    };
    this.log.debug("Emitting unread_count_update", undefined, {
      userId,
      countsSummary: Object.keys(counts || {}).reduce(
        (acc, k) => ({ ...acc, [k]: counts[k as keyof typeof counts] }),
        {},
      ),
    });
    this.io.to(`user:${userId}`).emit("unread_count_update", payload);
  }

  /** Emit a recipient-scoped Alumni Help invalidation and absolute badge count. */
  emitAlumniHelpUpdate(
    userId: string,
    update: Omit<AlumniHelpUpdate, "timestamp">,
  ): void {
    if (!this.io) return;
    const normalizedUserId = normalizeObjectId(userId);
    const normalizedRequestId = normalizeObjectId(update.requestId);
    if (
      !normalizedUserId ||
      !normalizedRequestId ||
      !Number.isSafeInteger(update.requestRevision) ||
      update.requestRevision < 0 ||
      !Number.isSafeInteger(update.helpActionRequiredCount) ||
      update.helpActionRequiredCount < 0
    ) {
      this.log.warn("Refused invalid alumni_help_update", undefined, {
        hasValidUserId: Boolean(normalizedUserId),
        hasValidRequestId: Boolean(normalizedRequestId),
      });
      return;
    }

    const payload: AlumniHelpUpdate = {
      requestId: normalizedRequestId,
      requestRevision: update.requestRevision,
      helpActionRequiredCount: update.helpActionRequiredCount,
      timestamp: new Date().toISOString(),
    };
    this.log.debug("Emitting alumni_help_update", undefined, {
      userId: normalizedUserId,
      requestId: normalizedRequestId,
      requestRevision: update.requestRevision,
      helpActionRequiredCount: update.helpActionRequiredCount,
    });
    this.io
      .to(`user:${normalizedUserId}`)
      .emit("alumni_help_update", payload);
  }

  /**
   * Emit event update to all users viewing a specific event
   */
  emitEventUpdate(
    eventId: string,
    updateType: EventUpdateType,
    _data: unknown,
  ): void {
    if (!this.io) return;
    const normalizedEventId = normalizeObjectId(eventId);
    if (!normalizedEventId) return;

    // Contract note: updateType must be one of the union values used by the
    // frontend. The payload is only an invalidation signal; each authorized
    // room member refetches its viewer-specific HTTP DTO.
    const eventUpdateData: EventUpdate = {
      eventId: normalizedEventId,
      updateType,
      data: null,
      timestamp: new Date().toISOString(),
    };

    this.log.info("Emitting event_update", undefined, {
      eventId: normalizedEventId,
      updateType,
      payload: "invalidation-only",
    });

    // Room membership is authorized at join time. Never emit the event id or
    // activity signal outside that scoped room.
    this.io
      .to(buildResourceRoom("event", normalizedEventId))
      .emit("event_update", eventUpdateData);
  }

  /**
   * Emit targeted event room update to users in specific event room
   */
  emitEventRoomUpdate(
    eventId: string,
    updateType: EventUpdateType,
    _data: unknown,
  ): void {
    if (!this.io) return;
    const normalizedEventId = normalizeObjectId(eventId);
    if (!normalizedEventId) return;

    const payload: EventUpdate = {
      eventId: normalizedEventId,
      updateType,
      data: null,
      timestamp: new Date().toISOString(),
    };
    this.log.debug("Emitting event_room_update", undefined, {
      eventId: normalizedEventId,
      updateType,
      payload: "invalidation-only",
    });
    this.io
      .to(buildResourceRoom("event", normalizedEventId))
      .emit("event_room_update", payload);
  }

  /**
   * Emit user update (role change, status change, etc.) to all connected clients
   * This allows the Management page to update in real-time when users are modified
   */
  emitUserUpdate(
    userId: string,
    updateData: {
      type: "role_changed" | "status_changed" | "deleted" | "profile_edited";
      user: {
        id: string;
        username?: string;
        email?: string;
        firstName?: string;
        lastName?: string;
        role?: string;
        avatar?: string;
        phone?: string;
        isAtCloudLeader?: boolean;
        roleInAtCloud?: string;
        isActive?: boolean;
      };
      oldValue?: string;
      newValue?: string;
      changes?: Record<string, boolean>;
    },
  ): void {
    if (!this.io) {
      this.log.warn("Socket.IO not initialized, cannot emit user update");
      return;
    }

    this.log.debug("Emitting user_update", undefined, {
      userId,
      updateType: updateData.type,
    });

    const adminPayload = {
      userId,
      ...updateData,
      timestamp: new Date().toISOString(),
    };

    // Account-management data is restricted to sockets that held MANAGE_USERS
    // when they authenticated. Persisting controllers synchronize changed
    // account authorization before publishing this invalidation.
    this.io.to(ADMIN_USERS_ROOM).emit("user_update", adminPayload);

    const safeChanges = Object.fromEntries(
      Object.entries(updateData.changes || {}).filter(
        ([key, changed]) =>
          changed === true &&
          ["avatar", "roleInAtCloud", "isAtCloudLeader"].includes(key),
      ),
    );
    const safePayload = {
      userId,
      type: updateData.type,
      user: {
        id: userId,
        ...(updateData.user.avatar !== undefined
          ? { avatar: updateData.user.avatar }
          : {}),
      },
      ...(Object.keys(safeChanges).length > 0 ? { changes: safeChanges } : {}),
      timestamp: adminPayload.timestamp,
    };

    // Non-admin community consumers receive only a safe invalidation/avatar DTO.
    this.io.except(ADMIN_USERS_ROOM).emit("user_update", safePayload);
  }

  /**
   * Handle user joining event room for real-time updates
   */
  async handleJoinEventRoom(
    socket: AuthenticatedSocket,
    eventId: unknown,
    ack?: SocketRoomAck,
  ): Promise<void> {
    const acknowledge = typeof ack === "function" ? ack : undefined;
    const normalizedEventId = normalizeObjectId(eventId);
    if (!normalizedEventId) {
      acknowledge?.({ ok: false, code: "INVALID_EVENT_ID" });
      return;
    }
    const authorizationRevision = this.getUserAuthorizationRevision(
      socket.userId,
    );
    const resourceAuthorizationRevision =
      this.getResourceAuthorizationRevision("event", normalizedEventId);

    const guardResult = this.beginEventJoin(socket.id, normalizedEventId);
    if (guardResult) {
      acknowledge?.({ ok: false, code: guardResult });
      return;
    }

    try {
      const freshUser = await User.findById(
        socket.userId,
        "_id role isActive isVerified",
      );

      if (!freshUser || !freshUser.isActive || !freshUser.isVerified) {
        acknowledge?.({ ok: false, code: "ACCOUNT_UNAVAILABLE" });
        socket.disconnect(true);
        return;
      }

      const principal = createUserAuthorizationPrincipal(freshUser);
      if (!principal) {
        acknowledge?.({ ok: false, code: "ACCOUNT_UNAVAILABLE" });
        socket.disconnect(true);
        return;
      }

      const authorizationRequest = {
        source: "socket",
        principal,
        action: AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME,
        resource: { type: "event", id: normalizedEventId },
      } as const;
      const decision = await authorizationService.authorize(
        authorizationRequest,
      );
      if (!decision.allowed) {
        recordAuthorizationDenial(authorizationRequest, decision, socket.id);
        acknowledge?.({
          ok: false,
          code:
            decision.reasonCode === "authorization_error"
              ? "AUTHORIZATION_FAILED"
              : decision.reasonCode === "resource_not_found" ||
                  decision.concealExistence
              ? "EVENT_NOT_FOUND"
              : "AUTHORIZATION_FAILED",
        });
        return;
      }

      if (
        authorizationRevision !==
          this.getUserAuthorizationRevision(socket.userId) ||
        resourceAuthorizationRevision !==
          this.getResourceAuthorizationRevision("event", normalizedEventId) ||
        socket.disconnected
      ) {
        acknowledge?.({ ok: false, code: "AUTHORIZATION_FAILED" });
        return;
      }

      await socket.join(buildResourceRoom("event", normalizedEventId));
      if (
        authorizationRevision !==
          this.getUserAuthorizationRevision(socket.userId) ||
        resourceAuthorizationRevision !==
          this.getResourceAuthorizationRevision("event", normalizedEventId) ||
        socket.disconnected
      ) {
        await socket.leave(buildResourceRoom("event", normalizedEventId));
        acknowledge?.({ ok: false, code: "AUTHORIZATION_FAILED" });
        return;
      }
      this.log.debug("Joined event room", undefined, {
        userId: socket.userId,
        eventId: normalizedEventId,
        socketId: socket.id,
      });
      acknowledge?.({ ok: true, eventId: normalizedEventId });
    } catch (error) {
      this.log.error(
        "Failed to authorize event room subscription",
        error instanceof Error ? error : undefined,
        undefined,
        { userId: socket.userId, eventId: normalizedEventId },
      );
      acknowledge?.({ ok: false, code: "AUTHORIZATION_FAILED" });
    } finally {
      this.finishEventJoin(socket.id, normalizedEventId);
    }
  }

  private beginEventJoin(
    socketId: string,
    eventId: string,
  ): "RATE_LIMITED" | "REQUEST_IN_PROGRESS" | null {
    const now = Date.now();
    const guard = this.eventJoinGuards.get(socketId) ?? {
      attempts: [],
      inFlight: new Set<string>(),
    };
    guard.attempts = guard.attempts.filter(
      (timestamp) => now - timestamp < EVENT_JOIN_WINDOW_MS,
    );

    if (guard.inFlight.has(eventId)) return "REQUEST_IN_PROGRESS";
    if (guard.attempts.length >= MAX_EVENT_JOINS_PER_WINDOW) {
      return "RATE_LIMITED";
    }

    guard.attempts.push(now);
    guard.inFlight.add(eventId);
    this.eventJoinGuards.set(socketId, guard);
    return null;
  }

  private finishEventJoin(socketId: string, eventId: string): void {
    this.eventJoinGuards.get(socketId)?.inFlight.delete(eventId);
  }

  /**
   * Handle user leaving event room
   */
  handleLeaveEventRoom(
    socket: AuthenticatedSocket,
    eventId: unknown,
    ack?: SocketRoomAck,
  ): void {
    const acknowledge = typeof ack === "function" ? ack : undefined;
    const normalizedEventId = normalizeObjectId(eventId);
    if (!normalizedEventId) {
      acknowledge?.({ ok: false, code: "INVALID_EVENT_ID" });
      return;
    }

    socket.leave(buildResourceRoom("event", normalizedEventId));
    this.log.debug("Left event room", undefined, {
      userId: socket.userId,
      eventId: normalizedEventId,
      socketId: socket.id,
    });
    acknowledge?.({ ok: true, eventId: normalizedEventId });
  }

  /** Disconnect all live sockets for a canonical user. */
  disconnectUser(userId: string): boolean {
    const normalizedUserId = normalizeObjectId(userId);
    if (!normalizedUserId) return false;
    this.bumpUserAuthorizationRevision(normalizedUserId);
    if (!this.io) return false;
    this.io.in(`user:${normalizedUserId}`).disconnectSockets(true);
    return true;
  }

  /** Remove all live sockets for a user from a server-defined resource room. */
  ejectUserFromResourceRoom(
    userId: string,
    resourceType: SocketResourceType,
    resourceId: string,
  ): boolean {
    const normalizedUserId = normalizeObjectId(userId);
    const normalizedResourceId = normalizeObjectId(resourceId);
    if (
      !normalizedUserId ||
      !normalizedResourceId ||
      !VALID_RESOURCE_TYPES.has(resourceType)
    ) {
      return false;
    }
    // Invalidate any authorization decision currently awaiting I/O before the
    // room removal. Otherwise a stale allowed join could land after the eject.
    this.bumpUserAuthorizationRevision(normalizedUserId);
    if (!this.io) return false;

    this.io
      .in(`user:${normalizedUserId}`)
      .socketsLeave(buildResourceRoom(resourceType, normalizedResourceId));
    return true;
  }

  /**
   * Invalidate every live authorization decision for a resource. Connected
   * members are forced to reconnect and re-authorize; in-flight joins are
   * rejected by the resource revision checks above.
   */
  invalidateResourceRoom(
    resourceType: SocketResourceType,
    resourceId: string,
  ): boolean {
    const normalizedResourceId = normalizeObjectId(resourceId);
    if (
      !normalizedResourceId ||
      !VALID_RESOURCE_TYPES.has(resourceType)
    ) {
      return false;
    }

    const room = buildResourceRoom(resourceType, normalizedResourceId);
    this.resourceAuthorizationRevisions.set(
      room,
      this.getResourceAuthorizationRevision(
        resourceType,
        normalizedResourceId,
      ) + 1,
    );
    if (!this.io) return false;

    this.io.in(room).disconnectSockets(true);
    return true;
  }

  /** Apply a persisted account/role change to every live socket immediately. */
  syncUserAuthorization(
    userId: string,
    state: { role?: string; isActive?: boolean },
  ): boolean {
    const normalizedUserId = normalizeObjectId(userId);
    if (!normalizedUserId) return false;
    this.bumpUserAuthorizationRevision(normalizedUserId);
    if (!this.io) return false;

    const userRoom = this.io.in(`user:${normalizedUserId}`);
    if (state.isActive === false) {
      userRoom.socketsLeave(ADMIN_USERS_ROOM);
      userRoom.disconnectSockets(true);
      return true;
    }

    if (typeof state.role === "string") {
      // A role change can revoke access to any number of resource rooms.
      // Disconnect all sockets so the client re-authenticates and rejoins only
      // rooms allowed by the freshly persisted role.
      userRoom.disconnectSockets(true);
    }
    return true;
  }

  private getUserAuthorizationRevision(userId: string): number {
    return this.userAuthorizationRevisions.get(userId) ?? 0;
  }

  private bumpUserAuthorizationRevision(userId: string): void {
    this.userAuthorizationRevisions.set(
      userId,
      this.getUserAuthorizationRevision(userId) + 1,
    );
  }

  private getResourceAuthorizationRevision(
    resourceType: SocketResourceType,
    resourceId: string,
  ): number {
    return (
      this.resourceAuthorizationRevisions.get(
        buildResourceRoom(resourceType, resourceId),
      ) ?? 0
    );
  }

}

// Export singleton instance
export const socketService = new SocketService();
