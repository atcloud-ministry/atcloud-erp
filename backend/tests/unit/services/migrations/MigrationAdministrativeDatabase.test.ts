import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mongoose";
import { createMigrationAdministrativeDatabase } from "../../../../src/services/migrations/MigrationAdministrativeDatabase";

function harness(indexes: Record<string, unknown>[]) {
  const createIndex = vi.fn().mockResolvedValue("createdAt_1");
  const command = vi.fn().mockResolvedValue({ ok: 1 });
  const collection = {
    listIndexes: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(indexes) })),
    createIndex,
  };
  const connection = {
    db: {
      collection: vi.fn(() => collection),
      command,
    },
  } as unknown as Connection;
  return {
    database: createMigrationAdministrativeDatabase(connection),
    createIndex,
    command,
    collection,
  };
}

const input = {
  collectionName: "auditlogs",
  indexName: "createdAt_1",
  field: "createdAt",
  expireAfterSeconds: 31_536_000,
};

describe("MigrationAdministrativeDatabase", () => {
  it("accepts zero as a valid immediate TTL policy", async () => {
    const target = harness([{ name: "_id_", key: { _id: 1 } }]);
    await target.database.reconcileTtlIndex({
      collectionName: "refreshsessions",
      indexName: "ttl_refresh_session_expiry",
      field: "expiresAt",
      expireAfterSeconds: 0,
    });
    expect(target.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      { name: "ttl_refresh_session_expiry", expireAfterSeconds: 0 },
    );
  });

  it("creates the named TTL index when it is absent", async () => {
    const target = harness([{ name: "_id_", key: { _id: 1 } }]);
    await target.database.reconcileTtlIndex(input);
    expect(target.createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { name: "createdAt_1", expireAfterSeconds: 31_536_000 },
    );
    expect(target.command).not.toHaveBeenCalled();
  });

  it("creates the collection index on a fresh database namespace", async () => {
    const target = harness([]);
    target.collection.listIndexes.mockReturnValueOnce({
      toArray: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("namespace does not exist"), { code: 26 }),
        ),
    });

    await target.database.reconcileTtlIndex(input);

    expect(target.createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { name: "createdAt_1", expireAfterSeconds: 31_536_000 },
    );
  });

  it("uses collMod for an existing TTL index and is idempotent at the target", async () => {
    const changed = harness([
      { name: "createdAt_1", key: { createdAt: 1 }, expireAfterSeconds: 63_072_000 },
    ]);
    await changed.database.reconcileTtlIndex(input);
    expect(changed.command).toHaveBeenCalledWith({
      collMod: "auditlogs",
      index: { name: "createdAt_1", expireAfterSeconds: 31_536_000 },
    });

    const current = harness([
      { name: "createdAt_1", key: { createdAt: 1 }, expireAfterSeconds: 31_536_000 },
    ]);
    await current.database.reconcileTtlIndex(input);
    expect(current.command).not.toHaveBeenCalled();
    expect(current.createIndex).not.toHaveBeenCalled();
  });

  it("fails closed when the requested index name belongs to another key", async () => {
    const target = harness([{ name: "createdAt_1", key: { updatedAt: 1 } }]);
    await expect(target.database.reconcileTtlIndex(input)).rejects.toThrow(
      "index name is already used",
    );
  });
});
