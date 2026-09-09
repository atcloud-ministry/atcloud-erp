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
    typeof handler.deliver !== "function"
  ) {
    throw new Error("Invalid notification outbox handler");
  }
  return Object.freeze({
    topic: handler.topic,
    payloadVersion: handler.payloadVersion,
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

  get(
    topic: string,
    payloadVersion: number,
  ): NotificationOutboxDeliveryHandler | undefined {
    return this.handlers.get(registryKey(topic, payloadVersion));
  }
}
