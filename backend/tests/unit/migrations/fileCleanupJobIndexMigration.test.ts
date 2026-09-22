import { describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260918_003_create-file-cleanup-job-index";

describe("File-cleanup job index migration", () => {
  it("creates the unique durable-job index", async () => {
    const reconcileUniqueIndex = vi.fn().mockResolvedValue(undefined);

    await migration.prepare({
      direction: "up",
      database: { reconcileUniqueIndex },
    } as never);

    expect(reconcileUniqueIndex).toHaveBeenCalledWith({
      collectionName: "filecleanupjobs",
      indexName: "uniq_file_cleanup_job",
      field: "jobKey",
    });
  });

  it("plans a fresh namespace and verifies the exact index", async () => {
    const missingDatabase = {
      collection: vi.fn(() => ({
        listIndexes: vi.fn(() => ({
          toArray: vi.fn().mockRejectedValue(
            Object.assign(new Error("namespace missing"), { code: 26 }),
          ),
        })),
      })),
    };
    await expect(
      migration.plan({ direction: "up", database: missingDatabase } as never),
    ).resolves.toMatchObject({ counts: { matched: 0, modified: 1, errors: 0 } });

    const readyDatabase = {
      collection: vi.fn(() => ({
        listIndexes: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([
            {
              name: "uniq_file_cleanup_job",
              key: { jobKey: 1 },
              unique: true,
            },
          ]),
        })),
      })),
    };
    await expect(
      migration.verify({ direction: "up", database: readyDatabase } as never),
    ).resolves.toMatchObject({ ok: true, counts: { matched: 1, errors: 0 } });
  });

  it("fails closed when index metadata cannot be read", async () => {
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
      migration.plan({ direction: "up", database } as never),
    ).rejects.toBe(metadataError);
    await expect(
      migration.verify({ direction: "up", database } as never),
    ).rejects.toBe(metadataError);
  });
});
