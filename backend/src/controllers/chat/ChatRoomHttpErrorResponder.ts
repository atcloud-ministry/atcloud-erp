import type { Response } from "express";
import {
  ChatRoomFlowValidationError,
  ChatRoomPayloadTooLargeError,
} from "../../contracts/chatRoomFlow";
import {
  IdempotencyInProgressError,
  IdempotencyKeyConflictError,
  IdempotencyPayloadTooLargeError,
  IdempotencyPersistenceError,
  IdempotencyValidationError,
} from "../../services/reliability/IdempotencyService";
import {
  MongoTransactionCommitUncertainError,
  MongoTransactionRetryExhaustedError,
  MongoTransactionUnavailableError,
} from "../../services/reliability/MongoTransactionService";
import { isChatRoomError } from "../../services/chat/ChatRoomErrors";

function respond(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ success: false, code, message });
}

export function sendChatRoomHttpError(res: Response, error: unknown): void {
  if (error instanceof ChatRoomPayloadTooLargeError) {
    respond(
      res,
      413,
      error.code,
      "The chat message payload exceeds 16 KiB.",
    );
    return;
  }
  if (error instanceof ChatRoomFlowValidationError) {
    respond(res, 400, error.code, "A valid chat room request is required.");
    return;
  }
  if (isChatRoomError(error)) {
    if (error.httpStatus === 429 && error.retryAfterSeconds) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    respond(res, error.httpStatus, error.code, error.message);
    return;
  }
  if (error instanceof IdempotencyPayloadTooLargeError) {
    respond(res, 413, error.code, "The chat request payload is too large.");
    return;
  }
  if (error instanceof IdempotencyValidationError) {
    respond(res, 400, error.code, "A valid Idempotency-Key is required.");
    return;
  }
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof IdempotencyInProgressError
  ) {
    respond(
      res,
      409,
      error.code,
      "The Idempotency-Key conflicts with an existing chat operation.",
    );
    return;
  }
  if (error instanceof MongoTransactionCommitUncertainError) {
    respond(
      res,
      503,
      "CHAT_COMMIT_UNCERTAIN",
      "The write result is uncertain. Retry with the same identifiers.",
    );
    return;
  }
  if (
    error instanceof MongoTransactionUnavailableError ||
    error instanceof MongoTransactionRetryExhaustedError ||
    error instanceof IdempotencyPersistenceError
  ) {
    respond(
      res,
      503,
      "CHAT_OPERATION_UNAVAILABLE",
      "The chat operation is temporarily unavailable.",
    );
    return;
  }
  respond(
    res,
    503,
    "CHAT_OPERATION_UNAVAILABLE",
    "The chat operation is temporarily unavailable.",
  );
}
