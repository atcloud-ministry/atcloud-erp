import type { ClientSession, HydratedDocument, Model } from "mongoose";
import {
  AlumniNetworkFeatureConfigurationError,
  isAlumniNetworkMode,
  readAlumniNetworkReleaseAvailable,
  type AlumniNetworkMode,
} from "../../config/alumniNetworkFeature";
import type { AuditLogWriteInput } from "../../contracts/auditLog";
import {
  createRuntimeConfigDTO,
  FAIL_CLOSED_RUNTIME_CONFIG,
  type RuntimeConfigSuccessDTO,
} from "../../contracts/runtimeConfig";
import FeatureControl, {
  FEATURE_CONTROL_SINGLETON_ID,
  type IFeatureControl,
} from "../../models/FeatureControl";
import { AuditLogService } from "../AuditLogService";
import {
  CasConflictError,
  CasService,
  type CasUpdateInput,
} from "../reliability/CasService";
import {
  mongoTransactionService,
  MongoTransactionCommitUncertainError,
} from "../reliability/MongoTransactionService";
import { awaitWithAbort } from "../../utils/abortablePromise";
import {
  migrationReadinessService,
  type MigrationReadinessService,
} from "../migrations/MigrationReadinessService";

const ACTOR_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
const ACTOR_ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;
export const FEATURE_CONTROL_READ_TIMEOUT_MS = 1_500;

export interface UpdateAlumniNetworkModeInput {
  readonly mode: AlumniNetworkMode;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly actorRole: string;
  readonly correlationId?: string;
}

interface TransactionRunner {
  run<T>(operation: (session: ClientSession) => Promise<T>): Promise<T>;
}

type RequiredAuditWriter = (
  input: AuditLogWriteInput,
  session: ClientSession,
) => Promise<void>;

type FeatureControlCasUpdate = (
  input: CasUpdateInput<IFeatureControl>,
) => Promise<HydratedDocument<IFeatureControl>>;

export interface FeatureControlServiceDependencies {
  readonly model?: Model<IFeatureControl>;
  readonly transactions?: TransactionRunner;
  readonly writeRequiredAudit?: RequiredAuditWriter;
  readonly casUpdate?: FeatureControlCasUpdate;
  readonly releaseAvailable?: () => boolean;
  readonly migrationReadiness?: Pick<MigrationReadinessService, "assertReady">;
  readonly readTimeoutMs?: number;
}

export class FeatureControlInputError extends Error {
  readonly name = "FeatureControlInputError";
  readonly code = "FEATURE_CONTROL_INPUT_INVALID";

  constructor() {
    super("The feature control request is invalid.");
  }
}

export class FeatureControlReleaseUnavailableError extends Error {
  readonly name = "FeatureControlReleaseUnavailableError";
  readonly code = "ALUMNI_NETWORK_RELEASE_UNAVAILABLE";

  constructor() {
    super("The alumni network release is unavailable in this deployment.");
  }
}

function requireStoredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Stored feature control revision is invalid.");
  }
  return value as number;
}

function validateUpdateInput(
  input: UpdateAlumniNetworkModeInput,
): UpdateAlumniNetworkModeInput {
  if (
    !input ||
    typeof input !== "object" ||
    !isAlumniNetworkMode(input.mode) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    typeof input.actorId !== "string" ||
    !ACTOR_ID_PATTERN.test(input.actorId) ||
    typeof input.actorRole !== "string" ||
    input.actorRole.length > 80 ||
    !ACTOR_ROLE_PATTERN.test(input.actorRole)
  ) {
    throw new FeatureControlInputError();
  }

  return Object.freeze({
    mode: input.mode,
    expectedRevision: input.expectedRevision,
    actorId: input.actorId,
    actorRole: input.actorRole,
    ...(typeof input.correlationId === "string"
      ? { correlationId: input.correlationId }
      : {}),
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === 11000
  );
}

export class FeatureControlService {
  private readonly model: Model<IFeatureControl>;
  private readonly transactions: TransactionRunner;
  private readonly writeRequiredAudit: RequiredAuditWriter;
  private readonly casUpdate: FeatureControlCasUpdate;
  private readonly releaseAvailable: () => boolean;
  private readonly migrationReadiness: Pick<
    MigrationReadinessService,
    "assertReady"
  >;
  private readonly readTimeoutMs: number;

  constructor(dependencies: FeatureControlServiceDependencies = {}) {
    this.model = dependencies.model ?? FeatureControl;
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.writeRequiredAudit =
      dependencies.writeRequiredAudit ??
      AuditLogService.recordRequiredInTransaction.bind(AuditLogService);
    this.casUpdate =
      dependencies.casUpdate ??
      ((input) => CasService.update<IFeatureControl>(input));
    this.releaseAvailable =
      dependencies.releaseAvailable ?? readAlumniNetworkReleaseAvailable;
    this.migrationReadiness =
      dependencies.migrationReadiness ?? migrationReadinessService;
    this.readTimeoutMs =
      dependencies.readTimeoutMs ?? FEATURE_CONTROL_READ_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.readTimeoutMs) || this.readTimeoutMs < 1) {
      throw new Error("Feature control read timeout is invalid.");
    }
  }

  /** Strict read for readiness/operations; storage and configuration faults reject. */
  async getOperationalRuntimeConfig(options: {
    readonly signal?: AbortSignal;
  } = {}): Promise<RuntimeConfigSuccessDTO> {
    const timeoutSignal = AbortSignal.timeout(this.readTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const control = await awaitWithAbort(
      this.model.findById(FEATURE_CONTROL_SINGLETON_ID, null, {
        maxTimeMS: this.readTimeoutMs,
        signal,
      }),
      signal,
    );
    const revision = control ? requireStoredRevision(control.revision) : 0;
    const storedMode = control?.mode ?? "off";
    if (!isAlumniNetworkMode(storedMode)) {
      throw new Error("Stored feature control mode is invalid.");
    }

    const releaseAvailable = this.releaseAvailable();
    if (releaseAvailable && storedMode !== "off") {
      await awaitWithAbort(this.migrationReadiness.assertReady({ signal }), signal);
    }
    const effectiveMode = releaseAvailable ? storedMode : "off";
    return createRuntimeConfigDTO(effectiveMode, revision);
  }

  /** Public reads never throw and collapse storage/config failures to off. */
  async getRuntimeConfig(): Promise<RuntimeConfigSuccessDTO> {
    try {
      return await this.getOperationalRuntimeConfig();
    } catch {
      return FAIL_CLOSED_RUNTIME_CONFIG;
    }
  }

  async updateAlumniNetworkMode(
    rawInput: UpdateAlumniNetworkModeInput,
  ): Promise<RuntimeConfigSuccessDTO> {
    const input = validateUpdateInput(rawInput);
    let releaseAvailable: boolean;
    try {
      releaseAvailable = this.releaseAvailable();
    } catch (error) {
      if (error instanceof AlumniNetworkFeatureConfigurationError) throw error;
      throw new AlumniNetworkFeatureConfigurationError();
    }
    if (input.mode !== "off" && !releaseAvailable) {
      throw new FeatureControlReleaseUnavailableError();
    }
    if (input.mode !== "off") {
      const signal = AbortSignal.timeout(this.readTimeoutMs);
      await awaitWithAbort(
        this.migrationReadiness.assertReady({ signal }),
        signal,
      );
    }

    let updated: HydratedDocument<IFeatureControl>;
    try {
      updated = await this.transactions.run(async (session) => {
        const current = await this.model.findById(
          FEATURE_CONTROL_SINGLETON_ID,
          null,
          { session },
        );
        const fromMode = current?.mode ?? "off";
        const fromRevision = current
          ? requireStoredRevision(current.revision)
          : 0;
        if (!isAlumniNetworkMode(fromMode)) {
          throw new Error("Stored feature control mode is invalid.");
        }

        let next: HydratedDocument<IFeatureControl>;
        if (!current) {
          if (input.expectedRevision !== 0) {
            throw new CasConflictError(
              input.expectedRevision,
              0,
              "revision_mismatch",
            );
          }
          try {
            [next] = await this.model.create(
              [
                {
                  _id: FEATURE_CONTROL_SINGLETON_ID,
                  mode: input.mode,
                  revision: 1,
                  changedBy: input.actorId,
                },
              ],
              { session },
            );
          } catch (error) {
            if (isDuplicateKeyError(error)) {
              throw new CasConflictError(
                input.expectedRevision,
                1,
                "revision_mismatch",
              );
            }
            throw error;
          }
        } else {
          next = await this.casUpdate({
            model: this.model,
            id: FEATURE_CONTROL_SINGLETON_ID,
            expectedRevision: input.expectedRevision,
            update: {
              $set: {
                mode: input.mode,
                changedBy: input.actorId,
              },
            },
            session,
          });
        }

        const toRevision = requireStoredRevision(next.revision);
        await this.writeRequiredAudit(
          {
            action: "alumni_network.mode_changed",
            actor: {
              type: "user",
              id: input.actorId,
              role: input.actorRole,
            },
            source: "http",
            outcome: "success",
            target: {
              model: "FeatureControl",
              id: FEATURE_CONTROL_SINGLETON_ID,
            },
            correlationId: input.correlationId,
            details: {
              fromMode,
              toMode: input.mode,
              fromRevision,
              toRevision,
            },
          },
          session,
        );

        return next;
      });
    } catch (error) {
      if (!(error instanceof MongoTransactionCommitUncertainError)) throw error;

      try {
        const reconciled = await this.model.findById(
          FEATURE_CONTROL_SINGLETON_ID,
        );
        if (
          reconciled &&
          reconciled.revision === input.expectedRevision + 1 &&
          reconciled.mode === input.mode &&
          reconciled.changedBy === input.actorId
        ) {
          updated = reconciled;
        } else {
          throw error;
        }
      } catch {
        throw error;
      }
    }

    return createRuntimeConfigDTO(
      updated.mode,
      requireStoredRevision(updated.revision),
    );
  }
}

export function isFeatureControlInputError(
  error: unknown,
): error is FeatureControlInputError {
  return error instanceof FeatureControlInputError;
}

export function isFeatureControlReleaseUnavailableError(
  error: unknown,
): error is FeatureControlReleaseUnavailableError {
  return error instanceof FeatureControlReleaseUnavailableError;
}

export const featureControlService = new FeatureControlService();
