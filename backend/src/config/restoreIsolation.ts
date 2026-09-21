/**
 * Restore/backup tooling must opt in to this isolated operating mode before it
 * connects to a restored database.  The normal web-service process is not a
 * restore environment, even when some individual workers happen to be off.
 */
export const RESTORE_ISOLATION_MODE_ENV = "RESTORE_ISOLATION_MODE" as const;
export const RESTORE_ISOLATION_DATABASE_ENV =
  "RESTORE_ISOLATION_DATABASE" as const;

export const RESTORE_ISOLATION_DISABLED_ENVIRONMENTS = [
  "NOTIFICATION_OUTBOX_ENABLED",
  "SCHEDULER_ENABLED",
  "WEB_PUSH_ENABLED",
  "ALUMNI_NETWORK_RELEASE_AVAILABLE",
] as const;

export type RestoreIsolationDisabledEnvironment =
  (typeof RESTORE_ISOLATION_DISABLED_ENVIRONMENTS)[number];

export interface RestoreIsolationEnvironment {
  readonly RESTORE_ISOLATION_MODE?: string;
  readonly RESTORE_ISOLATION_DATABASE?: string;
  readonly NOTIFICATION_OUTBOX_ENABLED?: string;
  readonly SCHEDULER_ENABLED?: string;
  readonly WEB_PUSH_ENABLED?: string;
  readonly ALUMNI_NETWORK_RELEASE_AVAILABLE?: string;
}

const RESTORE_DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESTORE_DATABASE_MARKER_PATTERN = /(?:^|[_-])restore(?:[_-]|$)/i;

export class RestoreIsolationConfigurationError extends Error {
  readonly name = "RestoreIsolationConfigurationError";
  readonly code = "RESTORE_ISOLATION_CONFIGURATION_INVALID";
  readonly invalidVariables: readonly string[];

  constructor(invalidVariables: readonly string[]) {
    // Values are deliberately excluded: operators only need the configuration
    // names, and a restore preflight must never echo deployment configuration.
    super(
      `Restore isolation requires explicit safe values for: ${invalidVariables.join(", ")}.`,
    );
    this.invalidVariables = Object.freeze([...invalidVariables]);
  }
}

export class RestoreIsolationWebRuntimeError extends Error {
  readonly name = "RestoreIsolationWebRuntimeError";
  readonly code = "RESTORE_ISOLATION_WEB_RUNTIME_FORBIDDEN";

  constructor() {
    super(
      "Restore isolation mode is reserved for the dedicated recovery qualification CLI.",
    );
  }
}

export class RestoreIsolationDatabaseError extends Error {
  readonly name = "RestoreIsolationDatabaseError";
  readonly code = "RESTORE_ISOLATION_DATABASE_INVALID";

  constructor() {
    super(
      "Restore isolation database binding does not match the connected database.",
    );
  }
}

function currentEnvironment(): RestoreIsolationEnvironment {
  return {
    RESTORE_ISOLATION_MODE: process.env.RESTORE_ISOLATION_MODE,
    RESTORE_ISOLATION_DATABASE: process.env.RESTORE_ISOLATION_DATABASE,
    NOTIFICATION_OUTBOX_ENABLED: process.env.NOTIFICATION_OUTBOX_ENABLED,
    SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
    WEB_PUSH_ENABLED: process.env.WEB_PUSH_ENABLED,
    ALUMNI_NETWORK_RELEASE_AVAILABLE:
      process.env.ALUMNI_NETWORK_RELEASE_AVAILABLE,
  };
}

/**
 * Returns the non-secret configuration names that prevent a restore process
 * from being isolated.  All external-effect controls must be explicitly off;
 * relying on a service's default is intentionally rejected.
 */
export function getRestoreIsolationConfigurationIssues(
  environment: RestoreIsolationEnvironment = currentEnvironment(),
): readonly string[] {
  const invalidVariables: string[] = [];
  if (environment.RESTORE_ISOLATION_MODE !== "true") {
    invalidVariables.push(RESTORE_ISOLATION_MODE_ENV);
  }
  if (
    typeof environment.RESTORE_ISOLATION_DATABASE !== "string" ||
    !RESTORE_DATABASE_NAME_PATTERN.test(environment.RESTORE_ISOLATION_DATABASE) ||
    !RESTORE_DATABASE_MARKER_PATTERN.test(environment.RESTORE_ISOLATION_DATABASE)
  ) {
    invalidVariables.push(RESTORE_ISOLATION_DATABASE_ENV);
  }
  for (const name of RESTORE_ISOLATION_DISABLED_ENVIRONMENTS) {
    if (environment[name] !== "false") invalidVariables.push(name);
  }
  return Object.freeze(invalidVariables);
}

/**
 * Fail closed before a dedicated restore/recovery process opens a database.
 * This does not make ordinary backend startup restore-safe; restore tooling
 * must call it before performing any database work.
 */
export function assertRestoreIsolationConfiguration(
  environment: RestoreIsolationEnvironment = currentEnvironment(),
): void {
  const invalidVariables = getRestoreIsolationConfigurationIssues(environment);
  if (invalidVariables.length > 0) {
    throw new RestoreIsolationConfigurationError(invalidVariables);
  }
}

/**
 * Binds recovery tooling to a deliberately named restore database after the
 * connection is open.  The isolated URI must use a credential scoped to this
 * restore target; the explicit name guard prevents an accidental primary DB
 * mutation when recovery flags are copied into a shell.
 */
export function assertRestoreIsolationDatabase(
  environment: Pick<RestoreIsolationEnvironment, "RESTORE_ISOLATION_DATABASE">,
  connectedDatabaseName: unknown,
): void {
  if (
    typeof connectedDatabaseName !== "string" ||
    connectedDatabaseName !== environment.RESTORE_ISOLATION_DATABASE
  ) {
    throw new RestoreIsolationDatabaseError();
  }
}

/**
 * A restore target is qualified by the dedicated CLI, never by the ordinary
 * HTTP/Socket service.  This makes an accidental `npm start` with restore
 * credentials fail before database connection or startup initialization.
 */
export function assertWebRuntimeIsNotRestoreIsolation(
  environment: Pick<RestoreIsolationEnvironment, "RESTORE_ISOLATION_MODE"> =
    currentEnvironment(),
): void {
  if (environment.RESTORE_ISOLATION_MODE === "true") {
    throw new RestoreIsolationWebRuntimeError();
  }
}
