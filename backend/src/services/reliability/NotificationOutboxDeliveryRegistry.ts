import type {
  ClaimedNotificationOutbox,
  SupportedOutboxDelivery,
} from "./NotificationOutboxService";

export interface NotificationOutboxDeliveryContext {
  readonly signal: AbortSignal;
  readonly renewLease: () => Promise<ClaimedNotificationOutbox>;
}

export interface NotificationOutboxDeliveryHandler {
  readonly topic: string;
  readonly payloadVersion: number;
  /**
   * Optional runtime kill switch. Returning false (or failing) keeps this
   * handler registered for reconciliation while excluding it from claiming.
   */
  canClaim?(signal: AbortSignal): Promise<boolean>;
  /** Re-loads recipient/resource state and fails closed before any external I/O. */
  assertCanDeliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void>;
  deliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void>;
}

function registryKey(topic: string, payloadVersion: number): string {
  return `${topic}\u0000${payloadVersion}`;
}

function validateHandler(
  handler: NotificationOutboxDeliveryHandler,
): NotificationOutboxDeliveryHandler {
  if (
    !handler ||
    typeof handler.topic !== "string" ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(handler.topic) ||
    handler.topic.length > 120 ||
    !Number.isInteger(handler.payloadVersion) ||
    handler.payloadVersion < 1 ||
    handler.payloadVersion > 1_000 ||
    typeof handler.assertCanDeliver !== "function" ||
    typeof handler.deliver !== "function" ||
    (handler.canClaim !== undefined && typeof handler.canClaim !== "function")
  ) {
    throw new Error("Invalid notification outbox handler");
  }
  return Object.freeze({
    topic: handler.topic,
    payloadVersion: handler.payloadVersion,
    ...(handler.canClaim
      ? { canClaim: handler.canClaim.bind(handler) }
      : {}),
    assertCanDeliver: handler.assertCanDeliver.bind(handler),
    deliver: handler.deliver.bind(handler),
  });
}

/** Immutable, explicit handler registry. Database values can select only code
 * registered at process startup; they can never name or execute arbitrary code.
 */
export class NotificationOutboxDeliveryRegistry {
  private readonly handlers: ReadonlyMap<
    string,
    NotificationOutboxDeliveryHandler
  >;
  private readonly supported: readonly SupportedOutboxDelivery[];

  constructor(handlers: readonly NotificationOutboxDeliveryHandler[]) {
    const byKey = new Map<string, NotificationOutboxDeliveryHandler>();
    const supported: SupportedOutboxDelivery[] = [];
    for (const candidate of handlers) {
      const handler = validateHandler(candidate);
      const key = registryKey(handler.topic, handler.payloadVersion);
      if (byKey.has(key)) {
        throw new Error(
          `Duplicate notification outbox handler: ${handler.topic}@${handler.payloadVersion}`,
        );
      }
      byKey.set(key, handler);
      supported.push(
        Object.freeze({
          topic: handler.topic,
          payloadVersion: handler.payloadVersion,
        }),
      );
    }
    this.handlers = byKey;
    this.supported = Object.freeze(supported);
  }

  get supportedDeliveries(): readonly SupportedOutboxDelivery[] {
    return this.supported;
  }

  /**
   * Returns the registered deliveries that may be claimed now. A handler's
   * availability failure fails closed only for that handler. Caller aborts
   * still propagate so shutdown and bounded worker checks cannot be swallowed.
   */
  async getClaimableDeliveries(
    signal: AbortSignal,
  ): Promise<readonly SupportedOutboxDelivery[]> {
    signal.throwIfAborted();
    const candidates = await Promise.all(
      this.supported.map(async (delivery) => {
        const handler = this.get(delivery.topic, delivery.payloadVersion);
        if (!handler?.canClaim) return delivery;
        try {
          return (await handler.canClaim(signal)) === true ? delivery : null;
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          return null;
        }
      }),
    );
    signal.throwIfAborted();
    return Object.freeze(
      candidates.filter(
        (delivery): delivery is SupportedOutboxDelivery => delivery !== null,
      ),
    );
  }

  get(
    topic: string,
    payloadVersion: number,
  ): NotificationOutboxDeliveryHandler | undefined {
    return this.handlers.get(registryKey(topic, payloadVersion));
  }
}
