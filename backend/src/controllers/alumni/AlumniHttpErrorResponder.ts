import type { Response } from "express";
import { AlumniRosterFlowValidationError } from "../../contracts/alumniRosterFlow";
import { AlumniRosterCsvError } from "../../services/alumni/AlumniRosterCsvParser";
import { isAlumniFlowError } from "../../services/alumni/AlumniFlowErrors";
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

interface CsvStructuralContext {
  readonly rowNumber?: number;
  readonly columnNumber?: number;
}

interface PublicFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly context?: CsvStructuralContext;
}

const ALUMNI_FLOW_PUBLIC_FAILURES: Readonly<
  Record<string, Omit<PublicFailure, "status">>
> = Object.freeze({
  ALUMNI_INPUT_INVALID: {
    code: "ALUMNI_INPUT_INVALID",
    message: "A valid alumni request is required.",
  },
  ALUMNI_IMPORT_NOT_FOUND: {
    code: "ALUMNI_IMPORT_NOT_FOUND",
    message: "The alumni import was not found.",
  },
  ALUMNI_IMPORT_RAW_DATA_UNAVAILABLE: {
    code: "ALUMNI_IMPORT_RAW_DATA_UNAVAILABLE",
    message: "The retained roster data is no longer available.",
  },
  ALUMNI_IMPORT_REVISION_CONFLICT: {
    code: "ALUMNI_IMPORT_REVISION_CONFLICT",
    message: "The alumni import changed. Refresh it and try again.",
  },
  ALUMNI_IMPORT_STATE_CONFLICT: {
    code: "ALUMNI_IMPORT_STATE_CONFLICT",
    message: "The alumni import is not in the required state.",
  },
  ALUMNI_IMPORT_REVIEW_INCOMPLETE: {
    code: "ALUMNI_IMPORT_REVIEW_INCOMPLETE",
    message: "Every valid roster row must be reviewed before applying.",
  },
  ALUMNI_IMPORT_APPLICATION_CONFLICT: {
    code: "ALUMNI_IMPORT_APPLICATION_CONFLICT",
    message: "The alumni import conflicts with current account data.",
  },
  ALUMNI_INVITATION_NOT_FOUND: {
    code: "ALUMNI_INVITATION_NOT_FOUND",
    message: "The alumni invitation was not found.",
  },
  ALUMNI_INVITATION_REVISION_CONFLICT: {
    code: "ALUMNI_INVITATION_REVISION_CONFLICT",
    message: "The alumni invitation changed. Refresh it and try again.",
  },
  ALUMNI_INVITATION_UNAVAILABLE: {
    code: "ALUMNI_INVITATION_UNAVAILABLE",
    message: "The alumni invitation is unavailable.",
  },
  ALUMNI_COMMIT_UNCERTAIN: {
    code: "ALUMNI_COMMIT_UNCERTAIN",
    message:
      "The write result is uncertain. Retry with the same Idempotency-Key.",
  },
  ALUMNI_OPERATION_UNAVAILABLE: {
    code: "ALUMNI_OPERATION_UNAVAILABLE",
    message: "The alumni operation is temporarily unavailable.",
  },
});

function respond(res: Response, failure: PublicFailure): void {
  res.status(failure.status).json({
    success: false,
    message: failure.message,
    code: failure.code,
    ...(failure.context ? { context: failure.context } : {}),
  });
}

function csvStructuralContext(error: AlumniRosterCsvError) {
  const context: { rowNumber?: number; columnNumber?: number } = {};
  if (
    Number.isSafeInteger(error.context.rowNumber) &&
    Number(error.context.rowNumber) >= 1
  ) {
    context.rowNumber = Number(error.context.rowNumber);
  }
  if (
    Number.isSafeInteger(error.context.columnNumber) &&
    Number(error.context.columnNumber) >= 1
  ) {
    context.columnNumber = Number(error.context.columnNumber);
  }
  return Object.keys(context).length > 0 ? Object.freeze(context) : undefined;
}

export function sendAlumniHttpError(res: Response, error: unknown): void {
  if (error instanceof AlumniRosterFlowValidationError) {
    respond(res, {
      status: 400,
      code: error.code,
      message: "A valid alumni request is required.",
    });
    return;
  }

  if (error instanceof AlumniRosterCsvError) {
    respond(res, {
      status: error.code === "CSV_TOO_LARGE" ? 413 : 400,
      code: error.code,
      message: "The roster CSV is invalid.",
      context: csvStructuralContext(error),
    });
    return;
  }

  if (isAlumniFlowError(error)) {
    const publicFailure = ALUMNI_FLOW_PUBLIC_FAILURES[error.code];
    respond(res, {
      status:
        Number.isSafeInteger(error.httpStatus) &&
        error.httpStatus >= 400 &&
        error.httpStatus <= 599
          ? error.httpStatus
          : 503,
      code: publicFailure?.code ?? "ALUMNI_OPERATION_UNAVAILABLE",
      message:
        publicFailure?.message ??
        "The alumni operation is temporarily unavailable.",
    });
    return;
  }

  if (
    error instanceof IdempotencyValidationError ||
    error instanceof IdempotencyPayloadTooLargeError
  ) {
    respond(res, {
      status: error instanceof IdempotencyPayloadTooLargeError ? 413 : 400,
      code: error.code,
      message: "A valid idempotent alumni request is required.",
    });
    return;
  }

  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof IdempotencyInProgressError
  ) {
    respond(res, {
      status: 409,
      code: error.code,
      message: "The Idempotency-Key conflicts with an existing operation.",
    });
    return;
  }

  if (error instanceof MongoTransactionCommitUncertainError) {
    respond(res, {
      status: 503,
      code: "ALUMNI_COMMIT_UNCERTAIN",
      message:
        "The write result is uncertain. Retry with the same Idempotency-Key.",
    });
    return;
  }

  if (
    error instanceof MongoTransactionUnavailableError ||
    error instanceof MongoTransactionRetryExhaustedError
  ) {
    respond(res, {
      status: 503,
      code: "ALUMNI_OPERATION_UNAVAILABLE",
      message:
        "The alumni operation is temporarily unavailable. Retry with the same Idempotency-Key.",
    });
    return;
  }

  if (error instanceof IdempotencyPersistenceError) {
    respond(res, {
      status: 503,
      code: error.code,
      message:
        "The request result could not be saved. Retry with the same Idempotency-Key.",
    });
    return;
  }

  respond(res, {
    status: 503,
    code: "ALUMNI_OPERATION_UNAVAILABLE",
    message: "The alumni operation is temporarily unavailable.",
  });
}
