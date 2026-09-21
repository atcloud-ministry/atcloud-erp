import type { MigrationSourceDefinition } from "../types";

type AffiliationIdentityIntegrity = {
  readonly total: number;
  readonly structurallyInvalid: number;
  readonly externalCollisionDocuments: number;
  readonly programCollisionDocuments: number;
};

export const migration = {
  id: "20260919_002_replace-alumni-affiliation-identity-index",
  description:
    "Replace the legacy alumni affiliation name index with canonical identity indexes.",

  prepare: async (context) => {
    context.signal?.throwIfAborted();
    const collection = context.readDatabase.collection("alumni_affiliations");
    const validHash = (field: string) => ({
      $regexMatch: {
        input: {
          $cond: [{ $eq: [{ $type: field }, "string"] }, field, ""],
        },
        regex: "^[a-f0-9]{64}$",
      },
    });
    const invalidStructurePipeline: Record<string, unknown>[] = [
      {
        $match: {
          $expr: {
            $or: [
              { $ne: [{ $type: "$alumniProfileId" }, "objectId"] },
              { $ne: [{ $type: "$programName" }, "string"] },
              { $not: [validHash("$affiliationKey")] },
              {
                $not: [
                  {
                    $in: [
                      { $type: "$cohortLabel" },
                      ["missing", "null", "string"],
                    ],
                  },
                ],
              },
              {
                $let: {
                  vars: {
                    programType: { $type: "$programId" },
                    programKeyType: { $type: "$programAffiliationKey" },
                  },
                  in: {
                    $or: [
                      {
                        $not: [
                          {
                            $in: ["$$programType", ["missing", "objectId"]],
                          },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ["$$programType", "missing"] },
                          { $ne: ["$$programKeyType", "missing"] },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ["$$programType", "objectId"] },
                          { $not: [validHash("$programAffiliationKey")] },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      { $count: "count" },
    ];
    const duplicateExternalPipeline: Record<string, unknown>[] = [
      {
        $group: {
          _id: {
            alumniProfileId: "$alumniProfileId",
            programId: { $ifNull: ["$programId", null] },
            affiliationKey: "$affiliationKey",
          },
          documents: { $sum: 1 },
        },
      },
      { $match: { documents: { $gt: 1 } } },
      { $group: { _id: null, count: { $sum: "$documents" } } },
    ];
    const duplicateProgramPipeline: Record<string, unknown>[] = [
      {
        $match: {
          $expr: {
            $eq: [{ $type: "$programAffiliationKey" }, "string"],
          },
        },
      },
      {
        $group: {
          _id: {
            alumniProfileId: "$alumniProfileId",
            programAffiliationKey: "$programAffiliationKey",
          },
          documents: { $sum: 1 },
        },
      },
      { $match: { documents: { $gt: 1 } } },
      { $group: { _id: null, count: { $sum: "$documents" } } },
    ];
    const readCount = async (
      pipeline: readonly Record<string, unknown>[],
    ): Promise<number> => {
      const rows = await collection
        .aggregate<{ readonly count?: unknown }>([...pipeline])
        .toArray();
      if (rows.length === 0) return 0;
      const count = rows.length === 1 ? rows[0]?.count : undefined;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new Error(
          "Alumni affiliation identity preflight returned invalid counts.",
        );
      }
      return count;
    };
    const [total, structurallyInvalid, externalCollisionDocuments, programCollisionDocuments] =
      await Promise.all([
        collection.countDocuments({}),
        readCount(invalidStructurePipeline),
        readCount(duplicateExternalPipeline),
        readCount(duplicateProgramPipeline),
      ]);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error(
        "Alumni affiliation identity preflight returned invalid counts.",
      );
    }
    const integrity: AffiliationIdentityIntegrity = {
      total,
      structurallyInvalid,
      externalCollisionDocuments,
      programCollisionDocuments,
    };
    if (
      integrity.structurallyInvalid > 0 ||
      integrity.externalCollisionDocuments > 0 ||
      integrity.programCollisionDocuments > 0
    ) {
      throw new Error("Alumni affiliation identity preflight failed.");
    }
    context.signal?.throwIfAborted();
    const canonicalProgram = {
      collectionName: "alumni_affiliations",
      indexName: "uniq_alumni_affiliation_profile_program_key",
      fields: ["alumniProfileId", "programAffiliationKey"],
      partialStringField: "programAffiliationKey",
    } as const;
    const externalIdentity = {
      collectionName: "alumni_affiliations",
      indexName: "uniq_alumni_affiliation_profile_external_key",
      fields: ["alumniProfileId", "programId", "affiliationKey"],
    } as const;
    const legacyIdentity = {
      collectionName: "alumni_affiliations",
      indexName: "uniq_alumni_affiliation_profile_key",
      fields: ["alumniProfileId", "affiliationKey"],
    } as const;

    if (context.direction === "up") {
      await context.database.reconcileCompoundUniqueIndex(canonicalProgram);
      context.signal?.throwIfAborted();
      await context.database.reconcileCompoundUniqueIndex(externalIdentity);
      context.signal?.throwIfAborted();
      await context.database.dropCompoundUniqueIndexIfMatches(legacyIdentity);
    } else {
      await context.database.reconcileCompoundUniqueIndex(legacyIdentity);
      context.signal?.throwIfAborted();
      await context.database.dropCompoundUniqueIndexIfMatches(externalIdentity);
    }
    context.signal?.throwIfAborted();
  },

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const collection = context.database.collection("alumni_affiliations");
    const validHash = (field: string) => ({
      $regexMatch: {
        input: {
          $cond: [{ $eq: [{ $type: field }, "string"] }, field, ""],
        },
        regex: "^[a-f0-9]{64}$",
      },
    });
    const invalidStructurePipeline: Record<string, unknown>[] = [
      {
        $match: {
          $expr: {
            $or: [
              { $ne: [{ $type: "$alumniProfileId" }, "objectId"] },
              { $ne: [{ $type: "$programName" }, "string"] },
              { $not: [validHash("$affiliationKey")] },
              {
                $not: [
                  {
                    $in: [
                      { $type: "$cohortLabel" },
                      ["missing", "null", "string"],
                    ],
                  },
                ],
              },
              {
                $let: {
                  vars: {
                    programType: { $type: "$programId" },
                    programKeyType: { $type: "$programAffiliationKey" },
                  },
                  in: {
                    $or: [
                      {
                        $not: [
                          {
                            $in: ["$$programType", ["missing", "objectId"]],
                          },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ["$$programType", "missing"] },
                          { $ne: ["$$programKeyType", "missing"] },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ["$$programType", "objectId"] },
                          { $not: [validHash("$programAffiliationKey")] },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      { $count: "count" },
    ];
    const duplicateExternalPipeline: Record<string, unknown>[] = [
      {
        $group: {
          _id: {
            alumniProfileId: "$alumniProfileId",
            programId: { $ifNull: ["$programId", null] },
            affiliationKey: "$affiliationKey",
          },
          documents: { $sum: 1 },
        },
      },
      { $match: { documents: { $gt: 1 } } },
      { $group: { _id: null, count: { $sum: "$documents" } } },
    ];
    const duplicateProgramPipeline: Record<string, unknown>[] = [
      {
        $match: {
          $expr: {
            $eq: [{ $type: "$programAffiliationKey" }, "string"],
          },
        },
      },
      {
        $group: {
          _id: {
            alumniProfileId: "$alumniProfileId",
            programAffiliationKey: "$programAffiliationKey",
          },
          documents: { $sum: 1 },
        },
      },
      { $match: { documents: { $gt: 1 } } },
      { $group: { _id: null, count: { $sum: "$documents" } } },
    ];
    const readCount = async (
      pipeline: readonly Record<string, unknown>[],
    ): Promise<number> => {
      const rows = await collection
        .aggregate<{ readonly count?: unknown }>([...pipeline])
        .toArray();
      if (rows.length === 0) return 0;
      const count = rows.length === 1 ? rows[0]?.count : undefined;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new Error(
          "Alumni affiliation identity plan returned invalid counts.",
        );
      }
      return count;
    };
    const [structurallyInvalid, externalCollisionDocuments, programCollisionDocuments] =
      await Promise.all([
        readCount(invalidStructurePipeline),
        readCount(duplicateExternalPipeline),
        readCount(duplicateProgramPipeline),
      ]);
    const indexes = await collection
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
    const exactKey = (value: unknown, fields: readonly string[]): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      return (
        entries.length === fields.length &&
        entries.every(
          ([field, direction], index) =>
            field === fields[index] && direction === 1,
        )
      );
    };
    const exactPartial = (value: unknown, field?: string): boolean => {
      if (field === undefined) return value === undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length !== 1 || entries[0]?.[0] !== field) return false;
      const condition = entries[0]?.[1];
      if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
        return false;
      }
      const conditionEntries = Object.entries(
        condition as Record<string, unknown>,
      );
      return (
        conditionEntries.length === 1 &&
        conditionEntries[0]?.[0] === "$type" &&
        conditionEntries[0]?.[1] === "string"
      );
    };
    const exactIndex = (
      name: string,
      fields: readonly string[],
      partialStringField?: string,
    ): boolean =>
      indexes.some(
        (index) =>
          index.name === name &&
          exactKey(index.key, fields) &&
          index.unique === true &&
          index.sparse !== true &&
          index.expireAfterSeconds === undefined &&
          index.collation === undefined &&
          index.hidden !== true &&
          exactPartial(index.partialFilterExpression, partialStringField),
      );
    const canonicalReady = exactIndex(
      "uniq_alumni_affiliation_profile_program_key",
      ["alumniProfileId", "programAffiliationKey"],
      "programAffiliationKey",
    );
    const externalReady = exactIndex(
      "uniq_alumni_affiliation_profile_external_key",
      ["alumniProfileId", "programId", "affiliationKey"],
    );
    const legacyReady = exactIndex("uniq_alumni_affiliation_profile_key", [
      "alumniProfileId",
      "affiliationKey",
    ]);
    const expectedReady =
      Number(canonicalReady) + Number(externalReady) + Number(!legacyReady);
    const namedDefinitions = [
      {
        name: "uniq_alumni_affiliation_profile_program_key",
        fields: ["alumniProfileId", "programAffiliationKey"],
        partial: "programAffiliationKey",
      },
      {
        name: "uniq_alumni_affiliation_profile_external_key",
        fields: ["alumniProfileId", "programId", "affiliationKey"],
      },
      {
        name: "uniq_alumni_affiliation_profile_key",
        fields: ["alumniProfileId", "affiliationKey"],
      },
    ];
    const conflictingDefinitions = namedDefinitions.filter((definition) => {
      const named = indexes.find((index) => index.name === definition.name);
      return (
        named !== undefined &&
        !(
          exactKey(named.key, definition.fields) &&
          named.unique === true &&
          named.sparse !== true &&
          named.expireAfterSeconds === undefined &&
          named.collation === undefined &&
          named.hidden !== true &&
          exactPartial(named.partialFilterExpression, definition.partial)
        )
      );
    }).length;
    const conflictingTargetKeys = namedDefinitions
      .slice(0, 2)
      .reduce(
        (count, definition) =>
          count +
          indexes.filter(
            (index) =>
              index.name !== definition.name &&
              exactKey(index.key, definition.fields),
          ).length,
        0,
      );
    const conflictingLegacyKeys = indexes.filter(
      (index) =>
        index.name !== "uniq_alumni_affiliation_profile_key" &&
        exactKey(index.key, ["alumniProfileId", "affiliationKey"]),
    ).length;
    const conflicts =
      conflictingDefinitions + conflictingTargetKeys + conflictingLegacyKeys;
    context.signal?.throwIfAborted();
    return {
      summary: "Replace the alumni affiliation canonical identity indexes.",
      counts: {
        examined: 3,
        matched: 3,
        modified: 3 - expectedReady,
        skipped: expectedReady,
        errors: 0,
      },
      estimatedBatches: 1,
      warnings: [
        {
          code: "ALUMNI_AFFILIATION_IDENTITY_STRUCTURE_INVALID",
          count: structurallyInvalid,
        },
        {
          code: "ALUMNI_AFFILIATION_EXTERNAL_IDENTITY_COLLISION",
          count: externalCollisionDocuments,
        },
        {
          code: "ALUMNI_AFFILIATION_PROGRAM_IDENTITY_COLLISION",
          count: programCollisionDocuments,
        },
        {
          code: "ALUMNI_AFFILIATION_INDEX_DEFINITION_CONFLICT",
          count: conflicts,
        },
      ].filter((warning) => warning.count > 0),
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: { replaced: true },
      counts: {
        examined: 3,
        matched: 3,
        modified: 3,
        skipped: 0,
        errors: 0,
      },
    };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: { replaced: false },
      counts: {
        examined: 3,
        matched: 3,
        modified: 2,
        skipped: 1,
        errors: 0,
      },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const collection = context.database.collection("alumni_affiliations");
    const validHash = (field: string) => ({
      $regexMatch: {
        input: {
          $cond: [{ $eq: [{ $type: field }, "string"] }, field, ""],
        },
        regex: "^[a-f0-9]{64}$",
      },
    });
    const invalidStructurePipeline: Record<string, unknown>[] = [
      {
        $match: {
          $expr: {
            $or: [
              { $ne: [{ $type: "$alumniProfileId" }, "objectId"] },
              { $ne: [{ $type: "$programName" }, "string"] },
              { $not: [validHash("$affiliationKey")] },
              {
                $not: [
                  {
                    $in: [
                      { $type: "$cohortLabel" },
                      ["missing", "null", "string"],
                    ],
                  },
                ],
              },
              {
                $let: {
                  vars: {
                    programType: { $type: "$programId" },
                    programKeyType: { $type: "$programAffiliationKey" },
                  },
                  in: {
                    $or: [
                      {
                        $not: [
                          {
                            $in: ["$$programType", ["missing", "objectId"]],
                          },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ["$$programType", "missing"] },
                          { $ne: ["$$programKeyType", "missing"] },
                        ],
                      },
                      {
                        $and: [
                          { $eq: ["$$programType", "objectId"] },
                          { $not: [validHash("$programAffiliationKey")] },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      { $count: "count" },
    ];
    const duplicateExternalPipeline: Record<string, unknown>[] = [
      {
        $group: {
          _id: {
            alumniProfileId: "$alumniProfileId",
            programId: { $ifNull: ["$programId", null] },
            affiliationKey: "$affiliationKey",
          },
          documents: { $sum: 1 },
        },
      },
      { $match: { documents: { $gt: 1 } } },
      { $group: { _id: null, count: { $sum: "$documents" } } },
    ];
    const duplicateProgramPipeline: Record<string, unknown>[] = [
      {
        $match: {
          $expr: {
            $eq: [{ $type: "$programAffiliationKey" }, "string"],
          },
        },
      },
      {
        $group: {
          _id: {
            alumniProfileId: "$alumniProfileId",
            programAffiliationKey: "$programAffiliationKey",
          },
          documents: { $sum: 1 },
        },
      },
      { $match: { documents: { $gt: 1 } } },
      { $group: { _id: null, count: { $sum: "$documents" } } },
    ];
    const readCount = async (
      pipeline: readonly Record<string, unknown>[],
    ): Promise<number> => {
      const rows = await collection
        .aggregate<{ readonly count?: unknown }>([...pipeline])
        .toArray();
      if (rows.length === 0) return 0;
      const count = rows.length === 1 ? rows[0]?.count : undefined;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new Error(
          "Alumni affiliation identity verification returned invalid counts.",
        );
      }
      return count;
    };
    const [total, structurallyInvalid, externalCollisionDocuments, programCollisionDocuments] =
      await Promise.all([
        collection.countDocuments({}),
        readCount(invalidStructurePipeline),
        readCount(duplicateExternalPipeline),
        readCount(duplicateProgramPipeline),
      ]);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error(
        "Alumni affiliation identity verification returned invalid counts.",
      );
    }
    const integrity: AffiliationIdentityIntegrity = {
      total,
      structurallyInvalid,
      externalCollisionDocuments,
      programCollisionDocuments,
    };
    const indexes = await collection
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
    const exactKey = (value: unknown, fields: readonly string[]): boolean => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      return (
        entries.length === fields.length &&
        entries.every(
          ([field, direction], index) =>
            field === fields[index] && direction === 1,
        )
      );
    };
    const exactPartial = (value: unknown, field?: string): boolean => {
      if (field === undefined) return value === undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length !== 1 || entries[0]?.[0] !== field) return false;
      const condition = entries[0]?.[1];
      if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
        return false;
      }
      const conditionEntries = Object.entries(
        condition as Record<string, unknown>,
      );
      return (
        conditionEntries.length === 1 &&
        conditionEntries[0]?.[0] === "$type" &&
        conditionEntries[0]?.[1] === "string"
      );
    };
    const exactIndexCount = (
      name: string,
      fields: readonly string[],
      partialStringField?: string,
    ): number =>
      indexes.filter(
        (index) =>
          index.name === name &&
          exactKey(index.key, fields) &&
          index.unique === true &&
          index.sparse !== true &&
          index.expireAfterSeconds === undefined &&
          index.collation === undefined &&
          index.hidden !== true &&
          exactPartial(index.partialFilterExpression, partialStringField),
      ).length;
    const canonicalMatches = exactIndexCount(
      "uniq_alumni_affiliation_profile_program_key",
      ["alumniProfileId", "programAffiliationKey"],
      "programAffiliationKey",
    );
    const externalMatches = exactIndexCount(
      "uniq_alumni_affiliation_profile_external_key",
      ["alumniProfileId", "programId", "affiliationKey"],
    );
    const legacyMatches = exactIndexCount(
      "uniq_alumni_affiliation_profile_key",
      ["alumniProfileId", "affiliationKey"],
    );
    const canonicalKeyCount = indexes.filter((index) =>
      exactKey(index.key, ["alumniProfileId", "programAffiliationKey"]),
    ).length;
    const externalKeyCount = indexes.filter((index) =>
      exactKey(index.key, ["alumniProfileId", "programId", "affiliationKey"]),
    ).length;
    const legacyKeyCount = indexes.filter((index) =>
      exactKey(index.key, ["alumniProfileId", "affiliationKey"]),
    ).length;
    const checkpoint = context.checkpoint as { readonly replaced?: unknown } | null;
    const ok =
      integrity.structurallyInvalid === 0 &&
      integrity.externalCollisionDocuments === 0 &&
      integrity.programCollisionDocuments === 0 &&
      canonicalMatches === 1 &&
      canonicalKeyCount === 1 &&
      (context.direction === "up"
        ? checkpoint?.replaced === true &&
          externalMatches === 1 &&
          externalKeyCount === 1 &&
          legacyMatches === 0 &&
          legacyKeyCount === 0
        : checkpoint?.replaced === false &&
          externalMatches === 0 &&
          externalKeyCount === 0 &&
          legacyMatches === 1 &&
          legacyKeyCount === 1);
    const matched = canonicalMatches + externalMatches + legacyMatches;
    const examined = Math.max(indexes.length, integrity.total, 1);
    context.signal?.throwIfAborted();
    return {
      ok,
      summary: "Verified the alumni affiliation canonical identity indexes.",
      counts: {
        examined,
        matched,
        modified: 0,
        skipped: examined - matched,
        errors: ok ? 0 : 1,
      },
    };
  },
} satisfies MigrationSourceDefinition;
