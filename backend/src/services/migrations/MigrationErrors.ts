abstract class MigrationError extends Error {
  abstract readonly code: string;
  abstract readonly exitCode: 1 | 2 | 3;
  declare readonly cause: unknown;

  protected constructor(message: string, cause?: unknown) {
    super(message);
    Object.defineProperty(this, "cause", {
      value: cause,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

export class MigrationUsageError extends MigrationError {
  readonly name = "MigrationUsageError";
  readonly code = "MIGRATION_USAGE_ERROR";
  readonly exitCode = 2 as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class MigrationStateConflictError extends MigrationError {
  readonly name = "MigrationStateConflictError";
  readonly code = "MIGRATION_STATE_CONFLICT";
  readonly exitCode = 3 as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class MigrationExecutionError extends MigrationError {
  readonly name = "MigrationExecutionError";
  readonly code = "MIGRATION_EXECUTION_FAILED";
  readonly exitCode = 1 as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export function migrationErrorExitCode(error: unknown): 1 | 2 | 3 {
  if (error instanceof MigrationError) return error.exitCode;
  return 1;
}
