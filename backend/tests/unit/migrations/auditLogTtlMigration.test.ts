import { describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260918_001_enforce-audit-log-ttl";

describe("AuditLog TTL migration", () => {
  it("plans a clean-database dry run when the collection does not exist", async () => {
    const toArray = vi.fn().mockRejectedValue(
      Object.assign(new Error("namespace does not exist"), {
        code: 26,
        codeName: "NamespaceNotFound",
      }),
    );
    const database = {
      collection: vi.fn(() => ({
        listIndexes: vi.fn(() => ({ toArray })),
      })),
    };

    await expect(
      migration.plan({ database, batchSize: 250 } as never),
    ).resolves.toEqual({
      summary: "Reconcile the AuditLog createdAt TTL index to 365 days.",
      counts: {
        examined: 0,
        matched: 0,
        modified: 1,
        skipped: 0,
        errors: 0,
      },
      estimatedBatches: 1,
      warnings: [],
    });
    expect(database.collection).toHaveBeenCalledWith("auditlogs");
  });

  it("fails the dry run for index-listing errors other than a missing namespace", async () => {
    const metadataError = Object.assign(new Error("not authorized"), {
      code: 13,
      codeName: "Unauthorized",
    });
    const database = {
      collection: vi.fn(() => ({
        listIndexes: vi.fn(() => ({
          toArray: vi.fn().mockRejectedValue(metadataError),
        })),
      })),
    };

    await expect(
      migration.plan({ database, batchSize: 250 } as never),
    ).rejects.toBe(metadataError);
  });

  it("reconciles up to 365 days and down to the prior 730-day fallback", async () => {
    const reconcileTtlIndex = vi.fn().mockResolvedValue(undefined);

    await migration.prepare({
      direction: "up",
      database: { reconcileTtlIndex },
    });
    await migration.prepare({
      direction: "down",
      database: { reconcileTtlIndex },
    });

    expect(reconcileTtlIndex).toHaveBeenNthCalledWith(1, {
      collectionName: "auditlogs",
      indexName: "createdAt_1",
      field: "createdAt",
      expireAfterSeconds: 31_536_000,
    });
    expect(reconcileTtlIndex).toHaveBeenNthCalledWith(2, {
      collectionName: "auditlogs",
      indexName: "createdAt_1",
      field: "createdAt",
      expireAfterSeconds: 63_072_000,
    });
  });

  it("verifies the exact single-field TTL definition", async () => {
    const context = {
      direction: "up" as const,
      database: {
        collection: vi.fn(() => ({
          listIndexes: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([
              { name: "_id_", key: { _id: 1 } },
              {
                name: "createdAt_1",
                key: { createdAt: 1 },
                expireAfterSeconds: 31_536_000,
              },
            ]),
          })),
        })),
      },
    };

    await expect(migration.verify(context as never)).resolves.toMatchObject({
      ok: true,
      counts: { matched: 1, errors: 0 },
    });
  });
});
