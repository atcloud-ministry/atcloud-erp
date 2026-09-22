import type { MigrationSourceDefinition } from "../types";

type ConfirmedHelpClosureCheckpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
  readonly referenceTime: string;
};

type HelpRequestDocument = {
  readonly _id?: unknown;
  readonly revision?: unknown;
  readonly status?: unknown;
  readonly hasBeenAccepted?: unknown;
  readonly latestOutcomeSubmissionId?: unknown;
  readonly latestOutcomeStatus?: unknown;
  readonly latestOutcomeDueAt?: unknown;
  readonly conversationId?: unknown;
  readonly closedAt?: unknown;
  readonly lifecycleTimeline?: unknown;
  readonly __migrationCursorId?: unknown;
};

type OutcomeDocument = {
  readonly _id?: unknown;
};

type ConversationDocument = {
  readonly _id?: unknown;
  readonly revision?: unknown;
  readonly helpRequestId?: unknown;
};

/**
 * Closes records created before provider/automatic outcome confirmation became
 * a terminal request transition. It is intentionally irreversible: reopening
 * a confirmed Help Request would recreate an active uniqueness claim.
 */
export const migration = {
  id: "20260921_001_reconcile-confirmed-alumni-help-closures",
  description:
    "Close legacy confirmed Alumni Help Requests and begin their seven-day Chat Room grace period.",

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const requests = context.database.collection<HelpRequestDocument>(
      "alumni_help_requests",
    );
    const candidateFilter = {
      status: { $in: ["accepted", "in_progress", "completed"] },
      hasBeenAccepted: true,
      latestOutcomeStatus: "confirmed",
      latestOutcomeSubmissionId: { $type: "objectId" },
      conversationId: { $type: "objectId" },
      closedAt: null,
    };
    const candidates = await requests.countDocuments(candidateFilter as never);
    return {
      summary:
        "Close legacy confirmed Help Requests and keep each private Room writable for seven days.",
      counts: {
        examined: candidates,
        matched: candidates,
        modified: candidates,
        skipped: 0,
        errors: 0,
      },
      estimatedBatches: Math.max(1, Math.ceil(candidates / context.batchSize)),
      warnings:
        candidates > 0
          ? [
              {
                code: "ALUMNI_HELP_CONFIRMED_REQUEST_RECONCILIATION",
                count: candidates,
              },
            ]
          : [],
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    const requests = context.database.collection<HelpRequestDocument>(
      "alumni_help_requests",
    );
    const outcomes = context.database.collection<OutcomeDocument>(
      "alumni_help_outcome_submissions",
    );
    const rooms = context.database.collection<ConversationDocument>(
      "conversations",
    );
    const candidateFilter = {
      status: { $in: ["accepted", "in_progress", "completed"] },
      hasBeenAccepted: true,
      latestOutcomeStatus: "confirmed",
      latestOutcomeSubmissionId: { $type: "objectId" },
      conversationId: { $type: "objectId" },
      closedAt: null,
    };
    const validDate = (value: unknown): value is Date =>
      value instanceof Date && !Number.isNaN(value.getTime());
    const validRevision = (value: unknown): value is number =>
      Number.isSafeInteger(value) && Number(value) >= 0;
    const cursorId = (value: unknown): string | null =>
      typeof value === "string" && /^[a-f\d]{24}$/i.test(value)
        ? value.toLowerCase()
        : null;
    const addUtcCalendarMonths = (value: Date, months: number): Date => {
      const target = new Date(
        Date.UTC(
          value.getUTCFullYear(),
          value.getUTCMonth() + months,
          1,
          value.getUTCHours(),
          value.getUTCMinutes(),
          value.getUTCSeconds(),
          value.getUTCMilliseconds(),
        ),
      );
      const lastDay = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
      return target;
    };
    const acceptedRequestPurgeAt = (
      closedAt: Date,
      outcomeDueAt: unknown,
    ): Date => {
      const requestRetention = addUtcCalendarMonths(closedAt, 12);
      if (!validDate(outcomeDueAt)) return requestRetention;
      const outcomeRetention = new Date(
        outcomeDueAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
      );
      return outcomeRetention > requestRetention
        ? outcomeRetention
        : requestRetention;
    };
    const previous = context.checkpoint as ConfirmedHelpClosureCheckpoint | null;
    const referenceTime = previous?.referenceTime ?? new Date().toISOString();
    const referenceDate = new Date(referenceTime);
    if (!validDate(referenceDate)) {
      throw new Error("Confirmed Help closure migration checkpoint time is invalid.");
    }

    let highWatermark = previous?.highWatermark ?? null;
    const lastId = previous?.lastId ?? null;
    if (context.checkpoint === null) {
      const newest = await requests
        .aggregate<{ readonly cursorId?: unknown }>([
          { $match: candidateFilter },
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
        ])
        .toArray();
      highWatermark = cursorId(newest[0]?.cursorId);
    }
    if (
      (highWatermark !== null && !cursorId(highWatermark)) ||
      (lastId !== null && !cursorId(lastId))
    ) {
      throw new Error("Confirmed Help closure migration checkpoint cursor is invalid.");
    }
    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: { highWatermark: null, lastId: null, referenceTime },
        counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
      };
    }

    const page = await requests
      .aggregate<HelpRequestDocument>([
        { $match: candidateFilter },
        {
          $match: {
            $expr: {
              $and: [
                { $lte: ["$_id", { $toObjectId: highWatermark }] },
                ...(lastId === null
                  ? []
                  : [{ $gt: ["$_id", { $toObjectId: lastId }] }]),
              ],
            },
          },
        },
        { $sort: { _id: 1 } },
        { $limit: context.batchSize + 1 },
        {
          $project: {
            revision: 1,
            status: 1,
            hasBeenAccepted: 1,
            latestOutcomeSubmissionId: 1,
            latestOutcomeStatus: 1,
            latestOutcomeDueAt: 1,
            conversationId: 1,
            closedAt: 1,
            lifecycleTimeline: 1,
            __migrationCursorId: { $toString: "$_id" },
          },
        },
      ])
      .toArray();
    const batch = page.slice(0, context.batchSize);
    let modified = 0;

    for (const request of batch) {
      context.signal?.throwIfAborted();
      const requestId = request._id;
      const outcomeId = request.latestOutcomeSubmissionId;
      const conversationId = request.conversationId;
      const timeline = request.lifecycleTimeline;
      if (
        requestId == null ||
        outcomeId == null ||
        conversationId == null ||
        !validRevision(request.revision) ||
        !Array.isArray(timeline) ||
        timeline.length === 0 ||
        !["accepted", "in_progress", "completed"].includes(
          request.status as string,
        ) ||
        request.hasBeenAccepted !== true ||
        request.latestOutcomeStatus !== "confirmed" ||
        request.closedAt != null
      ) {
        throw new Error("Confirmed Help closure migration encountered an invalid request.");
      }
      const lastTimelineEntry = timeline[timeline.length - 1] as {
        readonly occurredAt?: unknown;
      };
      if (!validDate(lastTimelineEntry?.occurredAt)) {
        throw new Error("Confirmed Help closure migration requires a valid final lifecycle event.");
      }
      const closedAt = new Date(
        Math.max(referenceDate.getTime(), lastTimelineEntry.occurredAt.getTime()),
      );
      const purgeAt = acceptedRequestPurgeAt(closedAt, request.latestOutcomeDueAt);
      const writeAccessEndsAt = new Date(
        closedAt.getTime() + 7 * 24 * 60 * 60 * 1_000,
      );
      const [outcome, room] = await Promise.all([
        outcomes.findOne({
          _id: outcomeId,
          helpRequestId: requestId,
          status: "confirmed",
        } as never),
        rooms.findOne({
          _id: conversationId,
          kind: "alumni_help",
          status: "current",
          helpRequestId: requestId,
          writeAccessEndsAt: null,
        } as never),
      ]);
      if (!outcome || !room || !validRevision(room.revision)) {
        throw new Error("Confirmed Help closure migration encountered an unavailable outcome or Room.");
      }

      const requestUpdate = await requests.updateOne(
        {
          _id: requestId,
          revision: request.revision,
          status: request.status,
          latestOutcomeSubmissionId: outcomeId,
          latestOutcomeStatus: "confirmed",
          closedAt: null,
        } as never,
        [
          {
            $set: {
              status: "closed",
              activeUniqueness: false,
              closedAt,
              purgeAt,
              updatedAt: closedAt,
              revision: { $add: ["$revision", 1] },
              // A system reconciliation is an update for both participants.
              // Keep these monotonic markers aligned with the resulting
              // request revision so the Alumni Community counters and list
              // ordering see the corrected terminal state on their next read.
              requesterUpdateSequence: {
                $max: [
                  { $ifNull: ["$requesterUpdateSequence", 0] },
                  { $add: ["$revision", 2] },
                ],
              },
              providerUpdateSequence: {
                $max: [
                  { $ifNull: ["$providerUpdateSequence", 0] },
                  { $add: ["$revision", 2] },
                ],
              },
              lifecycleTimeline: {
                $concatArrays: [
                  "$lifecycleTimeline",
                  [
                    {
                      _id: "$_id",
                      sequence: { $add: [{ $size: "$lifecycleTimeline" }, 1] },
                      action: "outcome_reconcile",
                      fromStatus: "$status",
                      toStatus: "closed",
                      actorRole: "system",
                      actorId: null,
                      note: null,
                      helpType: null,
                      occurredAt: closedAt,
                    },
                  ],
                ],
              },
            },
          },
        ] as never,
      );
      if (requestUpdate.modifiedCount !== 1) {
        throw new Error("Confirmed Help closure request changed during migration.");
      }
      const outcomeUpdate = await outcomes.updateMany(
        { helpRequestId: requestId } as never,
        { $set: { purgeAt } } as never,
      );
      if (outcomeUpdate.matchedCount < 1) {
        throw new Error("Confirmed Help closure outcome disappeared during migration.");
      }
      const roomUpdate = await rooms.updateOne(
        {
          _id: conversationId,
          revision: room.revision,
          kind: "alumni_help",
          status: "current",
          helpRequestId: requestId,
          writeAccessEndsAt: null,
        } as never,
        {
          $set: { writeAccessEndsAt, updatedAt: closedAt },
          $inc: { revision: 1 },
        } as never,
      );
      if (roomUpdate.modifiedCount !== 1) {
        throw new Error("Confirmed Help Room changed during migration.");
      }
      modified += 1;
    }

    const nextLastId = cursorId(batch[batch.length - 1]?.__migrationCursorId) ?? lastId;
    return {
      done: page.length <= context.batchSize,
      checkpoint: { highWatermark, lastId: nextLastId, referenceTime },
      counts: {
        examined: batch.length,
        matched: modified,
        modified,
        skipped: batch.length - modified,
        errors: 0,
      },
    };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: null,
      counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const requests = context.database.collection<HelpRequestDocument>(
      "alumni_help_requests",
    );
    const applied = context.appliedCheckpoint as ConfirmedHelpClosureCheckpoint | null;
    const highWatermark = applied?.highWatermark ?? null;
    if (highWatermark === null) {
      return {
        ok: true,
        summary:
          "Verified no pre-existing confirmed Help Requests required reconciliation.",
        counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
      };
    }
    if (!/^[a-f\d]{24}$/i.test(highWatermark)) {
      throw new Error("Confirmed Help closure migration applied cursor is invalid.");
    }
    const remaining = await requests.countDocuments({
      status: { $in: ["accepted", "in_progress", "completed"] },
      hasBeenAccepted: true,
      latestOutcomeStatus: "confirmed",
      latestOutcomeSubmissionId: { $type: "objectId" },
      conversationId: { $type: "objectId" },
      closedAt: null,
      $expr: { $lte: ["$_id", { $toObjectId: highWatermark }] },
    } as never);
    return {
      ok: remaining === 0,
      summary:
        context.direction === "down"
          ? "Verified reconciled confirmed Help Requests remain closed."
          : "Verified pre-existing confirmed Help Requests are closed with Room grace periods.",
      counts: {
        examined: remaining,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: remaining,
      },
    };
  },
} satisfies MigrationSourceDefinition;
