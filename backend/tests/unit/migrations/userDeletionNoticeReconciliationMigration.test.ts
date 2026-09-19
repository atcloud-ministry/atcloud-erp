import { afterEach, describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260918_005_reconcile-user-deletion-notices";

const TARGET = {
  type: "user_management",
  title: "User Account Deleted",
} as const;
const GENERIC_CONTENT = "A user account was permanently deleted.";
const REFERENCE_TIME = "2026-09-18T12:00:00.000Z";
const HIGH_WATERMARK = "66e900000000000000000003";

describe("User account-deletion notice reconciliation migration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes invalid and expired notices, de-identifies retained notices, and leaves non-target records unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(REFERENCE_TIME));

    const invalidId = "66e900000000000000000001";
    const expiredId = "66e900000000000000000002";
    const retainedId = HIGH_WATERMARK;
    const unrelatedId = "66e900000000000000000004";
    const documents: Array<Record<string, unknown>> = [
      {
        _id: invalidId,
        ...TARGET,
        createdAt: "not-a-date",
        content: "Deleted Person One (person@example.com)",
      },
      {
        _id: expiredId,
        ...TARGET,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        content: "Deleted Person Two (@person-two)",
      },
      {
        _id: retainedId,
        ...TARGET,
        createdAt: new Date("2026-09-10T00:00:00.000Z"),
        content: "Deleted Person Three (person-three@example.com)",
        hideCreator: false,
        metadata: { targetEmail: "person-three@example.com" },
        targetUserId: "deleted-user-id",
      },
      {
        _id: unrelatedId,
        type: "announcement",
        title: "User Account Deleted",
        createdAt: new Date("2026-09-10T00:00:00.000Z"),
        content: "Unrelated announcement content",
        metadata: { keep: true },
        targetUserId: "keep-this-reference",
      },
    ];

    const aggregate = vi
      .fn()
      .mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([{ cursorId: retainedId }]),
      })
      .mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue(
          documents
            .filter(
              (document) =>
                document.type === TARGET.type &&
                document.title === TARGET.title,
            )
            .map((document) => ({
              _id: document._id,
              createdAt: document.createdAt,
              __migrationCursorId: document._id,
            })),
        ),
      });
    const deleteMany = vi.fn(async (filter: Record<string, unknown>) => {
      expect(filter).toMatchObject(TARGET);
      const ids = new Set(
        ((filter._id as { $in: unknown[] }).$in ?? []).map(String),
      );
      let deletedCount = 0;
      for (let index = documents.length - 1; index >= 0; index -= 1) {
        const document = documents[index]!;
        if (
          document.type === TARGET.type &&
          document.title === TARGET.title &&
          ids.has(String(document._id))
        ) {
          documents.splice(index, 1);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    });
    const updateMany = vi.fn(
      async (
        filter: Record<string, unknown>,
        pipeline: Array<Record<string, unknown>>,
      ) => {
        expect(filter).toMatchObject(TARGET);
        expect(pipeline).toEqual([
          {
            $set: {
              content: GENERIC_CONTENT,
              hideCreator: true,
              expiresAt: { $add: ["$createdAt", 2_592_000_000] },
            },
          },
          { $unset: ["metadata", "targetUserId"] },
        ]);
        const ids = new Set(
          ((filter._id as { $in: unknown[] }).$in ?? []).map(String),
        );
        let matchedCount = 0;
        for (const document of documents) {
          if (
            document.type !== TARGET.type ||
            document.title !== TARGET.title ||
            !ids.has(String(document._id))
          ) {
            continue;
          }
          matchedCount += 1;
          document.content = GENERIC_CONTENT;
          document.hideCreator = true;
          document.expiresAt = new Date(
            (document.createdAt as Date).getTime() + 2_592_000_000,
          );
          delete document.metadata;
          delete document.targetUserId;
        }
        return { matchedCount, modifiedCount: matchedCount };
      },
    );
    const database = {
      collection: vi.fn(() => ({ aggregate, deleteMany, updateMany })),
    };

    await expect(
      migration.up({
        database,
        checkpoint: null,
        appliedCheckpoint: null,
        batchSize: 10,
        runId: "migration-run",
        direction: "up",
      } as never),
    ).resolves.toEqual({
      done: true,
      checkpoint: {
        highWatermark: retainedId,
        lastId: retainedId,
        referenceTime: REFERENCE_TIME,
      },
      counts: {
        examined: 3,
        matched: 3,
        modified: 3,
        skipped: 0,
        errors: 0,
      },
    });

    expect(documents.map((document) => document._id)).not.toContain(invalidId);
    expect(documents.map((document) => document._id)).not.toContain(expiredId);
    expect(documents.find((document) => document._id === retainedId)).toEqual({
      _id: retainedId,
      ...TARGET,
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
      content: GENERIC_CONTENT,
      hideCreator: true,
      expiresAt: new Date("2026-10-10T00:00:00.000Z"),
    });
    expect(documents.find((document) => document._id === unrelatedId)).toEqual({
      _id: unrelatedId,
      type: "announcement",
      title: "User Account Deleted",
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
      content: "Unrelated announcement content",
      metadata: { keep: true },
      targetUserId: "keep-this-reference",
    });

    expect(aggregate.mock.calls[0]?.[0]).toEqual([
      { $match: TARGET },
      { $sort: { _id: -1 } },
      { $limit: 1 },
      { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
    ]);
    expect(aggregate.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([{ $limit: 11 }]),
    );
  });

  it("plans bounded batches and reports the irreversible changes", async () => {
    const countDocuments = vi
      .fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    await expect(
      migration.plan({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        batchSize: 2,
      } as never),
    ).resolves.toMatchObject({
      counts: {
        examined: 4,
        matched: 3,
        modified: 3,
        skipped: 1,
        errors: 0,
      },
      estimatedBatches: 2,
      warnings: [
        {
          code: "USER_DELETION_NOTICE_PII_PURGE_IRREVERSIBLE",
          count: 3,
        },
        {
          code: "USER_DELETION_NOTICE_DELETE_IRREVERSIBLE",
          count: 2,
        },
      ],
    });

    expect(countDocuments.mock.calls[0]?.[0]).toEqual(TARGET);
    expect(countDocuments.mock.calls[1]?.[0]).toMatchObject(TARGET);
    expect(countDocuments.mock.calls[2]?.[0]).toMatchObject(TARGET);
  });

  it("verifies only the bounded pre-migration population with a valid expression query", async () => {
    const countDocuments = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    const appliedCheckpoint = {
      highWatermark: HIGH_WATERMARK,
      lastId: HIGH_WATERMARK,
      referenceTime: REFERENCE_TIME,
    };

    await expect(
      migration.verify({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        direction: "up",
        checkpoint: appliedCheckpoint,
        appliedCheckpoint,
        batchSize: 100,
      } as never),
    ).resolves.toMatchObject({
      ok: true,
      counts: { examined: 2, matched: 2, errors: 0 },
    });

    const invalidQuery = countDocuments.mock.calls[1]?.[0] as Record<
      string,
      unknown
    >;
    expect(invalidQuery).toMatchObject(TARGET);
    expect(invalidQuery).not.toHaveProperty("$and");
    expect(invalidQuery.$expr).toEqual({
      $and: [
        { $lte: ["$_id", { $toObjectId: HIGH_WATERMARK }] },
        expect.objectContaining({ $cond: expect.any(Array) }),
      ],
    });
  });

  it("fails verification when a bounded legacy notice is still unsafe", async () => {
    const countDocuments = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const appliedCheckpoint = {
      highWatermark: HIGH_WATERMARK,
      lastId: HIGH_WATERMARK,
      referenceTime: REFERENCE_TIME,
    };

    await expect(
      migration.verify({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        direction: "up",
        checkpoint: appliedCheckpoint,
        appliedCheckpoint,
        batchSize: 100,
      } as never),
    ).resolves.toMatchObject({
      ok: false,
      counts: { examined: 2, matched: 1, errors: 1 },
    });
  });

  it("keeps the privacy changes during the intentionally irreversible rollback", async () => {
    await expect(
      migration.down({ signal: undefined } as never),
    ).resolves.toEqual({
      done: true,
      checkpoint: null,
      counts: {
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
    });
  });

  it("treats only NamespaceNotFound as an empty collection", async () => {
    const missing = Object.assign(new Error("namespace missing"), {
      code: 26,
      codeName: "NamespaceNotFound",
    });
    const countDocuments = vi.fn().mockRejectedValue(missing);

    await expect(
      migration.plan({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        batchSize: 100,
      } as never),
    ).resolves.toMatchObject({ counts: { examined: 0, errors: 0 } });
    await expect(
      migration.up({
        database: {
          collection: vi.fn(() => ({
            aggregate: vi.fn(() => ({
              toArray: vi.fn().mockRejectedValue(missing),
            })),
          })),
        },
        checkpoint: null,
        appliedCheckpoint: null,
        batchSize: 100,
        runId: "migration-run",
        direction: "up",
      } as never),
    ).resolves.toMatchObject({ done: true, counts: { examined: 0, errors: 0 } });
    await expect(
      migration.verify({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        direction: "up",
        checkpoint: null,
        appliedCheckpoint: {
          highWatermark: HIGH_WATERMARK,
          lastId: HIGH_WATERMARK,
          referenceTime: REFERENCE_TIME,
        },
        batchSize: 100,
      } as never),
    ).resolves.toMatchObject({ ok: true, counts: { examined: 0, errors: 0 } });
  });

  it("propagates non-namespace errors from plan, up, and verify", async () => {
    const unauthorized = Object.assign(new Error("not authorized"), {
      code: 13,
      codeName: "Unauthorized",
    });
    const countDocuments = vi.fn().mockRejectedValue(unauthorized);

    await expect(
      migration.plan({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        batchSize: 100,
      } as never),
    ).rejects.toBe(unauthorized);
    await expect(
      migration.up({
        database: {
          collection: vi.fn(() => ({
            aggregate: vi.fn(() => ({
              toArray: vi.fn().mockRejectedValue(unauthorized),
            })),
          })),
        },
        checkpoint: null,
        appliedCheckpoint: null,
        batchSize: 100,
        runId: "migration-run",
        direction: "up",
      } as never),
    ).rejects.toBe(unauthorized);
    await expect(
      migration.verify({
        database: { collection: vi.fn(() => ({ countDocuments })) },
        direction: "up",
        checkpoint: null,
        appliedCheckpoint: {
          highWatermark: HIGH_WATERMARK,
          lastId: HIGH_WATERMARK,
          referenceTime: REFERENCE_TIME,
        },
        batchSize: 100,
      } as never),
    ).rejects.toBe(unauthorized);
  });
});
