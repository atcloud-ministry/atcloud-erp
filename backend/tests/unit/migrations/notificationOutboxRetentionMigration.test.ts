import { describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260918_004_enforce-notification-outbox-retention";
import { normalizeMigrationPlan } from "../../../src/services/migrations/MigrationValidation";

describe("NotificationOutbox retention migration", () => {
  it("creates and removes the absolute purgeAt TTL index", async () => {
    const reconcileTtlIndex = vi.fn().mockResolvedValue(undefined);
    const dropIndexIfMatches = vi.fn().mockResolvedValue(undefined);

    await migration.prepare({
      direction: "up",
      database: { reconcileTtlIndex },
    } as never);
    await migration.prepare({
      direction: "down",
      database: { dropIndexIfMatches },
    } as never);

    expect(reconcileTtlIndex).toHaveBeenCalledWith({
      collectionName: "notificationoutboxes",
      indexName: "purgeAt_1",
      field: "purgeAt",
      expireAfterSeconds: 0,
    });
    expect(dropIndexIfMatches).toHaveBeenCalledWith({
      collectionName: "notificationoutboxes",
      indexName: "purgeAt_1",
      field: "purgeAt",
    });
  });

  it("produces valid dry-run counts for a fresh namespace", async () => {
    const collection = {
      listIndexes: vi.fn(() => ({
        toArray: vi.fn().mockRejectedValue(
          Object.assign(new Error("namespace missing"), { code: 26 }),
        ),
      })),
      find: vi.fn(() => ({ forEach: vi.fn().mockResolvedValue(undefined) })),
    };

    const plan = await migration.plan({
      batchSize: 100,
      database: { collection: vi.fn(() => collection) },
    } as never);

    expect(normalizeMigrationPlan(plan)).toMatchObject({
      counts: {
        examined: 1,
        matched: 1,
        modified: 1,
        skipped: 0,
        errors: 0,
      },
      estimatedBatches: 1,
    });
  });

  it("backfills one bounded page with fixed millisecond retention clocks", async () => {
    const updateMany = vi.fn().mockResolvedValue({
      matchedCount: 2,
      modifiedCount: 2,
    });
    const aggregate = vi
      .fn()
      .mockReturnValueOnce({
        toArray: vi
          .fn()
          .mockResolvedValue([{ cursorId: "66e900000000000000000002" }]),
      })
      .mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([
          {
            _id: "first-id",
            __migrationCursorId: "66e900000000000000000001",
          },
          {
            _id: "second-id",
            __migrationCursorId: "66e900000000000000000002",
          },
        ]),
      });
    const database = {
      collection: vi.fn(() => ({ aggregate, updateMany })),
    };

    await expect(
      migration.up({
        database,
        checkpoint: null,
        appliedCheckpoint: null,
        batchSize: 2,
        runId: "migration-run",
        direction: "up",
      } as never),
    ).resolves.toEqual({
      done: true,
      checkpoint: {
        highWatermark: "66e900000000000000000002",
        lastId: "66e900000000000000000002",
      },
      counts: {
        examined: 2,
        matched: 2,
        modified: 2,
        skipped: 0,
        errors: 0,
      },
    });

    const [filter, pipeline] = updateMany.mock.calls[0];
    expect(filter).toEqual({ _id: { $in: ["first-id", "second-id"] } });
    expect(pipeline).toEqual([
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
    ]);
  });

  it("verifies exact clocks and the absolute TTL index", async () => {
    const deliveredAt = new Date("2026-09-01T00:00:00.000Z");
    const deadAt = new Date("2026-09-02T00:00:00.000Z");
    const documents = [
      { status: "pending", purgeAt: null },
      {
        status: "delivered",
        deliveredAt,
        purgeAt: new Date(deliveredAt.getTime() + 2_592_000_000),
      },
      {
        status: "dead",
        deadAt,
        purgeAt: new Date(deadAt.getTime() + 7_776_000_000),
      },
    ];
    const collection = {
      listIndexes: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([
          { name: "_id_", key: { _id: 1 } },
          {
            name: "purgeAt_1",
            key: { purgeAt: 1 },
            expireAfterSeconds: 0,
          },
        ]),
      })),
      find: vi.fn(() => ({
        forEach: vi.fn(async (visitor) => {
          documents.forEach(visitor);
        }),
      })),
    };

    await expect(
      migration.verify({
        direction: "up",
        database: { collection: vi.fn(() => collection) },
      } as never),
    ).resolves.toMatchObject({
      ok: true,
      counts: { matched: 4, errors: 0 },
    });
  });
});
