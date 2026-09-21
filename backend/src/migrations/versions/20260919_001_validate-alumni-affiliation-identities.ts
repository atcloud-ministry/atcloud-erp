import type { MigrationSourceDefinition } from "../types";

type AffiliationIdentityPreflightCheckpoint = {
  readonly validated: boolean;
};

type AffiliationIdentityPreflightCounts = {
  readonly total: number;
  readonly structurallyInvalid: number;
  readonly externalCollisionDocuments: number;
  readonly programCollisionDocuments: number;
};

export const migration = {
  id: "20260919_001_validate-alumni-affiliation-identities",
  description:
    "Validate alumni affiliation identity structure and unique-index collisions.",

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const collection = context.database.collection("alumni_affiliations");
    const readCount = async (pipeline: Record<string, unknown>[]) => {
      const result = await collection
        .aggregate<{ readonly count?: unknown }>([...pipeline, { $count: "count" }])
        .toArray();
      return typeof result[0]?.count === "number" &&
        Number.isSafeInteger(result[0].count) &&
        result[0].count >= 0
        ? result[0].count
        : 0;
    };
    const validHash = (field: string) => ({
      $regexMatch: {
        input: {
          $cond: [
            { $eq: [{ $type: field }, "string"] },
            field,
            "",
          ],
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
    const [total, structurallyInvalid, externalRows, programRows] =
      await Promise.all([
        collection.countDocuments({}),
        readCount(invalidStructurePipeline),
        collection
          .aggregate<{ readonly count?: unknown }>(duplicateExternalPipeline)
          .toArray(),
        collection
          .aggregate<{ readonly count?: unknown }>(duplicateProgramPipeline)
          .toArray(),
      ]);
    const safeCollisionCount = (
      rows: readonly { readonly count?: unknown }[],
    ): number =>
      typeof rows[0]?.count === "number" &&
      Number.isSafeInteger(rows[0].count) &&
      rows[0].count >= 0
        ? rows[0].count
        : 0;
    const counts: AffiliationIdentityPreflightCounts = {
      total,
      structurallyInvalid,
      externalCollisionDocuments: safeCollisionCount(externalRows),
      programCollisionDocuments: safeCollisionCount(programRows),
    };
    const issueCount =
      counts.structurallyInvalid +
      counts.externalCollisionDocuments +
      counts.programCollisionDocuments;
    const affectedDocuments = Math.min(counts.total, issueCount);
    context.signal?.throwIfAborted();
    return {
      summary: "Validate alumni affiliation identity structure and collisions.",
      counts: {
        examined: counts.total,
        matched: affectedDocuments,
        modified: 0,
        skipped: counts.total - affectedDocuments,
        errors: 0,
      },
      estimatedBatches: 1,
      warnings: [
        {
          code: "ALUMNI_AFFILIATION_IDENTITY_STRUCTURE_INVALID",
          count: counts.structurallyInvalid,
        },
        {
          code: "ALUMNI_AFFILIATION_EXTERNAL_IDENTITY_COLLISION",
          count: counts.externalCollisionDocuments,
        },
        {
          code: "ALUMNI_AFFILIATION_PROGRAM_IDENTITY_COLLISION",
          count: counts.programCollisionDocuments,
        },
      ].filter((warning) => warning.count > 0),
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: { validated: true },
      counts: {
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
    };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: { validated: false },
      counts: {
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const checkpoint =
      context.checkpoint as AffiliationIdentityPreflightCheckpoint | null;
    if (context.direction === "down") {
      const ok = checkpoint?.validated === false;
      return {
        ok,
        summary: "Verified alumni affiliation identity preflight rollback.",
        counts: {
          examined: ok ? 0 : 1,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: ok ? 0 : 1,
        },
      };
    }

    const collection = context.database.collection("alumni_affiliations");
    const validHash = (field: string) => ({
      $regexMatch: {
        input: {
          $cond: [
            { $eq: [{ $type: field }, "string"] },
            field,
            "",
          ],
        },
        regex: "^[a-f0-9]{64}$",
      },
    });
    const invalidStructure = await collection
      .aggregate<{ readonly count?: unknown }>([
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
                              $in: [
                                "$$programType",
                                ["missing", "objectId"],
                              ],
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
      ])
      .toArray();
    const externalCollisions = await collection
      .aggregate<{ readonly count?: unknown }>([
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
      ])
      .toArray();
    const programCollisions = await collection
      .aggregate<{ readonly count?: unknown }>([
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
      ])
      .toArray();
    const safeCount = (rows: readonly { readonly count?: unknown }[]): number =>
      typeof rows[0]?.count === "number" &&
      Number.isSafeInteger(rows[0].count) &&
      rows[0].count >= 0
        ? rows[0].count
        : 0;
    const issueCount =
      safeCount(invalidStructure) +
      safeCount(externalCollisions) +
      safeCount(programCollisions);
    const total = await collection.countDocuments({});
    const affectedDocuments = Math.min(total, issueCount);
    const checkpointError = checkpoint?.validated === true ? 0 : 1;
    const errors = Math.max(affectedDocuments, checkpointError);
    const examined = Math.max(total, checkpointError);
    const ok = errors === 0;
    context.signal?.throwIfAborted();
    return {
      ok,
      summary: "Verified alumni affiliation identity structure and collisions.",
      counts: {
        examined,
        matched: affectedDocuments,
        modified: 0,
        skipped: 0,
        errors,
      },
    };
  },
} satisfies MigrationSourceDefinition;
