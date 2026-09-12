import type { Response } from "express";
import { AlumniDirectoryQueryValidationError } from "../../contracts/alumniDirectoryFlow";
import { AlumniHelpFlowValidationError } from "../../contracts/alumniHelpFlow";
import { AlumniProfileFlowValidationError } from "../../contracts/alumniProfileFlow";
import { AlumniRosterFlowValidationError } from "../../contracts/alumniRosterFlow";
import { AlumniRosterCsvError } from "../../services/alumni/AlumniRosterCsvParser";
import {
  AlumniProfileNotPublishableError,
  isAlumniFlowError,
  type AlumniProfileReadinessIssue,
} from "../../services/alumni/AlumniFlowErrors";
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
  readonly issues?: readonly AlumniProfileReadinessIssue[];
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
  ALUMNI_PROFILE_NOT_FOUND: {
    code: "ALUMNI_PROFILE_NOT_FOUND",
    message: "The alumni profile was not found.",
  },
  ALUMNI_PROFILE_REVISION_CONFLICT: {
    code: "ALUMNI_PROFILE_REVISION_CONFLICT",
    message: "The alumni profile changed. Refresh it and try again.",
  },
  ALUMNI_PROFILE_STATE_CONFLICT: {
    code: "ALUMNI_PROFILE_STATE_CONFLICT",
    message: "The alumni profile is not in the required state.",
  },
  ALUMNI_PROFILE_CONSENT_VERSION_INVALID: {
    code: "ALUMNI_PROFILE_CONSENT_VERSION_INVALID",
    message: "The publication consent has changed. Refresh it and try again.",
  },
  ALUMNI_PROFILE_NOT_PUBLISHABLE: {
    code: "ALUMNI_PROFILE_NOT_PUBLISHABLE",
    message: "The alumni profile is not ready to publish.",
  },
  ALUMNI_HELP_REQUEST_NOT_FOUND: {
    code: "ALUMNI_HELP_REQUEST_NOT_FOUND",
    message: "The alumni help request was not found.",
  },
  ALUMNI_HELP_REQUEST_DUPLICATE: {
    code: "ALUMNI_HELP_REQUEST_DUPLICATE",
    message: "An active request for this help offering already exists.",
  },
  ALUMNI_HELP_REQUEST_REVISION_CONFLICT: {
    code: "ALUMNI_HELP_REQUEST_REVISION_CONFLICT",
    message: "The help request changed. Refresh it and try again.",
  },
  ALUMNI_HELP_REQUEST_STATE_CONFLICT: {
    code: "ALUMNI_HELP_REQUEST_STATE_CONFLICT",
    message: "The help request is not in the required state.",
  },
  ALUMNI_HELP_OFFERING_UNAVAILABLE: {
    code: "ALUMNI_HELP_OFFERING_UNAVAILABLE",
    message: "That help offering is no longer available.",
  },
  ALUMNI_HELP_TERMS_VERSION_INVALID: {
    code: "ALUMNI_HELP_TERMS_VERSION_INVALID",
    message: "The help request terms changed. Review them and try again.",
  },
  ALUMNI_HELP_OUTCOME_NOT_FOUND: {
    code: "ALUMNI_HELP_OUTCOME_NOT_FOUND",
    message: "The reported outcome was not found.",
  },
  ALUMNI_HELP_OUTCOME_REVISION_CONFLICT: {
    code: "ALUMNI_HELP_OUTCOME_REVISION_CONFLICT",
    message: "The reported outcome changed. Refresh it and try again.",
  },
  ALUMNI_HELP_OUTCOME_STATE_CONFLICT: {
    code: "ALUMNI_HELP_OUTCOME_STATE_CONFLICT",
    message: "The reported outcome is not in the required state.",
  },
  ALUMNI_HELP_OUTCOME_DEADLINE_PASSED: {
    code: "ALUMNI_HELP_OUTCOME_DEADLINE_PASSED",
    message: "The confirmation deadline has passed and is being processed.",
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
    ...(failure.issues ? { issues: failure.issues } : {}),
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
  if (error instanceof AlumniHelpFlowValidationError) {
    respond(res, {
      status: 400,
      code: error.code,
      message: "A valid alumni help request is required.",
    });
    return;
  }
  if (error instanceof AlumniDirectoryQueryValidationError) {
    respond(res, {
      status: 400,
      code: error.code,
      message: "A valid alumni directory query is required.",
    });
    return;
  }
  if (error instanceof AlumniProfileFlowValidationError) {
    respond(res, {
      status: 400,
      code: error.code,
      message: "A valid alumni profile request is required.",
    });
    return;
  }

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
      ...(error instanceof AlumniProfileNotPublishableError
        ? { issues: error.issues }
        : {}),
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
