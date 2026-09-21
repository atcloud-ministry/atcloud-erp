import { randomUUID } from "crypto";
import {
  AuthorizationService,
  authorizationService,
} from "./AuthorizationService";
import {
  AUTHORIZATION_ACTIONS,
  type AuthorizationDecision,
  type AuthorizationResource,
  type ServiceAuthorizationPrincipal,
} from "./types";
import { recordAuthorizationDenial } from "./AuthorizationAuditService";

export const WORKER_SERVICE_KEYS = {
  EVENT_REMINDER: "event-reminder",
  ALUMNI_OUTCOME: "alumni-outcome",
  ALUMNI_HELP_ROOM_GRACE: "alumni-help-room-grace",
  ALUMNI_RETENTION: "alumni-retention",
  CHAT_UNREAD: "chat-unread-reconciler",
  NOTIFICATION_OUTBOX: "notification-outbox",
  PROGRAM_MEMBERSHIP_RECONCILER: "program-membership-reconciler",
} as const;

export type WorkerServiceKey =
  (typeof WORKER_SERVICE_KEYS)[keyof typeof WORKER_SERVICE_KEYS];

export const WORKER_CAPABILITIES = {
  EVENT_REMINDER_SEND: "event.reminder.send",
  ALUMNI_OUTCOME_AUTO_CONFIRM: "alumni.outcome.auto_confirm",
  ALUMNI_HELP_ROOM_GRACE_ARCHIVE: "alumni.help.room_grace.archive",
  ALUMNI_RETENTION_PURGE: "alumni.retention.purge",
  CHAT_UNREAD_RECONCILE: "chat.unread.reconcile",
  NOTIFICATION_OUTBOX_DELIVER: "notification.outbox.deliver",
  NOTIFICATION_OUTBOX_RECONCILE: "notification.outbox.reconcile",
  PROGRAM_MEMBERSHIP_RECONCILE: "program.membership.reconcile",
} as const;

export type WorkerCapability =
  (typeof WORKER_CAPABILITIES)[keyof typeof WORKER_CAPABILITIES];

export const WORKER_RUN_TRIGGERS = {
  SCHEDULED: "scheduled",
  STARTUP: "startup",
  MANUAL: "manual",
  RECOVERY: "recovery",
} as const;

export type WorkerRunTrigger =
  (typeof WORKER_RUN_TRIGGERS)[keyof typeof WORKER_RUN_TRIGGERS];

export const WORKER_SERVICE_CAPABILITIES = Object.freeze({
  [WORKER_SERVICE_KEYS.EVENT_REMINDER]: Object.freeze([
    WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
  ]),
  [WORKER_SERVICE_KEYS.ALUMNI_OUTCOME]: Object.freeze([
    WORKER_CAPABILITIES.ALUMNI_OUTCOME_AUTO_CONFIRM,
  ]),
  [WORKER_SERVICE_KEYS.ALUMNI_HELP_ROOM_GRACE]: Object.freeze([
    WORKER_CAPABILITIES.ALUMNI_HELP_ROOM_GRACE_ARCHIVE,
  ]),
  [WORKER_SERVICE_KEYS.ALUMNI_RETENTION]: Object.freeze([
    WORKER_CAPABILITIES.ALUMNI_RETENTION_PURGE,
  ]),
  [WORKER_SERVICE_KEYS.CHAT_UNREAD]: Object.freeze([
    WORKER_CAPABILITIES.CHAT_UNREAD_RECONCILE,
  ]),
  [WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX]: Object.freeze([
    WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_DELIVER,
    WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_RECONCILE,
  ]),
  [WORKER_SERVICE_KEYS.PROGRAM_MEMBERSHIP_RECONCILER]: Object.freeze([
    WORKER_CAPABILITIES.PROGRAM_MEMBERSHIP_RECONCILE,
  ]),
} as const satisfies Record<WorkerServiceKey, readonly WorkerCapability[]>);

type WorkerServiceCapabilityRegistry = typeof WORKER_SERVICE_CAPABILITIES;

export type WorkerCapabilityFor<ServiceKey extends WorkerServiceKey> =
  WorkerServiceCapabilityRegistry[ServiceKey][number];

type WorkerPrincipalFor<ServiceKey extends WorkerServiceKey> =
  ServiceAuthorizationPrincipal & {
    readonly serviceKey: ServiceKey;
    readonly capabilities: readonly WorkerCapabilityFor<ServiceKey>[];
    readonly runId: string;
  };

export interface WorkerRunContext<
  ServiceKey extends WorkerServiceKey = WorkerServiceKey,
> {
  readonly source: "worker";
  readonly principal: WorkerPrincipalFor<ServiceKey>;
  readonly runId: string;
  readonly trigger: WorkerRunTrigger;
  readonly initiatedByUserId?: string;
}

export interface WorkerCapabilityAuthorizationOptions {
  readonly resource?: AuthorizationResource;
  readonly context?: Readonly<Record<string, unknown>>;
}

type AuthorizationEngine = Pick<AuthorizationService, "authorize">;

const knownServiceKeys = new Set<string>(
  Object.values(WORKER_SERVICE_KEYS),
);
const knownRunTriggers = new Set<string>(
  Object.values(WORKER_RUN_TRIGGERS),
);
const noCapabilities: readonly string[] = Object.freeze([]);
const invalidWorkerContextDecision: AuthorizationDecision = Object.freeze({
  allowed: false,
  reasonCode: "invalid_context",
  concealExistence: true,
});

function isWorkerServiceKey(value: unknown): value is WorkerServiceKey {
  return typeof value === "string" && knownServiceKeys.has(value);
}

function isWorkerRunTrigger(value: unknown): value is WorkerRunTrigger {
  return typeof value === "string" && knownRunTriggers.has(value);
}

export class WorkerAuthorizationError extends Error {
  constructor(public readonly decision: AuthorizationDecision) {
    super(`Worker authorization denied: ${decision.reasonCode}`);
    this.name = "WorkerAuthorizationError";
  }
}

/**
 * Thin, fail-closed worker adapter around the transport-neutral authorization
 * engine. A fixed server-side registry supplies every service capability;
 * callers never provide their own grants.
 */
export class WorkerAuthorizationService {
  private readonly issuedRunContexts = new WeakSet<object>();

  constructor(
    private readonly authorization: AuthorizationEngine = authorizationService,
  ) {}

  createRunContext<ServiceKey extends WorkerServiceKey>(
    serviceKey: ServiceKey,
    trigger: WorkerRunTrigger,
    initiatedByUserId?: string,
  ): WorkerRunContext<ServiceKey> {
    if (!isWorkerServiceKey(serviceKey)) {
      throw new Error(`Unknown worker service: ${String(serviceKey)}`);
    }
    if (!isWorkerRunTrigger(trigger)) {
      throw new Error(`Unknown worker run trigger: ${String(trigger)}`);
    }
    if (
      initiatedByUserId !== undefined &&
      (typeof initiatedByUserId !== "string" ||
        !initiatedByUserId.trim() ||
        initiatedByUserId.trim().length > 256)
    ) {
      throw new Error(
        "initiatedByUserId must be a non-empty string of at most 256 characters when provided",
      );
    }

    const runId = randomUUID();
    const normalizedInitiator = initiatedByUserId?.trim();
    const capabilities = WORKER_SERVICE_CAPABILITIES[serviceKey] as readonly
      WorkerCapabilityFor<ServiceKey>[];
    const principal = Object.freeze({
      kind: "service" as const,
      serviceKey,
      capabilities,
      runId,
      ...(normalizedInitiator
        ? { initiatedByUserId: normalizedInitiator }
        : {}),
    });

    const runContext = Object.freeze({
      source: "worker" as const,
      principal,
      runId,
      trigger,
      ...(normalizedInitiator
        ? { initiatedByUserId: normalizedInitiator }
        : {}),
    });
    this.issuedRunContexts.add(runContext);
    return runContext;
  }

  private isValidRunContext(
    value: unknown,
  ): value is WorkerRunContext<WorkerServiceKey> {
    if (!value || typeof value !== "object") return false;
    if (!this.issuedRunContexts.has(value)) return false;

    const runContext = value as Partial<WorkerRunContext<WorkerServiceKey>>;
    const principal = runContext.principal;
    if (
      runContext.source !== "worker" ||
      !isWorkerRunTrigger(runContext.trigger) ||
      typeof runContext.runId !== "string" ||
      runContext.runId.length === 0 ||
      runContext.runId.length > 128 ||
      !principal ||
      principal.kind !== "service" ||
      !isWorkerServiceKey(principal.serviceKey) ||
      principal.runId !== runContext.runId ||
      !Object.isFrozen(runContext) ||
      !Object.isFrozen(principal)
    ) {
      return false;
    }

    const initiatedByUserId = runContext.initiatedByUserId;
    if (
      initiatedByUserId !== principal.initiatedByUserId ||
      (initiatedByUserId !== undefined &&
        (typeof initiatedByUserId !== "string" ||
          initiatedByUserId.length === 0 ||
          initiatedByUserId.length > 256))
    ) {
      return false;
    }

    const fixedCapabilities = WORKER_SERVICE_CAPABILITIES[principal.serviceKey];
    return (
      Array.isArray(principal.capabilities) &&
      Object.isFrozen(principal.capabilities) &&
      principal.capabilities.length === fixedCapabilities.length &&
      principal.capabilities.every(
        (capability, index) => capability === fixedCapabilities[index],
      )
    );
  }

  async authorizeCapability<ServiceKey extends WorkerServiceKey>(
    runContext: WorkerRunContext<ServiceKey>,
    capability: WorkerCapabilityFor<ServiceKey>,
    options: WorkerCapabilityAuthorizationOptions = {},
  ): Promise<AuthorizationDecision> {
    if (!this.isValidRunContext(runContext)) {
      return invalidWorkerContextDecision;
    }

    const serviceKey: unknown = runContext.principal.serviceKey;
    const fixedCapabilities = isWorkerServiceKey(serviceKey)
      ? WORKER_SERVICE_CAPABILITIES[serviceKey]
      : noCapabilities;

    const principal: ServiceAuthorizationPrincipal = {
      kind: "service",
      serviceKey: String(serviceKey),
      capabilities: fixedCapabilities,
      runId: runContext.runId,
      ...(runContext.initiatedByUserId
        ? { initiatedByUserId: runContext.initiatedByUserId }
        : {}),
    };

    return this.authorization.authorize({
      source: "worker",
      principal,
      action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
      ...(options.resource ? { resource: options.resource } : {}),
      context: {
        ...(options.context ?? {}),
        runId: runContext.runId,
        trigger: runContext.trigger,
        ...(runContext.initiatedByUserId
          ? { initiatedByUserId: runContext.initiatedByUserId }
          : {}),
        capability,
      },
    });
  }

  async assertCapability<ServiceKey extends WorkerServiceKey>(
    runContext: WorkerRunContext<ServiceKey>,
    capability: WorkerCapabilityFor<ServiceKey>,
    options: WorkerCapabilityAuthorizationOptions = {},
  ): Promise<void> {
    const decision = await this.authorizeCapability(
      runContext,
      capability,
      options,
    );
    if (!decision.allowed) {
      const trustedRunContext = this.isValidRunContext(runContext)
        ? runContext
        : undefined;
      recordAuthorizationDenial(
        {
          source: "worker",
          principal: trustedRunContext?.principal ?? {
            kind: "service",
            serviceKey: "invalid-worker-context",
            capabilities: noCapabilities,
          },
          action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
          ...(trustedRunContext && options.resource
            ? { resource: options.resource }
            : {}),
          context: {
            ...(trustedRunContext ? options.context ?? {} : {}),
            capability,
            trigger: trustedRunContext?.trigger ?? "invalid",
          },
        },
        decision,
        trustedRunContext?.runId,
      );
      throw new WorkerAuthorizationError(decision);
    }
  }
}

export const workerAuthorizationService = new WorkerAuthorizationService();
