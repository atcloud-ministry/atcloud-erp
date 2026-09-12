// Realtime payload types (backend copy)

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
  | "guest_updated"
  | "guest_moved"
  | "guest_declined"
  | "role_rejected"; // new: role assignment rejection (user declined role)

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
  timestamp: string;
}

export interface ConnectedPayload {
  message: string;
  userId: string;
}

export interface AuthExpiredPayload {
  expiredAt: string;
}

export type SocketRoomErrorCode =
  | "INVALID_EVENT_ID"
  | "ACCOUNT_UNAVAILABLE"
  | "EVENT_NOT_FOUND"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "REQUEST_IN_PROGRESS";

export type SocketRoomAckResult =
  | { ok: true; eventId: string }
  | { ok: false; code: SocketRoomErrorCode };

export type SocketRoomAck = (result: SocketRoomAckResult) => void;

export type ServerToClientEvents = {
  connected: (payload: ConnectedPayload) => void;
  auth_expired: (payload: AuthExpiredPayload) => void;
  event_update: (payload: EventUpdate) => void;
  event_room_update: (payload: EventRoomUpdate) => void;
  system_message_update: (payload: SystemMessageUpdate) => void;
  bell_notification_update: (payload: BellNotificationUpdate) => void;
  unread_count_update: (payload: UnreadCountUpdate) => void;
  alumni_help_update: (payload: AlumniHelpUpdate) => void;
};

export type ClientToServerEvents = {
  join_event_room: (eventId: string, ack: SocketRoomAck) => void;
  leave_event_room: (eventId: string, ack?: SocketRoomAck) => void;
  update_status: (status: "online" | "away" | "busy") => void;
};
