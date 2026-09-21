import type { MigrationSourceDefinition } from "../types";

type RetentionCheckpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
};

type OutboxRetentionDocument = {
  readonly _id?: unknown;
  readonly status?: unknown;
  readonly deliveredAt?: unknown;
  readonly deadAt?: unknown;
  readonly purgeAt?: unknown;
  readonly __migrationCursorId?: unknown;
};

export const migration = {
  id: "20260918_004_enforce-notification-outbox-retention",
  description:
    "Backfill terminal NotificationOutbox purge clocks and enforce their absolute TTL index.",

  prepare: async (context) => {
    context.signal?.throwIfAborted();
    if (context.direction === "up") {
      await context.database.reconcileTtlIndex({
        collectionName: "notificationoutboxes",
        indexName: "purgeAt_1",
        field: "purgeAt",
        expireAfterSeconds: 0,
      });
    } else {
      await context.database.dropIndexIfMatches({
        collectionName: "notificationoutboxes",
        indexName: "purgeAt_1",
        field: "purgeAt",
      });
    }
    context.signal?.throwIfAborted();
  },

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<OutboxRetentionDocument>(
        "notificationoutboxes",
      );
    let indexes: Array<{
      readonly name?: string;
      readonly key: Readonly<Record<string, unknown>>;
      readonly expireAfterSeconds?: unknown;
    }> = [];
    try {
      indexes = await collection.listIndexes().toArray();
    } catch (error) {
      const candidate = error as {
        readonly code?: unknown;
        readonly codeName?: unknown;
      };
      if (
        !error ||
        typeof error !== "object" ||
        (candidate.code !== 26 && candidate.codeName !== "NamespaceNotFound")
      ) {
        throw error;
      }
    }
    const indexReady = indexes.some((index) => {
      const entries = Object.entries(index.key);
      return (
        index.name === "purgeAt_1" &&
        entries.length === 1 &&
        entries[0]?.[0] === "purgeAt" &&
        entries[0]?.[1] === 1 &&
        index.expireAfterSeconds === 0
      );
    });

    let examined = 0;
    let mismatched = 0;
    let invalidTerminalTimestamp = 0;
    await collection
      .find(
        {},
        {
          projection: {
            status: 1,
            deliveredAt: 1,
            deadAt: 1,
            purgeAt: 1,
          },
        },
      )
      .forEach((document) => {
        context.signal?.throwIfAborted();
        examined += 1;
        let expected: Date | null = null;
        if (document.status === "delivered") {
          if (
            !(document.deliveredAt instanceof Date) ||
            Number.isNaN(document.deliveredAt.getTime())
          ) {
            invalidTerminalTimestamp += 1;
            mismatched += 1;
            return;
          }
          expected = new Date(
            document.deliveredAt.getTime() + 2_592_000_000,
          );
        } else if (document.status === "dead") {
          if (
            !(document.deadAt instanceof Date) ||
            Number.isNaN(document.deadAt.getTime())
          ) {
            invalidTerminalTimestamp += 1;
            mismatched += 1;
            return;
          }
          expected = new Date(document.deadAt.getTime() + 7_776_000_000);
        }
        if (
          !(document.purgeAt instanceof Date
            ? expected instanceof Date &&
              document.purgeAt.getTime() === expected.getTime()
            : document.purgeAt === expected)
        ) {
          mismatched += 1;
        }
      });

    return {
      summary:
        "Backfill active null purge clocks, terminal fixed-day clocks, and the absolute TTL index.",
      counts: {
        examined: examined + 1,
        matched: mismatched + Number(!indexReady),
        modified: mismatched + Number(!indexReady),
        skipped: examined - mismatched + Number(indexReady),
        errors: invalidTerminalTimestamp,
      },
      estimatedBatches: Math.max(1, Math.ceil(examined / context.batchSize)),
      warnings:
        invalidTerminalTimestamp === 0
          ? []
          : [
              {
                code: "NOTIFICATION_OUTBOX_TERMINAL_TIMESTAMP_INVALID",
                count: invalidTerminalTimestamp,
              },
            ],
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<OutboxRetentionDocument>(
        "notificationoutboxes",
      );
    const previous = context.checkpoint as RetentionCheckpoint | null;
    let highWatermark = previous?.highWatermark ?? null;
    const lastId = previous?.lastId ?? null;

    if (context.checkpoint === null) {
      const newest = await collection
        .aggregate<{ readonly cursorId?: unknown }>([
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
        ])
        .toArray();
      highWatermark =
        typeof newest[0]?.cursorId === "string" ? newest[0].cursorId : null;
    }

    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: { highWatermark: null, lastId: null },
        counts: {
          examined: 0,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }

    const idRangeExpression = {
      $and: [
        { $lte: ["$_id", { $toObjectId: highWatermark }] },
        ...(lastId === null
          ? []
          : [{ $gt: ["$_id", { $toObjectId: lastId }] }]),
      ],
    };
    const page = await collection
      .aggregate<OutboxRetentionDocument>([
        { $match: { $expr: idRangeExpression } },
        { $sort: { _id: 1 } },
        { $limit: context.batchSize + 1 },
        {
          $project: {
            __migrationCursorId: { $toString: "$_id" },
          },
        },
      ])
      .toArray();
    const batch = page.slice(0, context.batchSize);
    let matched = 0;
    let modified = 0;
    if (batch.length > 0) {
      const batchFilter = {
        _id: { $in: batch.map((document) => document._id) },
      } as unknown as Parameters<typeof collection.updateMany>[0];
      const result = await collection.updateMany(
        batchFilter,
        [
          {
            $set: {
              purgeAt: {
                $switch: {
                  branches: [
                    {
                      case: {
                        $and: [
                          { $eq: ["$status", "delivered"] },
                          { $eq: [{ $type: "$deliveredAt" }, "date"] },
                        ],
                      },
                      then: { $add: ["$deliveredAt", 2_592_000_000] },
                    },
                    {
                      case: {
                        $and: [
                          { $eq: ["$status", "dead"] },
                          { $eq: [{ $type: "$deadAt" }, "date"] },
                        ],
                      },
                      then: { $add: ["$deadAt", 7_776_000_000] },
                    },
                  ],
                  default: null,
                },
              },
            },
          },
        ],
      );
      if (result.matchedCount !== batch.length) {
        throw new Error(
          "Notification outbox retention batch changed during migration.",
        );
      }
      matched = result.matchedCount;
      modified = result.modifiedCount;
    }

    const nextLastId =
      batch.length === 0
        ? lastId
        : typeof batch[batch.length - 1]?.__migrationCursorId === "string"
          ? (batch[batch.length - 1]?.__migrationCursorId as string)
          : lastId;
    const checkpoint: RetentionCheckpoint = {
      highWatermark,
      lastId: nextLastId,
    };
    return page.length <= context.batchSize
      ? {
          done: true,
          checkpoint,
          counts: {
            examined: batch.length,
            matched,
            modified,
            skipped: batch.length - modified,
            errors: 0,
          },
        }
      : {
          done: false,
          checkpoint,
          counts: {
            examined: batch.length,
            matched,
            modified,
            skipped: batch.length - modified,
            errors: 0,
          },
        };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<OutboxRetentionDocument>(
        "notificationoutboxes",
      );
    const previous = context.checkpoint as RetentionCheckpoint | null;
    let highWatermark = previous?.highWatermark ?? null;
    const lastId = previous?.lastId ?? null;

    if (context.checkpoint === null) {
      const newest = await collection
        .aggregate<{ readonly cursorId?: unknown }>([
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
        ])
        .toArray();
      highWatermark =
        typeof newest[0]?.cursorId === "string" ? newest[0].cursorId : null;
    }
    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: { highWatermark: null, lastId: null },
        counts: {
          examined: 0,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }

    const idRangeExpression = {
      $and: [
        { $lte: ["$_id", { $toObjectId: highWatermark }] },
        ...(lastId === null
          ? []
          : [{ $gt: ["$_id", { $toObjectId: lastId }] }]),
      ],
    };
    const page = await collection
      .aggregate<OutboxRetentionDocument>([
        { $match: { $expr: idRangeExpression } },
        { $sort: { _id: 1 } },
        { $limit: context.batchSize + 1 },
        {
          $project: {
            __migrationCursorId: { $toString: "$_id" },
          },
        },
      ])
      .toArray();
    const batch = page.slice(0, context.batchSize);
    let matched = 0;
    let modified = 0;
    if (batch.length > 0) {
      const batchFilter = {
        _id: { $in: batch.map((document) => document._id) },
        purgeAt: { $exists: true },
      } as unknown as Parameters<typeof collection.updateMany>[0];
      const result = await collection.updateMany(
        batchFilter,
        { $unset: { purgeAt: "" } },
      );
      matched = result.matchedCount;
      modified = result.modifiedCount;
    }

    const nextLastId =
      batch.length === 0
        ? lastId
        : typeof batch[batch.length - 1]?.__migrationCursorId === "string"
          ? (batch[batch.length - 1]?.__migrationCursorId as string)
          : lastId;
    const checkpoint: RetentionCheckpoint = {
      highWatermark,
      lastId: nextLastId,
    };
    const result = {
      checkpoint,
      counts: {
        examined: batch.length,
        matched,
        modified,
        skipped: batch.length - modified,
        errors: 0,
      },
    };
    return page.length <= context.batchSize
      ? { done: true, ...result }
      : { done: false, ...result };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<OutboxRetentionDocument>(
        "notificationoutboxes",
      );
    let indexes: Array<{
      readonly name?: string;
      readonly key: Readonly<Record<string, unknown>>;
      readonly expireAfterSeconds?: unknown;
    }> = [];
    try {
      indexes = await collection.listIndexes().toArray();
    } catch (error) {
      const candidate = error as {
        readonly code?: unknown;
        readonly codeName?: unknown;
      };
      if (
        !error ||
        typeof error !== "object" ||
        (candidate.code !== 26 && candidate.codeName !== "NamespaceNotFound")
      ) {
        throw error;
      }
    }
    const matchingIndexes = indexes.filter((index) => {
      const entries = Object.entries(index.key);
      return (
        index.name === "purgeAt_1" &&
        entries.length === 1 &&
        entries[0]?.[0] === "purgeAt" &&
        entries[0]?.[1] === 1 &&
        index.expireAfterSeconds === 0
      );
    }).length;

    if (context.direction === "down") {
      const remaining = await collection.countDocuments({
        purgeAt: { $exists: true },
      });
      const ok = matchingIndexes === 0 && remaining === 0;
      return {
        ok,
        summary: "Verified NotificationOutbox retention rollback state.",
        counts: {
          examined: remaining + 1,
          matched: remaining + matchingIndexes,
          modified: 0,
          skipped: 0,
          errors: ok ? 0 : matchingIndexes + remaining,
        },
      };
    }

    let examined = 0;
    let invalid = 0;
    await collection
      .find(
        {},
        {
          projection: {
            status: 1,
            deliveredAt: 1,
            deadAt: 1,
            purgeAt: 1,
          },
        },
      )
      .forEach((document) => {
        context.signal?.throwIfAborted();
        examined += 1;
        let expected: Date | null = null;
        if (document.status === "delivered") {
          if (
            !(document.deliveredAt instanceof Date) ||
            Number.isNaN(document.deliveredAt.getTime())
          ) {
            invalid += 1;
            return;
          }
          expected = new Date(
            document.deliveredAt.getTime() + 2_592_000_000,
          );
        } else if (document.status === "dead") {
          if (
            !(document.deadAt instanceof Date) ||
            Number.isNaN(document.deadAt.getTime())
          ) {
            invalid += 1;
            return;
          }
          expected = new Date(document.deadAt.getTime() + 7_776_000_000);
        } else if (
          document.status !== "pending" &&
          document.status !== "processing"
        ) {
          invalid += 1;
          return;
        }
        const matches =
          document.purgeAt instanceof Date
            ? expected instanceof Date &&
              document.purgeAt.getTime() === expected.getTime()
            : document.purgeAt === expected;
        if (!matches) invalid += 1;
      });
    const ok = matchingIndexes === 1 && invalid === 0;
    return {
      ok,
      summary:
        "Verified NotificationOutbox fixed-day purge clocks and absolute TTL index.",
      counts: {
        examined: examined + 1,
        matched: examined - invalid + matchingIndexes,
        modified: 0,
        skipped: invalid,
        errors: invalid + (matchingIndexes === 1 ? 0 : 1),
      },
    };
  },
} satisfies MigrationSourceDefinition;
