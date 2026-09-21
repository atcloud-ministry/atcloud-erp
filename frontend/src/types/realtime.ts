// Realtime payload types (frontend copy)

export type EventUpdateType =
  | "user_removed"
  | "user_moved"
  | "user_signed_up"
  | "user_cancelled"
  | "role_full"
  | "role_available"
  | "workshop_topic_updated"
  | "attendance_updated"
  | "user_assigned"
  | "guest_registration"
  | "guest_cancellation"
  | "guest_declined"
  | "guest_updated"
  | "guest_moved"
  | "role_rejected"; // user declined an assigned role (new realtime event)

/**
 * Event socket messages are invalidation notifications only. Event details
 * must be fetched through the viewer-authorized HTTP endpoint.
 */
export interface EventUpdate {
  eventId: string;
  updateType: EventUpdateType;
  data: null;
  timestamp: string;
}

export type EventRoomUpdate = EventUpdate;

export interface SystemMessageUpdate<T = unknown> {
  event: string;
  data: T;
  timestamp: string;
}

export interface BellNotificationUpdate<T = unknown> {
  event: string;
  data: T;
  timestamp: string;
}

export interface UnreadCountUpdate {
  counts: {
    bellNotifications: number;
    systemMessages: number;
    total: number;
  };
  timestamp: string;
}

export interface AlumniHelpUpdate {
  requestId: string;
  requestRevision: number;
  helpActionRequiredCount: number;
  helpNotificationCount?: number;
  /**
   * Present only on the delivery that establishes a private Alumni Help room.
   * It contains no participant or message data, and is scoped to the two
   * already-authorized participants by the server.
   */
  roomCreated?: {
    conversationId: string;
  };
  /**
   * Present only when a Help Request has just closed and the participants'
   * existing private room entered its seven-day write grace period.
   */
  roomGraceStarted?: {
    conversationId: string;
    writeAccessEndsAt: string;
  };
  timestamp: string;
}

export interface ChatParticipantDTO {
  id: string;
  displayName: string;
  avatar: string | null;
}

export interface ChatSafeLinkDTO {
  url: string;
  label: string;
}

export interface RealtimeChatMessageDTO {
  id: string;
  conversationId: string;
  sequence: number;
  kind: "text" | "announcement";
  sender: ChatParticipantDTO;
  content: string | null;
  safeLink: ChatSafeLinkDTO | null;
  clientMessageId: string;
  createdAt: string;
}

export interface ChatMessageUpdate {
  message: RealtimeChatMessageDTO;
  timestamp: string;
}

export interface ChatUnreadUpdate {
  conversationId: string;
  roomUnreadCount: number;
  chatUnreadTotal: number;
  lastReadSequence: number;
  timestamp: string;
}

export interface ConnectedPayload {
  message: string;
  userId: string;
}

export interface AuthExpiredPayload {
  expiredAt: string;
}

export interface ConnectionLimitPayload {
  limit: number;
  disconnectedAt: string;
}

export type SocketRoomErrorCode =
  | "INVALID_EVENT_ID"
  | "ACCOUNT_UNAVAILABLE"
  | "EVENT_NOT_FOUND"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "REQUEST_IN_PROGRESS";

export type SocketRoomAck =
  | { ok: true; eventId: string }
  | { ok: false; code: SocketRoomErrorCode };

export type ConversationRoomErrorCode =
  | "INVALID_CONVERSATION_ID"
  | "ACCOUNT_UNAVAILABLE"
  | "CONVERSATION_NOT_FOUND"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "REQUEST_IN_PROGRESS";

export type ConversationRoomAck =
  | { ok: true; conversationId: string }
  | { ok: false; code: ConversationRoomErrorCode };

export type ServerToClientEvents = {
  connected: (payload: ConnectedPayload) => void;
  auth_expired: (payload: AuthExpiredPayload) => void;
  connection_limit: (payload: ConnectionLimitPayload) => void;
  event_update: (payload: EventUpdate) => void;
  event_room_update: (payload: EventRoomUpdate) => void;
  system_message_update: (payload: SystemMessageUpdate) => void;
  bell_notification_update: (payload: BellNotificationUpdate) => void;
  unread_count_update: (payload: UnreadCountUpdate) => void;
  alumni_help_update: (payload: AlumniHelpUpdate) => void;
  chat_message: (payload: ChatMessageUpdate) => void;
  chat_unread_update: (payload: ChatUnreadUpdate) => void;
};

export type ClientToServerEvents = {
  join_event_room: (eventId: string, ack: (result: SocketRoomAck) => void) => void;
  leave_event_room: (
    eventId: string,
    ack?: (result: SocketRoomAck) => void,
  ) => void;
  join_conversation_room: (
    conversationId: string,
    ack: (result: ConversationRoomAck) => void,
  ) => void;
  leave_conversation_room: (
    conversationId: string,
    ack?: (result: ConversationRoomAck) => void,
  ) => void;
};
