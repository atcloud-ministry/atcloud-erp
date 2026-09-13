import mongoose from "mongoose";
import type { Response } from "express";
import { ProgramCommunitySettingsValidationError } from "../../contracts/programCommunitySettings";
import { ProgramCommunitySettingsError } from "../../services/programs/ProgramCommunitySettingsService";
import { ProgramRoomProvisioningConflictError } from "../../services/programs/ProgramRoomProvisioner";
import { ProgramPurchaseRolePreflightError } from "../../services/programs/ProgramPurchaseRolePreflightService";
import { CasConflictError } from "../../services/reliability/CasService";
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

function respond(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ success: false, message, code });
}

const SERVICE_MESSAGES = Object.freeze({
  PROGRAM_NOT_FOUND: "Program not found.",
  PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT:
    "The Program community settings changed. Refresh them and try again.",
  PROGRAM_COMMUNITY_ROLE_MAPPING_CONFLICT:
    "The student-role mappings no longer match this Program.",
  PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT:
    "The Program community settings cannot make that transition.",
});

export function sendProgramCommunitySettingsHttpError(
  res: Response,
  error: unknown,
): void {
  if (error instanceof ProgramCommunitySettingsValidationError) {
    respond(
      res,
      400,
      error.code,
      "A valid Program community settings request is required.",
    );
    return;
  }
  if (error instanceof ProgramCommunitySettingsError) {
    respond(res, error.httpStatus, error.code, SERVICE_MESSAGES[error.code]);
    return;
  }
  if (error instanceof ProgramRoomProvisioningConflictError) {
    respond(
      res,
      409,
      error.code,
      "The Program primary Room conflicts with retained Room state.",
    );
    return;
  }
  if (error instanceof ProgramPurchaseRolePreflightError) {
    respond(
      res,
      409,
      error.code,
      "Historical Program purchases must have resolved student roles before the Room can be enabled.",
    );
    return;
  }
  if (error instanceof CasConflictError) {
    respond(
      res,
      409,
      "PROGRAM_COMMUNITY_SETTINGS_REVISION_CONFLICT",
      "The Program community settings changed. Refresh them and try again.",
    );
    return;
  }
  if (
    error instanceof IdempotencyValidationError ||
    error instanceof IdempotencyPayloadTooLargeError
  ) {
    respond(
      res,
      error instanceof IdempotencyPayloadTooLargeError ? 413 : 400,
      error.code,
      "A valid Idempotent Program community request is required.",
    );
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
      "The Idempotency-Key conflicts with an existing operation.",
    );
    return;
  }
  if (error instanceof MongoTransactionCommitUncertainError) {
    respond(
      res,
      503,
      "PROGRAM_COMMUNITY_COMMIT_UNCERTAIN",
      "The write result is uncertain. Retry with the same Idempotency-Key.",
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
      "PROGRAM_COMMUNITY_OPERATION_UNAVAILABLE",
      "The Program community operation is temporarily unavailable. Retry with the same Idempotency-Key.",
    );
    return;
  }
  if (error instanceof mongoose.Error.ValidationError) {
    respond(
      res,
      409,
      "PROGRAM_COMMUNITY_SETTINGS_STATE_CONFLICT",
      "The Program community settings cannot make that transition.",
    );
    return;
  }
  respond(
    res,
    503,
    "PROGRAM_COMMUNITY_OPERATION_UNAVAILABLE",
    "The Program community operation is temporarily unavailable.",
  );
}
