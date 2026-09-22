import { describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260921_002_backfill-private-alumni-drafts";
import { normalizeMigrationPlan } from "../../../src/services/migrations/MigrationValidation";

const id = { toString: () => "aaaaaaaaaaaaaaaaaaaaaaaa" };
const completeUser = {
  _id: id,
  username: "legacy",
  firstName: "Legacy",
  lastName: "Member",
  phone: "+12065550123",
  birthYear: 1988,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed",
  company: "Cloud",
};

describe("private Alumni draft backfill migration", () => {
  it("has a valid read-only dry-run plan on an empty database", async () => {
    const countDocuments = vi.fn().mockResolvedValue(0);
    const database = { collection: vi.fn(() => ({ countDocuments })) };
    const plan = await migration.plan({ database, batchSize: 100 } as never);

    expect(normalizeMigrationPlan(plan)).toMatchObject({
      counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
      estimatedBatches: 1,
    });
    expect(countDocuments).toHaveBeenCalledWith({ isActive: true });
  });

  it("uses insert-only upserts and safely skips a profile that already exists", async () => {
    const updateOne = vi.fn().mockResolvedValue({ upsertedCount: 0 });
    const find = vi.fn(() => ({
      sort: () => ({ limit: () => ({ next: async () => completeUser, toArray: async () => [completeUser] }) }),
    }));
    const database = { collection: vi.fn((name: string) =>
      name === "users" ? { find } : { updateOne }) };
    const result = await migration.up({
      database, checkpoint: null, batchSize: 10,
    } as never);

    expect(result).toMatchObject({ done: true, counts: { examined: 1, modified: 0, skipped: 1 } });
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, update, options] = updateOne.mock.calls[0]!;
    expect(update).toEqual({ $setOnInsert: expect.objectContaining({
      publishStatus: "draft", revision: 0,
    }) });
    expect(options).toEqual({ upsert: true });
  });

  it("treats a concurrent draft's duplicate-key race as a skip", async () => {
    const updateOne = vi.fn().mockRejectedValue({ code: 11000 });
    const findOne = vi.fn().mockResolvedValue({ _id: "existing-profile" });
    const find = vi.fn(() => ({
      sort: () => ({ limit: () => ({ next: async () => completeUser, toArray: async () => [completeUser] }) }),
    }));
    const database = { collection: vi.fn((name: string) =>
      name === "users" ? { find } : { updateOne, findOne }) };

    const result = await migration.up({ database, checkpoint: null, batchSize: 10 } as never);

    expect(result.counts).toMatchObject({ examined: 1, modified: 0, skipped: 1 });
    expect(findOne).toHaveBeenCalledWith(
      { userId: id }, { projection: { _id: 1 } },
    );
  });
});
