import type { MigrationSourceDefinition } from "../types";

type OperationalIndexMetadata = {
  readonly name?: string;
  readonly key: Readonly<Record<string, unknown>>;
  readonly unique?: unknown;
  readonly sparse?: unknown;
  readonly expireAfterSeconds?: unknown;
  readonly partialFilterExpression?: unknown;
  readonly collation?: unknown;
  readonly hidden?: unknown;
};

export const migration = {
  id: "20260919_003_reconcile-alumni-import-retention-indexes",
  description:
    "Create and verify alumni import retention, active-checksum, and idempotency indexes.",

  prepare: async (context) => {
    context.signal?.throwIfAborted();
    const activeStatuses = [
      "pending",
      "dry_running",
      "review_ready",
      "applying",
    ] as const;
    const readCount = async (
      collectionName: string,
      pipeline: Record<string, unknown>[],
    ): Promise<number> => {
      const result = await context.readDatabase
        .collection(collectionName)
        .aggregate<{ readonly count?: unknown }>(pipeline)
        .toArray();
      if (result.length === 0) return 0;
      const count = result.length === 1 ? result[0]?.count : undefined;
      if (!Number.isSafeInteger(count) || Number(count) < 0) {
        throw new Error(
          "Alumni import operational preflight returned invalid counts.",
        );
      }
      return Number(count);
    };
    const activeMatch = { status: { $in: [...activeStatuses] } };
    const [invalidActive, duplicateActive, duplicateIdempotency] =
      await Promise.all([
        readCount("alumni_import_batches", [
          {
            $match: {
              ...activeMatch,
              $expr: {
                $not: [
                  {
                    $regexMatch: {
                      input: {
                        $cond: [
                          { $eq: [{ $type: "$checksum" }, "string"] },
                          "$checksum",
                          "",
                        ],
                      },
                      regex: "^[a-f0-9]{64}$",
                    },
                  },
                ],
              },
            },
          },
          { $count: "count" },
        ]),
        readCount("alumni_import_batches", [
          { $match: activeMatch },
          { $group: { _id: "$checksum", documents: { $sum: 1 } } },
          { $match: { documents: { $gt: 1 } } },
          { $group: { _id: null, count: { $sum: "$documents" } } },
        ]),
        readCount("idempotencyrecords", [
          {
            $group: {
              _id: {
                hashVersion: "$hashVersion",
                scope: "$scope",
                actorKeyHash: "$actorKeyHash",
                keyHash: "$keyHash",
              },
              documents: { $sum: 1 },
            },
          },
          { $match: { documents: { $gt: 1 } } },
          { $group: { _id: null, count: { $sum: "$documents" } } },
        ]),
      ]);
    if (invalidActive > 0 || duplicateActive > 0 || duplicateIdempotency > 0) {
      throw new Error("Alumni import operational index preflight failed.");
    }
    context.signal?.throwIfAborted();
    await context.database.reconcileCompoundUniqueIndex({
      collectionName: "idempotencyrecords",
      indexName: "uniq_idempotency_scope_actor_key",
      fields: ["hashVersion", "scope", "actorKeyHash", "keyHash"],
    });
    context.signal?.throwIfAborted();
    await context.database.reconcilePartialUniqueIndex({
      collectionName: "alumni_import_batches",
      indexName: "uniq_alumni_import_batch_active_checksum",
      field: "checksum",
      partialField: "status",
      partialValues: activeStatuses,
    });
    context.signal?.throwIfAborted();
    await context.database.reconcileCompoundIndex({
      collectionName: "alumni_import_batches",
      indexName: "idx_alumni_import_batch_raw_cleanup",
      fields: ["rawDataPurgedAt", "rawDataPurgeAt"],
    });
    context.signal?.throwIfAborted();
    await context.database.reconcileExactTtlIndex({
      collectionName: "alumni_import_batches",
      indexName: "ttl_alumni_import_batch_purge_at",
      field: "purgeAt",
      expireAfterSeconds: 0,
    });
    context.signal?.throwIfAborted();
  },

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const activeStatuses = [
      "pending",
      "dry_running",
      "review_ready",
      "applying",
    ] as const;
    const listIndexes = async (
      collectionName: string,
    ): Promise<OperationalIndexMetadata[]> =>
      context.database
        .collection(collectionName)
        .listIndexes()
        .toArray()
        .catch((error: unknown) => {
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
          return [];
        });
    const exactKey = (
      value: unknown,
      expected: readonly (readonly [string, number])[],
    ): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      return (
        entries.length === expected.length &&
        entries.every(
          ([field, direction], index) =>
            field === expected[index]?.[0] && direction === expected[index]?.[1],
        )
      );
    };
    const partialMatches = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const status = (value as Record<string, unknown>).status;
      if (!status || typeof status !== "object" || Array.isArray(status)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const conditions = Object.entries(status as Record<string, unknown>);
      const values = conditions[0]?.[1];
      return (
        entries.length === 1 &&
        conditions.length === 1 &&
        conditions[0]?.[0] === "$in" &&
        Array.isArray(values) &&
        values.length === activeStatuses.length &&
        values.every((item, index) => item === activeStatuses[index])
      );
    };
    const definition = (
      indexes: readonly OperationalIndexMetadata[],
      name: string,
      key: readonly (readonly [string, number])[],
      options: "plain" | "unique" | "ttl" | "active",
    ) => {
      const keyMatches = indexes.filter((index) => exactKey(index.key, key));
      const nameMatches = indexes.filter((index) => index.name === name);
      const exact = keyMatches.filter((index) => {
        const common =
          index.name === name &&
          index.sparse !== true &&
          index.collation === undefined &&
          index.hidden !== true;
        if (!common) return false;
        if (options === "ttl") {
          return (
            index.unique !== true &&
            index.partialFilterExpression === undefined &&
            index.expireAfterSeconds === 0
          );
        }
        if (options === "plain") {
          return (
            index.unique !== true &&
            index.partialFilterExpression === undefined &&
            index.expireAfterSeconds === undefined
          );
        }
        return (
          index.unique === true &&
          index.expireAfterSeconds === undefined &&
          (options === "active"
            ? partialMatches(index.partialFilterExpression)
            : index.partialFilterExpression === undefined)
        );
      });
      return {
        ready:
          exact.length === 1 && keyMatches.length === 1 && nameMatches.length === 1,
        conflict: keyMatches.length > 0 || nameMatches.length > 0,
      };
    };
    const readCount = async (
      collectionName: string,
      pipeline: Record<string, unknown>[],
    ): Promise<number> => {
      const result = await context.database
        .collection(collectionName)
        .aggregate<{ readonly count?: unknown }>(pipeline)
        .toArray();
      if (result.length === 0) return 0;
      const count = result.length === 1 ? result[0]?.count : undefined;
      if (!Number.isSafeInteger(count) || Number(count) < 0) {
        throw new Error("Alumni import operational plan returned invalid counts.");
      }
      return Number(count);
    };
    const activeMatch = { status: { $in: [...activeStatuses] } };
    const [importIndexes, idempotencyIndexes, invalidActive, duplicateActive, duplicateIdempotency] =
      await Promise.all([
        listIndexes("alumni_import_batches"),
        listIndexes("idempotencyrecords"),
        readCount("alumni_import_batches", [
          {
            $match: {
              ...activeMatch,
              $expr: {
                $not: [
                  {
                    $regexMatch: {
                      input: {
                        $cond: [
                          { $eq: [{ $type: "$checksum" }, "string"] },
                          "$checksum",
                          "",
                        ],
                      },
                      regex: "^[a-f0-9]{64}$",
                    },
                  },
                ],
              },
            },
          },
          { $count: "count" },
        ]),
        readCount("alumni_import_batches", [
          { $match: activeMatch },
          { $group: { _id: "$checksum", documents: { $sum: 1 } } },
          { $match: { documents: { $gt: 1 } } },
          { $group: { _id: null, count: { $sum: "$documents" } } },
        ]),
        readCount("idempotencyrecords", [
          {
            $group: {
              _id: {
                hashVersion: "$hashVersion",
                scope: "$scope",
                actorKeyHash: "$actorKeyHash",
                keyHash: "$keyHash",
              },
              documents: { $sum: 1 },
            },
          },
          { $match: { documents: { $gt: 1 } } },
          { $group: { _id: null, count: { $sum: "$documents" } } },
        ]),
      ]);
    const definitions = [
      [
        "ALUMNI_IMPORT_BATCH_TTL_INDEX_CONFLICT",
        definition(
          importIndexes,
          "ttl_alumni_import_batch_purge_at",
          [["purgeAt", 1]],
          "ttl",
        ),
      ],
      [
        "ALUMNI_IMPORT_BATCH_RAW_CLEANUP_INDEX_CONFLICT",
        definition(
          importIndexes,
          "idx_alumni_import_batch_raw_cleanup",
          [
            ["rawDataPurgedAt", 1],
            ["rawDataPurgeAt", 1],
          ],
          "plain",
        ),
      ],
      [
        "ALUMNI_IMPORT_BATCH_ACTIVE_CHECKSUM_INDEX_CONFLICT",
        definition(
          importIndexes,
          "uniq_alumni_import_batch_active_checksum",
          [["checksum", 1]],
          "active",
        ),
      ],
      [
        "ALUMNI_IMPORT_IDEMPOTENCY_INDEX_CONFLICT",
        definition(
          idempotencyIndexes,
          "uniq_idempotency_scope_actor_key",
          [
            ["hashVersion", 1],
            ["scope", 1],
            ["actorKeyHash", 1],
            ["keyHash", 1],
          ],
          "unique",
        ),
      ],
    ] as const;
    const ready = definitions.filter(([, value]) => value.ready).length;
    return {
      summary:
        "Reconcile alumni import retention, active-checksum, and idempotency indexes.",
      counts: {
        examined: 4,
        matched: 4 - ready,
        modified: 4 - ready,
        skipped: ready,
        errors: 0,
      },
      estimatedBatches: 1,
      warnings: [
        ...definitions.flatMap(([code, value]) =>
          !value.ready && value.conflict ? [{ code, count: 1 }] : [],
        ),
        ...(invalidActive > 0
          ? [{ code: "ALUMNI_IMPORT_ACTIVE_CHECKSUM_INVALID", count: invalidActive }]
          : []),
        ...(duplicateActive > 0
          ? [{ code: "ALUMNI_IMPORT_ACTIVE_CHECKSUM_DUPLICATE", count: duplicateActive }]
          : []),
        ...(duplicateIdempotency > 0
          ? [
              {
                code: "ALUMNI_IMPORT_IDEMPOTENCY_DUPLICATE",
                count: duplicateIdempotency,
              },
            ]
          : []),
      ],
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: { operationalIndexesReady: true },
      counts: {
        examined: 4,
        matched: 4,
        modified: 4,
        skipped: 0,
        errors: 0,
      },
    };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: { operationalIndexesReady: true },
      counts: {
        examined: 4,
        matched: 0,
        modified: 0,
        skipped: 4,
        errors: 0,
      },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const activeStatuses = [
      "pending",
      "dry_running",
      "review_ready",
      "applying",
    ] as const;
    const listIndexes = async (
      collectionName: string,
    ): Promise<OperationalIndexMetadata[]> =>
      context.database
        .collection(collectionName)
        .listIndexes()
        .toArray()
        .catch((error: unknown) => {
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
          return [];
        });
    const exactKey = (
      value: unknown,
      expected: readonly (readonly [string, number])[],
    ): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      return (
        entries.length === expected.length &&
        entries.every(
          ([field, direction], index) =>
            field === expected[index]?.[0] && direction === expected[index]?.[1],
        )
      );
    };
    const partialMatches = (value: unknown): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const status = (value as Record<string, unknown>).status;
      if (!status || typeof status !== "object" || Array.isArray(status)) {
        return false;
      }
      const conditions = Object.entries(status as Record<string, unknown>);
      const values = conditions[0]?.[1];
      return (
        entries.length === 1 &&
        conditions.length === 1 &&
        conditions[0]?.[0] === "$in" &&
        Array.isArray(values) &&
        values.length === activeStatuses.length &&
        values.every((item, index) => item === activeStatuses[index])
      );
    };
    const ready = (
      indexes: readonly OperationalIndexMetadata[],
      name: string,
      key: readonly (readonly [string, number])[],
      options: "plain" | "unique" | "ttl" | "active",
    ): boolean => {
      const keyMatches = indexes.filter((index) => exactKey(index.key, key));
      const nameMatches = indexes.filter((index) => index.name === name);
      const exact = keyMatches.filter((index) => {
        const common =
          index.name === name &&
          index.sparse !== true &&
          index.collation === undefined &&
          index.hidden !== true;
        if (!common) return false;
        if (options === "ttl") {
          return (
            index.unique !== true &&
            index.partialFilterExpression === undefined &&
            index.expireAfterSeconds === 0
          );
        }
        if (options === "plain") {
          return (
            index.unique !== true &&
            index.partialFilterExpression === undefined &&
            index.expireAfterSeconds === undefined
          );
        }
        return (
          index.unique === true &&
          index.expireAfterSeconds === undefined &&
          (options === "active"
            ? partialMatches(index.partialFilterExpression)
            : index.partialFilterExpression === undefined)
        );
      });
      return exact.length === 1 && keyMatches.length === 1 && nameMatches.length === 1;
    };
    const readCount = async (
      collectionName: string,
      pipeline: Record<string, unknown>[],
    ): Promise<number> => {
      const result = await context.database
        .collection(collectionName)
        .aggregate<{ readonly count?: unknown }>(pipeline)
        .toArray();
      if (result.length === 0) return 0;
      const count = result.length === 1 ? result[0]?.count : undefined;
      if (!Number.isSafeInteger(count) || Number(count) < 0) {
        throw new Error(
          "Alumni import operational verification returned invalid counts.",
        );
      }
      return Number(count);
    };
    const activeMatch = { status: { $in: [...activeStatuses] } };
    const [importIndexes, idempotencyIndexes, invalidActive, duplicateActive, duplicateIdempotency] =
      await Promise.all([
        listIndexes("alumni_import_batches"),
        listIndexes("idempotencyrecords"),
        readCount("alumni_import_batches", [
          {
            $match: {
              ...activeMatch,
              $expr: {
                $not: [
                  {
                    $regexMatch: {
                      input: {
                        $cond: [
                          { $eq: [{ $type: "$checksum" }, "string"] },
                          "$checksum",
                          "",
                        ],
                      },
                      regex: "^[a-f0-9]{64}$",
                    },
                  },
                ],
              },
            },
          },
          { $count: "count" },
        ]),
        readCount("alumni_import_batches", [
          { $match: activeMatch },
          { $group: { _id: "$checksum", documents: { $sum: 1 } } },
          { $match: { documents: { $gt: 1 } } },
          { $group: { _id: null, count: { $sum: "$documents" } } },
        ]),
        readCount("idempotencyrecords", [
          {
            $group: {
              _id: {
                hashVersion: "$hashVersion",
                scope: "$scope",
                actorKeyHash: "$actorKeyHash",
                keyHash: "$keyHash",
              },
              documents: { $sum: 1 },
            },
          },
          { $match: { documents: { $gt: 1 } } },
          { $group: { _id: null, count: { $sum: "$documents" } } },
        ]),
      ]);
    const matches = [
      ready(
        importIndexes,
        "ttl_alumni_import_batch_purge_at",
        [["purgeAt", 1]],
        "ttl",
      ),
      ready(
        importIndexes,
        "idx_alumni_import_batch_raw_cleanup",
        [
          ["rawDataPurgedAt", 1],
          ["rawDataPurgeAt", 1],
        ],
        "plain",
      ),
      ready(
        importIndexes,
        "uniq_alumni_import_batch_active_checksum",
        [["checksum", 1]],
        "active",
      ),
      ready(
        idempotencyIndexes,
        "uniq_idempotency_scope_actor_key",
        [
          ["hashVersion", 1],
          ["scope", 1],
          ["actorKeyHash", 1],
          ["keyHash", 1],
        ],
        "unique",
      ),
      invalidActive === 0,
      duplicateActive === 0,
      duplicateIdempotency === 0,
    ].filter(Boolean).length;
    return {
      ok: matches === 7,
      summary: "Verified alumni import operational index definitions.",
      counts: {
        examined: 7,
        matched: matches,
        modified: 0,
        skipped: 7 - matches,
        errors: 7 - matches,
      },
    };
  },
} satisfies MigrationSourceDefinition;
