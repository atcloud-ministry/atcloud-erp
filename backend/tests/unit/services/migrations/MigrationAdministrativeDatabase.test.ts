import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mongoose";
import { createMigrationAdministrativeDatabase } from "../../../../src/services/migrations/MigrationAdministrativeDatabase";

function harness(indexes: Record<string, unknown>[]) {
  const createIndex = vi.fn().mockResolvedValue("createdAt_1");
  const dropIndex = vi.fn().mockResolvedValue(undefined);
  const command = vi.fn().mockResolvedValue({ ok: 1 });
  const collection = {
    listIndexes: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(indexes) })),
    createIndex,
    dropIndex,
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
    dropIndex,
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

  it("fails closed for a competing TTL key or unsafe TTL options", async () => {
    const competing = harness([
      { name: "unexpected", key: { createdAt: 1 }, expireAfterSeconds: 1 },
    ]);
    await expect(
      competing.database.reconcileExactTtlIndex(input),
    ).rejects.toThrow("key already exists");

    const unsafe = harness([
      {
        name: "createdAt_1",
        key: { createdAt: 1 },
        expireAfterSeconds: 31_536_000,
        sparse: true,
      },
    ]);
    await expect(
      unsafe.database.reconcileExactTtlIndex(input),
    ).rejects.toThrow("another definition");
  });

  it("creates and idempotently recognizes an exact compound unique index", async () => {
    const input = {
      collectionName: "alumni_affiliations",
      indexName: "uniq_alumni_affiliation_profile_program_key",
      fields: ["alumniProfileId", "programAffiliationKey"],
      partialStringField: "programAffiliationKey",
    } as const;
    const absent = harness([{ name: "_id_", key: { _id: 1 } }]);

    await absent.database.reconcileCompoundUniqueIndex(input);

    expect(absent.createIndex).toHaveBeenCalledWith(
      { alumniProfileId: 1, programAffiliationKey: 1 },
      {
        name: "uniq_alumni_affiliation_profile_program_key",
        unique: true,
        partialFilterExpression: {
          programAffiliationKey: { $type: "string" },
        },
      },
    );

    const current = harness([
      {
        name: input.indexName,
        key: { alumniProfileId: 1, programAffiliationKey: 1 },
        unique: true,
        partialFilterExpression: {
          programAffiliationKey: { $type: "string" },
        },
      },
    ]);
    await current.database.reconcileCompoundUniqueIndex(input);
    expect(current.createIndex).not.toHaveBeenCalled();
  });

  it("creates a compound unique index on a fresh namespace", async () => {
    const target = harness([]);
    target.collection.listIndexes.mockReturnValueOnce({
      toArray: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("namespace does not exist"), {
            codeName: "NamespaceNotFound",
          }),
        ),
    });

    await target.database.reconcileCompoundUniqueIndex({
      collectionName: "alumni_affiliations",
      indexName: "uniq_alumni_affiliation_profile_external_key",
      fields: ["alumniProfileId", "programId", "affiliationKey"],
    });

    expect(target.createIndex).toHaveBeenCalledWith(
      { alumniProfileId: 1, programId: 1, affiliationKey: 1 },
      {
        name: "uniq_alumni_affiliation_profile_external_key",
        unique: true,
      },
    );
  });

  it.each([
    {
      label: "key order",
      index: {
        name: "target",
        key: { programId: 1, alumniProfileId: 1 },
        unique: true,
      },
    },
    {
      label: "unique option",
      index: {
        name: "target",
        key: { alumniProfileId: 1, programId: 1 },
      },
    },
    {
      label: "partial filter",
      index: {
        name: "target",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
        partialFilterExpression: { programId: { $type: "objectId" } },
      },
    },
    {
      label: "sparse option",
      index: {
        name: "target",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
        sparse: true,
      },
    },
    {
      label: "collation option",
      index: {
        name: "target",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
        collation: { locale: "en" },
      },
    },
    {
      label: "hidden option",
      index: {
        name: "target",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
        hidden: true,
      },
    },
  ])("fails closed for a conflicting compound $label", async ({ index }) => {
    const target = harness([index]);
    await expect(
      target.database.reconcileCompoundUniqueIndex({
        collectionName: "alumni_affiliations",
        indexName: "target",
        fields: ["alumniProfileId", "programId"],
      }),
    ).rejects.toThrow("another definition");
    expect(target.createIndex).not.toHaveBeenCalled();
  });

  it("fails closed when the compound key already has another name", async () => {
    const target = harness([
      {
        name: "unexpected_name",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
      },
    ]);
    await expect(
      target.database.reconcileCompoundUniqueIndex({
        collectionName: "alumni_affiliations",
        indexName: "target",
        fields: ["alumniProfileId", "programId"],
      }),
    ).rejects.toThrow("key already exists");

    const duplicateDefinition = harness([
      {
        name: "target",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
      },
      {
        name: "unexpected_name",
        key: { alumniProfileId: 1, programId: 1 },
        unique: true,
      },
    ]);
    await expect(
      duplicateDefinition.database.reconcileCompoundUniqueIndex({
        collectionName: "alumni_affiliations",
        indexName: "target",
        fields: ["alumniProfileId", "programId"],
      }),
    ).rejects.toThrow("key already exists");
  });

  it("drops only an exact named compound unique index", async () => {
    const input = {
      collectionName: "alumni_affiliations",
      indexName: "uniq_alumni_affiliation_profile_key",
      fields: ["alumniProfileId", "affiliationKey"],
    } as const;
    const exact = harness([
      {
        name: input.indexName,
        key: { alumniProfileId: 1, affiliationKey: 1 },
        unique: true,
      },
    ]);
    await exact.database.dropCompoundUniqueIndexIfMatches(input);
    expect(exact.dropIndex).toHaveBeenCalledWith(input.indexName);

    const wrong = harness([
      {
        name: input.indexName,
        key: { affiliationKey: 1, alumniProfileId: 1 },
        unique: true,
      },
    ]);
    await expect(
      wrong.database.dropCompoundUniqueIndexIfMatches(input),
    ).rejects.toThrow("another definition");
    expect(wrong.dropIndex).not.toHaveBeenCalled();
  });

  it("validates compound definitions and propagates metadata failures", async () => {
    const target = harness([]);
    await expect(
      target.database.reconcileCompoundUniqueIndex({
        collectionName: "alumni_affiliations",
        indexName: "target",
        fields: ["alumniProfileId", "alumniProfileId"],
      }),
    ).rejects.toThrow("input is invalid");
    await expect(
      target.database.reconcileCompoundUniqueIndex({
        collectionName: "alumni_affiliations",
        indexName: "target",
        fields: ["alumniProfileId", "programId"],
        partialStringField: "notIndexed",
      }),
    ).rejects.toThrow("input is invalid");

    target.collection.listIndexes.mockReturnValueOnce({
      toArray: vi.fn().mockRejectedValue(new Error("permission denied")),
    });
    await expect(
      target.database.reconcileCompoundUniqueIndex({
        collectionName: "alumni_affiliations",
        indexName: "target",
        fields: ["alumniProfileId", "programId"],
      }),
    ).rejects.toThrow("permission denied");
  });

  it("creates, recognizes, and drops an exact plain compound index", async () => {
    const input = {
      collectionName: "alumni_import_batches",
      indexName: "idx_alumni_import_batch_raw_cleanup",
      fields: ["rawDataPurgedAt", "rawDataPurgeAt"],
    } as const;
    const absent = harness([{ name: "_id_", key: { _id: 1 } }]);
    await absent.database.reconcileCompoundIndex(input);
    expect(absent.createIndex).toHaveBeenCalledWith(
      { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
      { name: input.indexName },
    );

    const exact = harness([
      {
        name: input.indexName,
        key: { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
        unique: false,
      },
    ]);
    await exact.database.reconcileCompoundIndex(input);
    expect(exact.createIndex).not.toHaveBeenCalled();
    await exact.database.dropCompoundIndexIfMatches(input);
    expect(exact.dropIndex).toHaveBeenCalledWith(input.indexName);

    const unsafe = harness([
      {
        name: input.indexName,
        key: { rawDataPurgedAt: 1, rawDataPurgeAt: 1 },
        unique: true,
      },
    ]);
    await expect(unsafe.database.reconcileCompoundIndex(input)).rejects.toThrow(
      "another definition",
    );
  });

  it("creates, recognizes, and drops an exact enum-partial unique index", async () => {
    const input = {
      collectionName: "alumni_import_batches",
      indexName: "uniq_alumni_import_batch_active_checksum",
      field: "checksum",
      partialField: "status",
      partialValues: [
        "pending",
        "dry_running",
        "review_ready",
        "applying",
      ],
    } as const;
    const absent = harness([{ name: "_id_", key: { _id: 1 } }]);
    await absent.database.reconcilePartialUniqueIndex(input);
    expect(absent.createIndex).toHaveBeenCalledWith(
      { checksum: 1 },
      {
        name: input.indexName,
        unique: true,
        partialFilterExpression: {
          status: { $in: [...input.partialValues] },
        },
      },
    );

    const exact = harness([
      {
        name: input.indexName,
        key: { checksum: 1 },
        unique: true,
        partialFilterExpression: {
          status: { $in: [...input.partialValues] },
        },
      },
    ]);
    await exact.database.reconcilePartialUniqueIndex(input);
    expect(exact.createIndex).not.toHaveBeenCalled();
    await exact.database.dropPartialUniqueIndexIfMatches(input);
    expect(exact.dropIndex).toHaveBeenCalledWith(input.indexName);

    const conflicting = harness([
      {
        name: input.indexName,
        key: { checksum: 1 },
        unique: true,
        partialFilterExpression: { status: "review_ready" },
      },
    ]);
    await expect(
      conflicting.database.reconcilePartialUniqueIndex(input),
    ).rejects.toThrow("another definition");
  });
});
