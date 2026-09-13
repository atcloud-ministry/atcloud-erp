export type ChatRoomErrorCode =
  | "CHAT_ROOM_NOT_FOUND"
  | "CHAT_ROOM_READ_ONLY"
  | "CHAT_MESSAGE_IDEMPOTENCY_CONFLICT"
  | "CHAT_MESSAGE_SEQUENCE_CONFLICT"
  | "CHAT_READ_SEQUENCE_INVALID"
  | "CHAT_SEND_RATE_LIMITED"
  | "CHAT_ANNOUNCEMENT_FORBIDDEN"
  | "CHAT_ANNOUNCEMENT_RATE_LIMITED"
  | "CHAT_OPERATION_UNAVAILABLE";

export class ChatRoomError extends Error {
  readonly name = "ChatRoomError";

  constructor(
    public readonly code: ChatRoomErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function chatRoomNotFound(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_ROOM_NOT_FOUND",
    404,
    "The chat room was not found.",
  );
}

export function chatRoomReadOnly(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_ROOM_READ_ONLY",
    409,
    "The chat room is read-only.",
  );
}

export function chatMessageIdempotencyConflict(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_MESSAGE_IDEMPOTENCY_CONFLICT",
    409,
    "The client message identifier was already used for different content.",
  );
}

export function chatMessageSequenceConflict(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_MESSAGE_SEQUENCE_CONFLICT",
    409,
    "The chat room changed. Recover its history and try again.",
  );
}

export function chatReadSequenceInvalid(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_READ_SEQUENCE_INVALID",
    409,
    "The requested read position is not available in this chat room.",
  );
}

export function chatSendRateLimited(retryAfterSeconds: number): ChatRoomError {
  return new ChatRoomError(
    "CHAT_SEND_RATE_LIMITED",
    429,
    "Too many chat messages were sent. Please try again shortly.",
    retryAfterSeconds,
  );
}

export function chatAnnouncementForbidden(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_ANNOUNCEMENT_FORBIDDEN",
    403,
    "This Program member cannot publish announcements.",
  );
}

export function chatAnnouncementRateLimited(
  retryAfterSeconds: number,
): ChatRoomError {
  return new ChatRoomError(
    "CHAT_ANNOUNCEMENT_RATE_LIMITED",
    429,
    "Too many Program announcements were published. Please try again later.",
    retryAfterSeconds,
  );
}

export function chatOperationUnavailable(): ChatRoomError {
  return new ChatRoomError(
    "CHAT_OPERATION_UNAVAILABLE",
    503,
    "The chat operation is temporarily unavailable.",
  );
}

export function isChatRoomError(error: unknown): error is ChatRoomError {
  return error instanceof ChatRoomError;
}
