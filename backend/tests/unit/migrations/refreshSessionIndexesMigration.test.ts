import { describe, expect, it, vi } from "vitest";
import { migration } from "../../../src/migrations/versions/20260918_002_create-refresh-session-indexes";

describe("Refresh-session index migration", () => {
  it("creates the unique family and zero-second TTL indexes", async () => {
    const reconcileUniqueIndex = vi.fn().mockResolvedValue(undefined);
    const reconcileTtlIndex = vi.fn().mockResolvedValue(undefined);

    await migration.prepare({
      direction: "up",
      database: { reconcileUniqueIndex, reconcileTtlIndex },
    } as never);

    expect(reconcileUniqueIndex).toHaveBeenCalledWith({
      collectionName: "refreshsessions",
      indexName: "uniq_refresh_session_family",
      field: "familyId",
    });
    expect(reconcileTtlIndex).toHaveBeenCalledWith({
      collectionName: "refreshsessions",
      indexName: "ttl_refresh_session_expiry",
      field: "expiresAt",
      expireAfterSeconds: 0,
    });
  });

  it("verifies exact index definitions and rejects a non-zero TTL", async () => {
    const database = {
      collection: vi.fn(() => ({
        listIndexes: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([
            {
              name: "uniq_refresh_session_family",
              key: { familyId: 1 },
              unique: true,
            },
            {
              name: "ttl_refresh_session_expiry",
              key: { expiresAt: 1 },
              expireAfterSeconds: 1,
            },
          ]),
        })),
      })),
    };

    await expect(
      migration.verify({ direction: "up", database } as never),
    ).resolves.toMatchObject({ ok: false, counts: { matched: 1, errors: 1 } });
  });

  it("treats only a missing namespace as an empty first-deploy state", async () => {
    const missingDatabase = {
      collection: vi.fn(() => ({
        listIndexes: vi.fn(() => ({
          toArray: vi.fn().mockRejectedValue(
            Object.assign(new Error("namespace missing"), {
              code: 26,
              codeName: "NamespaceNotFound",
            }),
          ),
        })),
      })),
    };

    await expect(
      migration.plan({ direction: "up", database: missingDatabase } as never),
    ).resolves.toMatchObject({ counts: { matched: 0, modified: 2, errors: 0 } });
  });

  it("fails closed when refresh-session index metadata cannot be read", async () => {
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
