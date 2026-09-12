export type AlumniFlowErrorCode =
  | "ALUMNI_INPUT_INVALID"
  | "ALUMNI_IMPORT_NOT_FOUND"
  | "ALUMNI_IMPORT_RAW_DATA_UNAVAILABLE"
  | "ALUMNI_IMPORT_REVISION_CONFLICT"
  | "ALUMNI_IMPORT_STATE_CONFLICT"
  | "ALUMNI_IMPORT_REVIEW_INCOMPLETE"
  | "ALUMNI_IMPORT_APPLICATION_CONFLICT"
  | "ALUMNI_INVITATION_NOT_FOUND"
  | "ALUMNI_INVITATION_REVISION_CONFLICT"
  | "ALUMNI_INVITATION_UNAVAILABLE"
  | "ALUMNI_PROFILE_NOT_FOUND"
  | "ALUMNI_PROFILE_REVISION_CONFLICT"
  | "ALUMNI_PROFILE_STATE_CONFLICT"
  | "ALUMNI_PROFILE_CONSENT_VERSION_INVALID"
  | "ALUMNI_PROFILE_NOT_PUBLISHABLE"
  | "ALUMNI_COMMIT_UNCERTAIN"
  | "ALUMNI_OPERATION_UNAVAILABLE";

export interface AlumniProfileReadinessIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class AlumniFlowError extends Error {
  readonly name = "AlumniFlowError";

  constructor(
    public readonly code: AlumniFlowErrorCode,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export function isAlumniFlowError(error: unknown): error is AlumniFlowError {
  return error instanceof AlumniFlowError;
}

export function alumniInputError(message = "A valid alumni request is required.") {
  return new AlumniFlowError("ALUMNI_INPUT_INVALID", 400, message);
}

export function alumniInvitationUnavailable(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_INVITATION_UNAVAILABLE",
    404,
    "The alumni invitation is unavailable.",
  );
}

export class AlumniProfileNotPublishableError extends AlumniFlowError {
  constructor(public readonly issues: readonly AlumniProfileReadinessIssue[]) {
    super(
      "ALUMNI_PROFILE_NOT_PUBLISHABLE",
      422,
      "The alumni profile is not ready to publish.",
    );
  }
}
