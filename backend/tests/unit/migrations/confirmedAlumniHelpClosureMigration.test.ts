import { afterEach, describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260921_001_reconcile-confirmed-alumni-help-closures";

const REFERENCE_TIME = "2026-09-21T12:00:00.000Z";
const REQUEST_ID = "66ee00000000000000000001";
const OUTCOME_ID = "66ee00000000000000000002";
const ROOM_ID = "66ee00000000000000000003";

describe("confirmed Alumni Help closure reconciliation migration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a legacy confirmed request, starts its Room grace period, and advances both participant update markers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(REFERENCE_TIME));

    const request = {
      _id: REQUEST_ID,
      revision: 4,
      status: "completed",
      hasBeenAccepted: true,
      latestOutcomeSubmissionId: OUTCOME_ID,
      latestOutcomeStatus: "confirmed",
      latestOutcomeDueAt: new Date("2026-09-01T12:00:00.000Z"),
      conversationId: ROOM_ID,
      closedAt: null,
      lifecycleTimeline: [
        { occurredAt: new Date("2026-09-21T10:00:00.000Z") },
      ],
      __migrationCursorId: REQUEST_ID,
    };
    const aggregate = vi
      .fn()
      .mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([{ cursorId: REQUEST_ID }]),
      })
      .mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValue([request]),
      });
    const requestUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const outcomeFindOne = vi.fn().mockResolvedValue({ _id: OUTCOME_ID });
    const outcomeUpdateMany = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const roomFindOne = vi.fn().mockResolvedValue({
      _id: ROOM_ID,
      revision: 8,
      helpRequestId: REQUEST_ID,
    });
    const roomUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const database = {
      collection: vi.fn((name: string) => {
        if (name === "alumni_help_requests") {
          return { aggregate, updateOne: requestUpdateOne };
        }
        if (name === "alumni_help_outcome_submissions") {
          return { findOne: outcomeFindOne, updateMany: outcomeUpdateMany };
        }
        if (name === "conversations") {
          return { findOne: roomFindOne, updateOne: roomUpdateOne };
        }
        throw new Error(`Unexpected collection: ${name}`);
      }),
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
        highWatermark: REQUEST_ID,
        lastId: REQUEST_ID,
        referenceTime: REFERENCE_TIME,
      },
      counts: { examined: 1, matched: 1, modified: 1, skipped: 0, errors: 0 },
    });

    const requestPipeline = requestUpdateOne.mock.calls[0]?.[1] as Array<{
      $set: Record<string, unknown>;
    }>;
    expect(requestPipeline).toEqual([
      {
        $set: expect.objectContaining({
          status: "closed",
          activeUniqueness: false,
          closedAt: new Date(REFERENCE_TIME),
          updatedAt: new Date(REFERENCE_TIME),
          purgeAt: new Date("2027-09-21T12:00:00.000Z"),
          revision: { $add: ["$revision", 1] },
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
                expect.objectContaining({
                  action: "outcome_reconcile",
                  actorRole: "system",
                  actorId: null,
                  fromStatus: "$status",
                  toStatus: "closed",
                  occurredAt: new Date(REFERENCE_TIME),
                }),
              ],
            ],
          },
        }),
      },
    ]);
    expect(roomUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ROOM_ID, revision: 8 }),
      {
        $set: {
          writeAccessEndsAt: new Date("2026-09-28T12:00:00.000Z"),
          updatedAt: new Date(REFERENCE_TIME),
        },
        $inc: { revision: 1 },
      },
    );
  });
});
