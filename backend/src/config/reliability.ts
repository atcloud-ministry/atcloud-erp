export interface ReliabilityEnvironment {
  readonly NODE_ENV?: string;
  readonly MONGO_TRANSACTIONS_REQUIRED?: string;
  readonly NOTIFICATION_OUTBOX_ENABLED?: string;
}

function currentEnvironment(): ReliabilityEnvironment {
  return {
    NODE_ENV: process.env.NODE_ENV,
    MONGO_TRANSACTIONS_REQUIRED: process.env.MONGO_TRANSACTIONS_REQUIRED,
    NOTIFICATION_OUTBOX_ENABLED: process.env.NOTIFICATION_OUTBOX_ENABLED,
  };
}

/**
 * Production must prove that MongoDB supports transactions before serving
 * correctness-critical alumni/chat writes. Tests opt in through their own
 * replica-set suite; development can request the same startup guard explicitly.
 */
export function isMongoTransactionCapabilityRequired(
  env: ReliabilityEnvironment = currentEnvironment(),
): boolean {
  if (env.NODE_ENV === "test") return false;
  if (env.NODE_ENV === "production") return true;
  return env.MONGO_TRANSACTIONS_REQUIRED === "true";
}

/** The durable worker is enabled explicitly on the process that owns workers. */
export function isNotificationOutboxEnabled(
  env: ReliabilityEnvironment = currentEnvironment(),
): boolean {
  if (env.NODE_ENV === "test") return false;
  return env.NOTIFICATION_OUTBOX_ENABLED === "true";
}
