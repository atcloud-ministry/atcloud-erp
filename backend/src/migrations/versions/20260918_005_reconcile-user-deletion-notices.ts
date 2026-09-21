import type { MigrationSourceDefinition } from "../types";

type UserDeletionNoticeCheckpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
  readonly referenceTime: string;
};

type UserDeletionNoticeDocument = {
  readonly _id?: unknown;
  readonly createdAt?: unknown;
  readonly __migrationCursorId?: unknown;
};

export const migration = {
  id: "20260918_005_reconcile-user-deletion-notices",
  description:
    "Delete expired legacy account-deletion notices and de-identify retained notices for fixed 30-day retention.",

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<UserDeletionNoticeDocument>("messages");
    const target = {
      type: "user_management",
      title: "User Account Deleted",
    };
    const genericContent = "A user account was permanently deleted.";
    const retentionMs = 2_592_000_000;
    const referenceTime = new Date();

    let total = 0;
    let deleteCandidates = 0;
    let compliantActive = 0;
    try {
      total = await collection.countDocuments(target);
      deleteCandidates = await collection.countDocuments({
        ...target,
        $expr: {
          $cond: [
            { $eq: [{ $type: "$createdAt" }, "date"] },
            {
              $lte: [
                { $add: ["$createdAt", retentionMs] },
                referenceTime,
              ],
            },
            true,
          ],
        },
      });
      compliantActive = await collection.countDocuments({
        ...target,
        $expr: {
          $cond: [
            { $eq: [{ $type: "$createdAt" }, "date"] },
            {
              $and: [
                {
                  $gt: [
                    { $add: ["$createdAt", retentionMs] },
                    referenceTime,
                  ],
                },
                { $eq: ["$content", genericContent] },
                { $eq: ["$hideCreator", true] },
                { $eq: [{ $type: "$metadata" }, "missing"] },
                { $eq: [{ $type: "$targetUserId" }, "missing"] },
                {
                  $eq: [
                    "$expiresAt",
                    { $add: ["$createdAt", retentionMs] },
                  ],
                },
              ],
            },
            false,
          ],
        },
      });
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

    const safeCompliantActive = Math.min(total, compliantActive);
    const changes = total - safeCompliantActive;
    const safeDeleteCandidates = Math.min(changes, deleteCandidates);
    return {
      summary:
        "Delete expired or invalid account-deletion notices and de-identify the retained notices.",
      counts: {
        examined: total,
        matched: changes,
        modified: changes,
        skipped: safeCompliantActive,
        errors: 0,
      },
      estimatedBatches: Math.max(1, Math.ceil(total / context.batchSize)),
      warnings:
        changes === 0
          ? []
          : [
              {
                code: "USER_DELETION_NOTICE_PII_PURGE_IRREVERSIBLE",
                count: changes,
              },
              {
                code: "USER_DELETION_NOTICE_DELETE_IRREVERSIBLE",
                count: safeDeleteCandidates,
              },
            ],
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<UserDeletionNoticeDocument>("messages");
    const target = {
      type: "user_management",
      title: "User Account Deleted",
    };
    const genericContent = "A user account was permanently deleted.";
    const retentionMs = 2_592_000_000;
    const previous = context.checkpoint as UserDeletionNoticeCheckpoint | null;
    let highWatermark = previous?.highWatermark ?? null;
    const lastId = previous?.lastId ?? null;
    const referenceTime = previous?.referenceTime ?? new Date().toISOString();
    const referenceDate = new Date(referenceTime);
    if (Number.isNaN(referenceDate.getTime())) {
      throw new Error("User-deletion notice checkpoint time is invalid.");
    }

    if (context.checkpoint === null) {
      let newest: Array<{ readonly cursorId?: unknown }> = [];
      try {
        newest = await collection
          .aggregate<{ readonly cursorId?: unknown }>([
            { $match: target },
            { $sort: { _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
          ])
          .toArray();
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
      highWatermark =
        typeof newest[0]?.cursorId === "string" ? newest[0].cursorId : null;
    }

    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: {
          highWatermark: null,
          lastId: null,
          referenceTime,
        },
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
    let page: UserDeletionNoticeDocument[] = [];
    try {
      page = await collection
        .aggregate<UserDeletionNoticeDocument>([
          { $match: target },
          { $match: { $expr: idRangeExpression } },
          { $sort: { _id: 1 } },
          { $limit: context.batchSize + 1 },
          {
            $project: {
              createdAt: 1,
              __migrationCursorId: { $toString: "$_id" },
            },
          },
        ])
        .toArray();
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

    const batch = page.slice(0, context.batchSize);
    const deleteIds: unknown[] = [];
    const retainIds: unknown[] = [];
    for (const document of batch) {
      const createdAt = document.createdAt;
      if (
        !(createdAt instanceof Date) ||
        Number.isNaN(createdAt.getTime()) ||
        createdAt.getTime() + retentionMs <= referenceDate.getTime()
      ) {
        deleteIds.push(document._id);
      } else {
        retainIds.push(document._id);
      }
    }

    let matched = 0;
    let modified = 0;
    if (deleteIds.length > 0) {
      const deletion = await collection.deleteMany({
        ...target,
        _id: { $in: deleteIds },
      } as never);
      if (deletion.deletedCount !== deleteIds.length) {
        throw new Error(
          "User-deletion notice deletion batch changed during migration.",
        );
      }
      matched += deletion.deletedCount;
      modified += deletion.deletedCount;
    }
    if (retainIds.length > 0) {
      const update = await collection.updateMany(
        {
          ...target,
          _id: { $in: retainIds },
        } as never,
        [
          {
            $set: {
              content: genericContent,
              hideCreator: true,
              expiresAt: { $add: ["$createdAt", retentionMs] },
            },
          },
          { $unset: ["metadata", "targetUserId"] },
        ],
      );
      if (update.matchedCount !== retainIds.length) {
        throw new Error(
          "User-deletion notice update batch changed during migration.",
        );
      }
      matched += update.matchedCount;
      modified += update.modifiedCount;
    }

    const nextLastId =
      batch.length === 0
        ? lastId
        : typeof batch[batch.length - 1]?.__migrationCursorId === "string"
          ? (batch[batch.length - 1]?.__migrationCursorId as string)
          : lastId;
    const checkpoint: UserDeletionNoticeCheckpoint = {
      highWatermark,
      lastId: nextLastId,
      referenceTime,
    };
    return {
      done: page.length <= context.batchSize,
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
    // Deleted records and purged PII are intentionally not recoverable.
    return {
      done: true,
      checkpoint: null,
      counts: {
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const collection =
      context.database.collection<UserDeletionNoticeDocument>("messages");
    const target = {
      type: "user_management",
      title: "User Account Deleted",
    };
    const genericContent = "A user account was permanently deleted.";
    const retentionMs = 2_592_000_000;
    const applied =
      context.appliedCheckpoint as UserDeletionNoticeCheckpoint | null;
    const highWatermark = applied?.highWatermark ?? null;
    const referenceTime = applied?.referenceTime;
    if (highWatermark === null) {
      return {
        ok: true,
        summary:
          context.direction === "down"
            ? "Verified irreversible account-deletion notice de-identification remains in place."
            : "Verified no pre-existing account-deletion notices required reconciliation.",
        counts: {
          examined: 0,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }
    const referenceDate =
      typeof referenceTime === "string" ? new Date(referenceTime) : null;
    if (referenceDate === null || Number.isNaN(referenceDate.getTime())) {
      throw new Error("User-deletion notice applied checkpoint is invalid.");
    }
    const boundedTarget = {
      ...target,
      $expr: { $lte: ["$_id", { $toObjectId: highWatermark }] },
    };
    let total = 0;
    let invalid = 0;
    try {
      total = await collection.countDocuments(boundedTarget);
      invalid = await collection.countDocuments({
        ...target,
        $expr: {
          $and: [
            boundedTarget.$expr,
            {
              $cond: [
                { $eq: [{ $type: "$createdAt" }, "date"] },
                {
                  $or: [
                    {
                      $lte: [
                        { $add: ["$createdAt", retentionMs] },
                        referenceDate,
                      ],
                    },
                    { $ne: ["$content", genericContent] },
                    { $ne: ["$hideCreator", true] },
                    { $ne: [{ $type: "$metadata" }, "missing"] },
                    { $ne: [{ $type: "$targetUserId" }, "missing"] },
                    {
                      $ne: [
                        "$expiresAt",
                        { $add: ["$createdAt", retentionMs] },
                      ],
                    },
                  ],
                },
                true,
              ],
            },
          ],
        },
      });
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
    const ok = invalid === 0;
    return {
      ok,
      summary:
        context.direction === "down"
          ? "Verified irreversible account-deletion notice de-identification remains in place."
          : "Verified retained account-deletion notices are de-identified with fixed 30-day expiry.",
      counts: {
        examined: total,
        matched: Math.max(0, total - invalid),
        modified: 0,
        skipped: 0,
        errors: invalid,
      },
    };
  },
} satisfies MigrationSourceDefinition;
