import { chatSendRateLimited } from "./ChatRoomErrors";

export const CHAT_SEND_RATE_LIMITS = Object.freeze({
  burst: Object.freeze({ windowMs: 10_000, limit: 5 }),
  room: Object.freeze({ windowMs: 60_000, limit: 20 }),
  account: Object.freeze({ windowMs: 60_000, limit: 60 }),
  retryIdentityTtlMs: 60_000,
  maximumTrackedRetryIdentities: 25_000,
  maximumTrackedBuckets: 25_000,
  sweepIntervalMs: 60_000,
});

interface ChatSendRateLimitInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
}

interface Bucket {
  timestamps: number[];
  windowMs: number;
}

export interface ChatSendRateLimiterDependencies {
  readonly now?: () => number;
}

/**
 * Single-process rolling limiter for the approved single Render Web Service.
 * The client-message retry cache prevents a transport retry from consuming a
 * second token; domain idempotency still validates the persisted payload.
 */
export class ChatSendRateLimiter {
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly retryIdentities = new Map<string, number>();
  private lastSweepAt = 0;

  constructor(dependencies: ChatSendRateLimiterDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
  }

  assertAllowed(input: ChatSendRateLimitInput): void {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("Chat send rate-limit clock is invalid.");
    }
    const retryKey = `${input.userId}:${input.conversationId}:${input.clientMessageId}`;
    const retryUntil = this.retryIdentities.get(retryKey);
    if (retryUntil !== undefined && retryUntil > now) return;
    this.pruneBuckets(now);

    const checks = [
      {
        key: `chat:burst:${input.userId}:${input.conversationId}`,
        ...CHAT_SEND_RATE_LIMITS.burst,
      },
      {
        key: `chat:room:${input.userId}:${input.conversationId}`,
        ...CHAT_SEND_RATE_LIMITS.room,
      },
      {
        key: `chat:account:${input.userId}`,
        ...CHAT_SEND_RATE_LIMITS.account,
      },
    ] as const;

    let retryAfterMs = 0;
    for (const check of checks) {
      const timestamps = this.retainedTimestamps(check.key, check.windowMs, now);
      if (timestamps.length >= check.limit) {
        retryAfterMs = Math.max(
          retryAfterMs,
          check.windowMs - (now - timestamps[0]),
        );
      }
    }
    if (retryAfterMs > 0) {
      throw chatSendRateLimited(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
    }

    for (const check of checks) {
      const bucket = this.buckets.get(check.key) ?? {
        timestamps: [],
        windowMs: check.windowMs,
      };
      bucket.timestamps.push(now);
      bucket.windowMs = Math.max(bucket.windowMs, check.windowMs);
      this.buckets.set(check.key, bucket);
    }
    this.retryIdentities.delete(retryKey);
    this.retryIdentities.set(
      retryKey,
      now + CHAT_SEND_RATE_LIMITS.retryIdentityTtlMs,
    );
    this.pruneRetryIdentities(now);
  }

  reset(): void {
    this.buckets.clear();
    this.retryIdentities.clear();
    this.lastSweepAt = 0;
  }

  snapshot(): Readonly<{ trackedBuckets: number; trackedRetryIdentities: number }> {
    return Object.freeze({
      trackedBuckets: this.buckets.size,
      trackedRetryIdentities: this.retryIdentities.size,
    });
  }

  private retainedTimestamps(
    key: string,
    windowMs: number,
    now: number,
  ): number[] {
    const bucket = this.buckets.get(key);
    if (!bucket) return [];
    const threshold = now - windowMs;
    let firstRetained = 0;
    while (
      firstRetained < bucket.timestamps.length &&
      bucket.timestamps[firstRetained] <= threshold
    ) {
      firstRetained += 1;
    }
    if (firstRetained > 0) bucket.timestamps.splice(0, firstRetained);
    if (bucket.timestamps.length === 0) this.buckets.delete(key);
    return bucket.timestamps;
  }

  private pruneRetryIdentities(now: number): void {
    for (const [key, expiresAt] of this.retryIdentities) {
      if (
        expiresAt <= now ||
        this.retryIdentities.size >
          CHAT_SEND_RATE_LIMITS.maximumTrackedRetryIdentities
      ) {
        this.retryIdentities.delete(key);
      } else {
        // Insertion order means all following live values are newer unless the
        // hard capacity limit still requires eviction.
        break;
      }
    }
  }

  private pruneBuckets(now: number): void {
    if (
      this.buckets.size <= CHAT_SEND_RATE_LIMITS.maximumTrackedBuckets &&
      now - this.lastSweepAt < CHAT_SEND_RATE_LIMITS.sweepIntervalMs
    ) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      const threshold = now - bucket.windowMs;
      let firstRetained = 0;
      while (
        firstRetained < bucket.timestamps.length &&
        bucket.timestamps[firstRetained] <= threshold
      ) {
        firstRetained += 1;
      }
      if (firstRetained > 0) bucket.timestamps.splice(0, firstRetained);
      if (
        bucket.timestamps.length === 0 ||
        this.buckets.size > CHAT_SEND_RATE_LIMITS.maximumTrackedBuckets
      ) {
        this.buckets.delete(key);
      }
    }
  }
}

export const chatSendRateLimiter = new ChatSendRateLimiter();
