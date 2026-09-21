import type mongoose from "mongoose";
import type { ILogger } from "../LoggerService";
import { createLogger } from "../LoggerService";
import {
  programMembershipEventSyncService,
  type ProgramMembershipEventSyncService,
} from "./ProgramMembershipEventSyncService";
import type { ProgramMembershipSyncContext } from "./ProgramRoomMembershipSyncService";
import {
  acquireProgramMembershipRuntimePermit,
  type ProgramMembershipRuntimePermit,
  type ProgramMembershipRuntimeReader,
} from "./ProgramMembershipRuntimeGate";

type ProgramMembershipEventSyncPort = Pick<
  ProgramMembershipEventSyncService,
  | "programAssignmentsChanged"
  | "programPurchaseChanged"
  | "userEligibilityChanged"
  | "communitySettingsChanged"
>;

export interface ProgramPurchaseMembershipChange {
  readonly purchaseType: "program" | "event" | "membership";
  readonly programId?: string | mongoose.Types.ObjectId | null;
}

interface ProgramMembershipMutationSyncTriggerDependencies {
  readonly sync?: ProgramMembershipEventSyncPort;
  readonly logger?: Pick<ILogger, "error">;
  readonly runtimeReader?: ProgramMembershipRuntimeReader;
}

interface ProgramMembershipScheduledWork {
  readonly trigger: string;
  readonly scopeId: string;
  readonly operation: (
    permit: ProgramMembershipRuntimePermit,
  ) => Promise<unknown>;
}

interface ProgramMembershipScopeState {
  latest: ProgramMembershipScheduledWork;
  running: boolean;
  dirty: boolean;
}

export const PROGRAM_MEMBERSHIP_TRIGGER_MAX_CONCURRENT_SCOPES = 2;
const MAXIMUM_PASSES_PER_BURST = 2;

function errorForLog(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Unknown Program membership synchronization error.");
}

function normalizedScopeId(value: string | mongoose.Types.ObjectId): string {
  return String(value).toLowerCase();
}

/**
 * Starts best-effort, post-commit projection refreshes from canonical records.
 * Failures are observed and logged; the bounded reconciler repairs missed work.
 */
export class ProgramMembershipMutationSyncTrigger {
  private readonly sync: ProgramMembershipEventSyncPort;
  private readonly logger: Pick<ILogger, "error">;
  private readonly runtimeReader?: ProgramMembershipRuntimeReader;
  private readonly scopes = new Map<string, ProgramMembershipScopeState>();
  private readonly queue: string[] = [];
  private activeScopes = 0;
  private drainScheduled = false;

  constructor(
    dependencies: ProgramMembershipMutationSyncTriggerDependencies = {},
  ) {
    this.sync = dependencies.sync ?? programMembershipEventSyncService;
    this.logger =
      dependencies.logger ?? createLogger("ProgramMembershipMutationSync");
    this.runtimeReader = dependencies.runtimeReader;
  }

  programAssignmentsChanged(
    programId: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): void {
    const scopeId = normalizedScopeId(programId);
    this.schedule(
      `program:${scopeId}`,
      "program_assignments_changed",
      scopeId,
      (permit) =>
        this.sync.programAssignmentsChanged(programId, {
          ...context,
          runtimePermit: permit,
        }),
    );
  }

  programPurchaseChanged(
    input: ProgramPurchaseMembershipChange,
    context: ProgramMembershipSyncContext = {},
  ): void {
    if (input.purchaseType !== "program" || input.programId == null) return;
    const scopeId = normalizedScopeId(input.programId);
    this.schedule(
      `program:${scopeId}`,
      "program_purchase_changed",
      scopeId,
      (permit) =>
        this.sync.programPurchaseChanged(input, {
          ...context,
          runtimePermit: permit,
        }),
    );
  }

  userEligibilityChanged(
    userId: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): void {
    const scopeId = normalizedScopeId(userId);
    this.schedule(
      `user:${scopeId}`,
      "user_eligibility_changed",
      scopeId,
      (permit) =>
        this.sync.userEligibilityChanged(userId, {
          ...context,
          runtimePermit: permit,
        }),
    );
  }

  communitySettingsChanged(
    programId: string | mongoose.Types.ObjectId,
    context: ProgramMembershipSyncContext = {},
  ): void {
    const scopeId = normalizedScopeId(programId);
    this.schedule(
      `program:${scopeId}`,
      "community_settings_changed",
      scopeId,
      (permit) =>
        this.sync.communitySettingsChanged(programId, {
          ...context,
          runtimePermit: permit,
        }),
    );
  }

  private schedule(
    scopeKey: string,
    trigger: string,
    scopeId: string,
    operation: (permit: ProgramMembershipRuntimePermit) => Promise<unknown>,
  ): void {
    const latest = { trigger, scopeId, operation };
    const existing = this.scopes.get(scopeKey);
    if (existing) {
      existing.latest = latest;
      if (existing.running) existing.dirty = true;
      return;
    }

    this.scopes.set(scopeKey, {
      latest,
      running: false,
      dirty: false,
    });
    this.queue.push(scopeKey);
    this.requestDrain();
  }

  private requestDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    void Promise.resolve()
      .then(() => {
        this.drainScheduled = false;
        this.drainQueue();
      })
      .catch((error: unknown) => {
        this.drainScheduled = false;
        this.logFailure("queue_drain", "global", error);
      });
  }

  private drainQueue(): void {
    while (
      this.activeScopes < PROGRAM_MEMBERSHIP_TRIGGER_MAX_CONCURRENT_SCOPES &&
      this.queue.length > 0
    ) {
      const scopeKey = this.queue.shift();
      if (!scopeKey) continue;
      const state = this.scopes.get(scopeKey);
      if (!state || state.running) continue;
      state.running = true;
      this.activeScopes += 1;
      void this.executeScope(scopeKey, state).catch((error: unknown) => {
        this.logFailure("scope_execution", scopeKey, error);
      });
    }
  }

  private async executeScope(
    scopeKey: string,
    state: ProgramMembershipScopeState,
  ): Promise<void> {
    try {
      for (let pass = 0; pass < MAXIMUM_PASSES_PER_BURST; pass += 1) {
        state.dirty = false;
        const work = state.latest;
        try {
          const permit = await acquireProgramMembershipRuntimePermit(
            this.runtimeReader,
          );
          if (permit) await work.operation(permit);
        } catch (error) {
          this.logFailure(work.trigger, work.scopeId, error);
        }
        if (!state.dirty) break;
      }
    } finally {
      if (this.scopes.get(scopeKey) === state) {
        if (state.dirty) {
          state.running = false;
          this.queue.push(scopeKey);
        } else {
          this.scopes.delete(scopeKey);
        }
      }
      this.activeScopes = Math.max(0, this.activeScopes - 1);
      this.requestDrain();
    }
  }

  private logFailure(trigger: string, scopeId: string, error: unknown): void {
    try {
      this.logger.error(
        "Deferred Program membership synchronization failed",
        errorForLog(error),
        "ProgramMembershipMutationSync",
        { trigger, scopeId },
      );
    } catch {
      // Logging must never turn best-effort projection repair into an
      // unhandled rejection on the canonical mutation path.
    }
  }
}

export const programMembershipMutationSyncTrigger =
  new ProgramMembershipMutationSyncTrigger();
