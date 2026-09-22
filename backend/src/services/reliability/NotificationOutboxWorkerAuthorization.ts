import {
  WORKER_CAPABILITIES,
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  WorkerAuthorizationService,
  workerAuthorizationService,
  type WorkerRunContext,
  type WorkerRunTrigger,
} from "../authorization/WorkerAuthorizationService";
import type { ClaimedNotificationOutbox } from "./NotificationOutboxService";
import type { NotificationOutboxWorkerAuthorizer } from "./NotificationOutboxWorker";

export interface NotificationOutboxWorkerAuthorizationOptions {
  readonly trigger?: WorkerRunTrigger;
  readonly initiatedByUserId?: string;
  readonly authorization?: Pick<
    WorkerAuthorizationService,
    "createRunContext" | "assertCapability"
  >;
}

type NotificationOutboxRunContext = WorkerRunContext<
  typeof WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX
>;

/**
 * Production bridge to the fixed M0-02 worker authorization registry. Calling
 * assertCanReconcile starts a new protected run; every subsequent delivery in
 * that run reuses its runId and is scoped to the claimed outbox event.
 */
export class NotificationOutboxWorkerAuthorization
  implements NotificationOutboxWorkerAuthorizer
{
  private readonly authorization: Pick<
    WorkerAuthorizationService,
    "createRunContext" | "assertCapability"
  >;
  private readonly trigger: WorkerRunTrigger;
  private readonly initiatedByUserId?: string;
  private runContext: NotificationOutboxRunContext | null = null;
  private runGeneration = 0;

  constructor(options: NotificationOutboxWorkerAuthorizationOptions = {}) {
    this.authorization = options.authorization ?? workerAuthorizationService;
    this.trigger = options.trigger ?? WORKER_RUN_TRIGGERS.SCHEDULED;
    this.initiatedByUserId = options.initiatedByUserId;
  }

  async assertCanReconcile(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Notification outbox run authorization was aborted");
    }
    const generation = ++this.runGeneration;
    this.runContext = null;
    const context = this.authorization.createRunContext(
      WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX,
      this.trigger,
      this.initiatedByUserId,
    );
    try {
      await this.authorization.assertCapability(
        context,
        WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_RECONCILE,
        {
          resource: { type: "notification_outbox", id: "reconciliation" },
        },
      );
      if (signal?.aborted || generation !== this.runGeneration) {
        throw signal?.reason instanceof Error
          ? signal.reason
          : new Error("Notification outbox run authorization was superseded");
      }
      this.runContext = context;
    } catch (error) {
      if (generation === this.runGeneration) this.runContext = null;
      throw error;
    }
  }

  async assertCanDeliver(event: ClaimedNotificationOutbox): Promise<void> {
    if (!this.runContext) {
      throw new Error(
        "Notification outbox delivery authorization requires an active run",
      );
    }
    await this.authorization.assertCapability(
      this.runContext,
      WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_DELIVER,
      {
        resource: { type: "notification_outbox", id: event.eventId },
        context: {
          topic: event.topic,
          payloadVersion: event.payloadVersion,
        },
      },
    );
  }
}

export function createNotificationOutboxWorkerAuthorization(
  options: NotificationOutboxWorkerAuthorizationOptions = {},
): NotificationOutboxWorkerAuthorizer {
  return new NotificationOutboxWorkerAuthorization(options);
}
