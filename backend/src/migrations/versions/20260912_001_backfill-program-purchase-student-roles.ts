import type { MigrationSourceDefinition } from "../types";

type ProgramRoleDocument = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly discountEligible?: unknown;
};

type ProgramDocument = {
  readonly programRoles?: {
    readonly studentRoles?: readonly ProgramRoleDocument[] | unknown;
  } | null;
};

type JoinedPurchaseDocument = {
  readonly _id?: unknown;
  readonly studentRoleId?: unknown;
  readonly isClassRep?: unknown;
  readonly __migrationCursorId?: unknown;
  readonly __program?: readonly ProgramDocument[];
};

type PurchaseRoleResolution = {
  readonly state: "valid" | "candidate" | "ambiguous" | "unavailable";
  readonly candidate?: string;
  readonly fieldState: "present" | "missing" | "invalid";
};

type ApplyCheckpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
};

type RollbackCheckpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
};

type PurchaseRoleBackup = {
  readonly _id?: unknown;
  readonly previousStudentRoleIdPresent?: unknown;
  readonly previousStudentRoleId?: unknown;
  readonly migratedStudentRoleId?: unknown;
  readonly migrationRunId?: unknown;
  readonly __migrationCursorId?: unknown;
};

export const migration = {
  id: "20260912_001_backfill-program-purchase-student-roles",
  description:
    "Backfill deterministic student roles on effective historical Program purchases.",

  plan: async (context) => {
    const classify = (
      document: JoinedPurchaseDocument,
    ): PurchaseRoleResolution => {
      const program = Array.isArray(document.__program)
        ? document.__program[0]
        : undefined;
      if (!program || typeof program !== "object") {
        return {
          state: "unavailable",
          fieldState:
            document.studentRoleId === undefined ||
            document.studentRoleId === null ||
            (typeof document.studentRoleId === "string" &&
              document.studentRoleId.trim() === "")
              ? "missing"
              : "invalid",
        };
      }

      const sourceRoles: readonly ProgramRoleDocument[] = Array.isArray(
        program.programRoles?.studentRoles,
      )
        ? (program.programRoles.studentRoles as readonly ProgramRoleDocument[])
        : [];
      const usingLegacyDefaults = sourceRoles.length === 0;
      const rawRoles =
        !usingLegacyDefaults
          ? sourceRoles
          : [
              { id: "mentee", name: "Mentee", discountEligible: false },
              {
                id: "classRep",
                name: "Class Representative",
                discountEligible: true,
              },
            ];
      const usedIds = new Set<string>();
      const roles = rawRoles.map(
        (rawValue: ProgramRoleDocument, index: number) => {
        const raw =
          rawValue && typeof rawValue === "object"
            ? (rawValue as ProgramRoleDocument)
            : {};
        const name =
          typeof raw.name === "string" && raw.name.trim()
            ? raw.name.trim()
            : index === 0
              ? "Mentee"
              : `Student Role ${index + 1}`;
        const source =
          typeof raw.id === "string" && raw.id.trim() ? raw.id : name;
        const baseId =
          usingLegacyDefaults && typeof raw.id === "string" && raw.id.trim()
            ? raw.id.trim()
            : source
            .trim()
            .replace(/([a-z])([A-Z])/gu, "$1-$2")
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-+|-+$/gu, "") || `student-role-${index + 1}`;
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${baseId}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(id);
          return { id, discountEligible: raw.discountEligible === true };
        },
      );
      const fieldState =
        document.studentRoleId === undefined ||
        document.studentRoleId === null ||
        (typeof document.studentRoleId === "string" &&
          document.studentRoleId.trim() === "")
          ? "missing"
          : typeof document.studentRoleId === "string"
            ? "present"
            : "invalid";
      if (
        typeof document.studentRoleId === "string" &&
        roles.some((role) => role.id === document.studentRoleId)
      ) {
        return { state: "valid", fieldState: "present" };
      }
      if (typeof document.isClassRep !== "boolean") {
        return { state: "unavailable", fieldState };
      }

      const category = roles.filter(
        (role) => role.discountEligible === document.isClassRep,
      );
      const legacyIds = document.isClassRep
        ? new Set(["classRep", "class-rep"])
        : new Set(["mentee"]);
      const legacy = category.filter((role) => legacyIds.has(role.id));
      if (legacy.length === 1) {
        return {
          state: "candidate",
          candidate: legacy[0]!.id,
          fieldState,
        };
      }
      if (legacy.length > 1 || category.length > 1) {
        return { state: "ambiguous", fieldState };
      }
      return category.length === 1
        ? { state: "candidate", candidate: category[0]!.id, fieldState }
        : { state: "unavailable", fieldState };
    };

    const counts = {
      examined: 0,
      matched: 0,
      modified: 0,
      skipped: 0,
      errors: 0,
    };
    const diagnostics = {
      missing: 0,
      invalid: 0,
      autoResolvable: 0,
      ambiguous: 0,
      unavailable: 0,
    };
    const cursor = context.database
      .collection<JoinedPurchaseDocument>("purchases")
      .aggregate<JoinedPurchaseDocument>([
        {
          $match: {
            purchaseType: "program",
            status: "completed",
            unenrolledAt: { $exists: false },
          },
        },
        {
          $lookup: {
            from: "programs",
            localField: "programId",
            foreignField: "_id",
            pipeline: [
              {
                $project: {
                  _id: 0,
                  programRoles: 1,
                },
              },
              { $limit: 1 },
            ],
            as: "__program",
          },
        },
        {
          $project: {
            studentRoleId: 1,
            isClassRep: 1,
            __program: 1,
          },
        },
      ], {
        allowDiskUse: true,
        batchSize: context.batchSize,
      });
    await cursor.forEach((document) => {
      counts.examined += 1;
      const resolution = classify(document);
      if (resolution.state === "valid") {
        counts.skipped += 1;
        return;
      }
      counts.matched += 1;
      if (resolution.fieldState === "missing") diagnostics.missing += 1;
      else diagnostics.invalid += 1;
      if (resolution.state === "candidate") diagnostics.autoResolvable += 1;
      else if (resolution.state === "ambiguous") diagnostics.ambiguous += 1;
      else diagnostics.unavailable += 1;
    });

    const warningPairs: readonly (readonly [string, number])[] = [
      ["PROGRAM_PURCHASE_ROLE_MISSING", diagnostics.missing],
      ["PROGRAM_PURCHASE_ROLE_INVALID", diagnostics.invalid],
      [
        "PROGRAM_PURCHASE_ROLE_AUTO_RESOLVABLE",
        diagnostics.autoResolvable,
      ],
      ["PROGRAM_PURCHASE_ROLE_AMBIGUOUS", diagnostics.ambiguous],
      ["PROGRAM_PURCHASE_ROLE_UNAVAILABLE", diagnostics.unavailable],
    ];
    return {
      summary:
        "Inventory effective Program purchases and identify deterministic legacy student-role repairs.",
      counts,
      estimatedBatches: Math.ceil(counts.examined / context.batchSize),
      warnings: warningPairs
        .filter((entry) => entry[1] > 0)
        .map((entry) => ({ code: entry[0], count: entry[1] })),
    };
  },

  up: async (context) => {
    const classify = (
      document: JoinedPurchaseDocument,
    ): PurchaseRoleResolution => {
      const program = Array.isArray(document.__program)
        ? document.__program[0]
        : undefined;
      if (!program || typeof program !== "object") {
        return {
          state: "unavailable",
          fieldState:
            document.studentRoleId === undefined ||
            document.studentRoleId === null ||
            (typeof document.studentRoleId === "string" &&
              document.studentRoleId.trim() === "")
              ? "missing"
              : "invalid",
        };
      }
      const sourceRoles: readonly ProgramRoleDocument[] = Array.isArray(
        program.programRoles?.studentRoles,
      )
        ? (program.programRoles.studentRoles as readonly ProgramRoleDocument[])
        : [];
      const usingLegacyDefaults = sourceRoles.length === 0;
      const rawRoles =
        !usingLegacyDefaults
          ? sourceRoles
          : [
              { id: "mentee", name: "Mentee", discountEligible: false },
              {
                id: "classRep",
                name: "Class Representative",
                discountEligible: true,
              },
            ];
      const usedIds = new Set<string>();
      const roles = rawRoles.map(
        (rawValue: ProgramRoleDocument, index: number) => {
        const raw =
          rawValue && typeof rawValue === "object"
            ? (rawValue as ProgramRoleDocument)
            : {};
        const name =
          typeof raw.name === "string" && raw.name.trim()
            ? raw.name.trim()
            : index === 0
              ? "Mentee"
              : `Student Role ${index + 1}`;
        const source =
          typeof raw.id === "string" && raw.id.trim() ? raw.id : name;
        const baseId =
          usingLegacyDefaults && typeof raw.id === "string" && raw.id.trim()
            ? raw.id.trim()
            : source
            .trim()
            .replace(/([a-z])([A-Z])/gu, "$1-$2")
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-+|-+$/gu, "") || `student-role-${index + 1}`;
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${baseId}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(id);
          return { id, discountEligible: raw.discountEligible === true };
        },
      );
      const fieldState =
        document.studentRoleId === undefined ||
        document.studentRoleId === null ||
        (typeof document.studentRoleId === "string" &&
          document.studentRoleId.trim() === "")
          ? "missing"
          : typeof document.studentRoleId === "string"
            ? "present"
            : "invalid";
      if (
        typeof document.studentRoleId === "string" &&
        roles.some((role) => role.id === document.studentRoleId)
      ) {
        return { state: "valid", fieldState: "present" };
      }
      if (typeof document.isClassRep !== "boolean") {
        return { state: "unavailable", fieldState };
      }
      const category = roles.filter(
        (role) => role.discountEligible === document.isClassRep,
      );
      const legacyIds = document.isClassRep
        ? new Set(["classRep", "class-rep"])
        : new Set(["mentee"]);
      const legacy = category.filter((role) => legacyIds.has(role.id));
      if (legacy.length === 1) {
        return {
          state: "candidate",
          candidate: legacy[0]!.id,
          fieldState,
        };
      }
      if (legacy.length > 1 || category.length > 1) {
        return { state: "ambiguous", fieldState };
      }
      return category.length === 1
        ? { state: "candidate", candidate: category[0]!.id, fieldState }
        : { state: "unavailable", fieldState };
    };

    const purchases =
      context.database.collection<JoinedPurchaseDocument>("purchases");
    const backups =
      context.database.collection<PurchaseRoleBackup>(
        "migration_20260912_program_purchase_role_backups",
      );
    const previous = context.checkpoint as ApplyCheckpoint | null;
    let highWatermark = previous?.highWatermark ?? null;
    const lastId = previous?.lastId ?? null;

    if (context.checkpoint === null) {
      const newest = await purchases
        .aggregate<{ readonly cursorId?: unknown }>([
          {
            $match: {
              purchaseType: "program",
              status: "completed",
              unenrolledAt: { $exists: false },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
        ])
        .toArray();
      highWatermark =
        typeof newest[0]?.cursorId === "string" ? newest[0].cursorId : null;
    }

    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: { highWatermark: null, lastId: null },
        counts: {
          examined: 0,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }

    const idRangeExpression = {
      $and: [
        { $lte: ["$_id", { $toObjectId: highWatermark }] },
        ...(lastId === null
          ? []
          : [{ $gt: ["$_id", { $toObjectId: lastId }] }]),
      ],
    };
    const page = await purchases
      .aggregate<JoinedPurchaseDocument>([
        {
          $match: {
            purchaseType: "program",
            status: "completed",
            unenrolledAt: { $exists: false },
          },
        },
        { $match: { $expr: idRangeExpression } },
        { $sort: { _id: 1 } },
        { $limit: context.batchSize + 1 },
        {
          $lookup: {
            from: "programs",
            localField: "programId",
            foreignField: "_id",
            pipeline: [
              { $project: { _id: 0, programRoles: 1 } },
              { $limit: 1 },
            ],
            as: "__program",
          },
        },
        {
          $project: {
            studentRoleId: 1,
            isClassRep: 1,
            __migrationCursorId: { $toString: "$_id" },
            __program: 1,
          },
        },
      ], {
        allowDiskUse: true,
        batchSize: context.batchSize + 1,
      })
      .toArray();
    const batch = page.slice(0, context.batchSize);
    const resolved = batch.map((document) => ({
      document,
      resolution: classify(document),
    }));
    if (
      resolved.some(
        ({ resolution }) =>
          resolution.state === "ambiguous" ||
          resolution.state === "unavailable",
      )
    ) {
      throw new Error(
        "Program purchase student-role migration requires operator resolution.",
      );
    }

    const candidates = resolved.filter(
      (
        entry,
      ): entry is typeof entry & {
        readonly resolution: PurchaseRoleResolution & {
          readonly state: "candidate";
          readonly candidate: string;
        };
      } => entry.resolution.state === "candidate",
    );
    if (candidates.length > 0) {
      const backupOperations = candidates.map(({ document, resolution }) => {
          const previousPresent = Object.prototype.hasOwnProperty.call(
            document,
            "studentRoleId",
          );
          return {
            updateOne: {
              filter: {
                _id: document._id,
                migratedStudentRoleId: resolution.candidate,
                previousStudentRoleIdPresent: previousPresent,
                ...(previousPresent
                  ? { previousStudentRoleId: document.studentRoleId }
                  : { previousStudentRoleId: { $exists: false } }),
              },
              update: {
                $setOnInsert: {
                  _id: document._id,
                  previousStudentRoleIdPresent: previousPresent,
                  ...(previousPresent
                    ? { previousStudentRoleId: document.studentRoleId }
                    : {}),
                  migratedStudentRoleId: resolution.candidate,
                  migrationRunId: context.runId,
                },
              },
              upsert: true,
            },
          };
        });
      const backupResult = await backups.bulkWrite(
        backupOperations as unknown as Parameters<typeof backups.bulkWrite>[0],
        { ordered: true },
      );
      if (backupResult.upsertedCount !== candidates.length) {
        throw new Error("Program purchase role backup compare-and-set failed.");
      }

      const purchaseOperations = candidates.map(({ document, resolution }) => {
          const previousPresent = Object.prototype.hasOwnProperty.call(
            document,
            "studentRoleId",
          );
          const priorRoleFilter = previousPresent
            ? {
                $and: [
                  { studentRoleId: document.studentRoleId },
                  { studentRoleId: { $exists: true } },
                ],
              }
            : { studentRoleId: { $exists: false } };
          return {
            updateOne: {
              filter: {
                _id: document._id,
                purchaseType: "program",
                status: "completed",
                unenrolledAt: { $exists: false },
                isClassRep: document.isClassRep,
                ...priorRoleFilter,
              },
              update: { $set: { studentRoleId: resolution.candidate } },
            },
          };
        });
      const purchaseResult = await purchases.bulkWrite(
        purchaseOperations as unknown as Parameters<typeof purchases.bulkWrite>[0],
        { ordered: true },
      );
      if (
        purchaseResult.matchedCount !== candidates.length ||
        purchaseResult.modifiedCount !== candidates.length
      ) {
        throw new Error("Program purchase role compare-and-set failed.");
      }
    }

    const nextLastId =
      batch.length === 0
        ? lastId
        : typeof batch[batch.length - 1]?.__migrationCursorId === "string"
          ? (batch[batch.length - 1]?.__migrationCursorId as string)
          : lastId;
    const checkpoint: ApplyCheckpoint = {
      highWatermark,
      lastId: nextLastId,
    };
    const matched = candidates.length;
    const resultCounts = {
      examined: batch.length,
      matched,
      modified: matched,
      skipped: batch.length - matched,
      errors: 0,
    };
    return page.length <= context.batchSize
      ? { done: true, checkpoint, counts: resultCounts }
      : { done: false, checkpoint, counts: resultCounts };
  },

  down: async (context) => {
    const purchases =
      context.database.collection<JoinedPurchaseDocument>("purchases");
    const backups =
      context.database.collection<PurchaseRoleBackup>(
        "migration_20260912_program_purchase_role_backups",
      );
    const previous = context.checkpoint as RollbackCheckpoint | null;
    let highWatermark = previous?.highWatermark ?? null;
    const lastId = previous?.lastId ?? null;

    if (context.checkpoint === null) {
      const newest = await backups
        .aggregate<{ readonly cursorId?: unknown }>([
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
        ])
        .toArray();
      highWatermark =
        typeof newest[0]?.cursorId === "string" ? newest[0].cursorId : null;
    }
    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: { highWatermark: null, lastId: null },
        counts: {
          examined: 0,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }

    const idRangeExpression = {
      $and: [
        { $lte: ["$_id", { $toObjectId: highWatermark }] },
        ...(lastId === null
          ? []
          : [{ $gt: ["$_id", { $toObjectId: lastId }] }]),
      ],
    };
    const page = await backups
      .aggregate<PurchaseRoleBackup>([
        { $match: { $expr: idRangeExpression } },
        { $sort: { _id: 1 } },
        { $limit: context.batchSize + 1 },
        {
          $project: {
            previousStudentRoleIdPresent: 1,
            previousStudentRoleId: 1,
            migratedStudentRoleId: 1,
            __migrationCursorId: { $toString: "$_id" },
          },
        },
      ])
      .toArray();
    const batch = page.slice(0, context.batchSize);
    if (
      batch.some(
        (backup) =>
          typeof backup.previousStudentRoleIdPresent !== "boolean" ||
          typeof backup.migratedStudentRoleId !== "string" ||
          !backup.migratedStudentRoleId,
      )
    ) {
      throw new Error("Program purchase role backup is invalid.");
    }

    if (batch.length > 0) {
      const restoreOperations = batch.map((backup) => ({
          updateOne: {
            filter: {
              _id: backup._id,
              studentRoleId: backup.migratedStudentRoleId,
            },
            update:
              backup.previousStudentRoleIdPresent === true
                ? { $set: { studentRoleId: backup.previousStudentRoleId } }
                : { $unset: { studentRoleId: "" } },
          },
        }));
      const restoreResult = await purchases.bulkWrite(
        restoreOperations as unknown as Parameters<typeof purchases.bulkWrite>[0],
        { ordered: true },
      );
      if (
        restoreResult.matchedCount !== batch.length ||
        restoreResult.modifiedCount !== batch.length
      ) {
        throw new Error("Program purchase role rollback compare-and-set failed.");
      }
      const backupDeleteFilter = {
        _id: { $in: batch.map((backup) => backup._id) },
      } as unknown as Parameters<typeof backups.deleteMany>[0];
      const deleted = await backups.deleteMany(backupDeleteFilter);
      if (deleted.deletedCount !== batch.length) {
        throw new Error("Program purchase role backup cleanup failed.");
      }
    }

    const nextLastId =
      batch.length === 0
        ? lastId
        : typeof batch[batch.length - 1]?.__migrationCursorId === "string"
          ? (batch[batch.length - 1]?.__migrationCursorId as string)
          : lastId;
    const checkpoint: RollbackCheckpoint = {
      highWatermark,
      lastId: nextLastId,
    };
    const counts = {
      examined: batch.length,
      matched: batch.length,
      modified: batch.length,
      skipped: 0,
      errors: 0,
    };
    return page.length <= context.batchSize
      ? { done: true, checkpoint, counts }
      : { done: false, checkpoint, counts };
  },

  verify: async (context) => {
    if (context.direction === "down") {
      const remaining = await context.database
        .collection<PurchaseRoleBackup>(
          "migration_20260912_program_purchase_role_backups",
        )
        .countDocuments({});
      return {
        ok: remaining === 0,
        summary: "Program purchase student-role rollback backups verified.",
        counts: {
          examined: remaining,
          matched: remaining,
          modified: 0,
          skipped: 0,
          errors: remaining === 0 ? 0 : remaining,
        },
      };
    }

    const classify = (
      document: JoinedPurchaseDocument,
    ): PurchaseRoleResolution => {
      const program = Array.isArray(document.__program)
        ? document.__program[0]
        : undefined;
      if (!program || typeof program !== "object") {
        return { state: "unavailable", fieldState: "invalid" };
      }
      const sourceRoles: readonly ProgramRoleDocument[] = Array.isArray(
        program.programRoles?.studentRoles,
      )
        ? (program.programRoles.studentRoles as readonly ProgramRoleDocument[])
        : [];
      const usingLegacyDefaults = sourceRoles.length === 0;
      const rawRoles =
        !usingLegacyDefaults
          ? sourceRoles
          : [
              { id: "mentee", name: "Mentee", discountEligible: false },
              {
                id: "classRep",
                name: "Class Representative",
                discountEligible: true,
              },
            ];
      const usedIds = new Set<string>();
      const roles = rawRoles.map(
        (rawValue: ProgramRoleDocument, index: number) => {
        const raw =
          rawValue && typeof rawValue === "object"
            ? (rawValue as ProgramRoleDocument)
            : {};
        const name =
          typeof raw.name === "string" && raw.name.trim()
            ? raw.name.trim()
            : index === 0
              ? "Mentee"
              : `Student Role ${index + 1}`;
        const source =
          typeof raw.id === "string" && raw.id.trim() ? raw.id : name;
        const baseId =
          usingLegacyDefaults && typeof raw.id === "string" && raw.id.trim()
            ? raw.id.trim()
            : source
            .trim()
            .replace(/([a-z])([A-Z])/gu, "$1-$2")
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-+|-+$/gu, "") || `student-role-${index + 1}`;
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${baseId}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(id);
          return { id, discountEligible: raw.discountEligible === true };
        },
      );
      if (
        typeof document.studentRoleId === "string" &&
        roles.some((role) => role.id === document.studentRoleId)
      ) {
        return { state: "valid", fieldState: "present" };
      }
      return {
        state: "unavailable",
        fieldState:
          document.studentRoleId === undefined ||
          document.studentRoleId === null ||
          (typeof document.studentRoleId === "string" &&
            document.studentRoleId.trim() === "")
            ? "missing"
            : "invalid",
      };
    };

    let examined = 0;
    let unresolved = 0;
    const cursor = context.database
      .collection<JoinedPurchaseDocument>("purchases")
      .aggregate<JoinedPurchaseDocument>([
        {
          $match: {
            purchaseType: "program",
            status: "completed",
            unenrolledAt: { $exists: false },
          },
        },
        {
          $lookup: {
            from: "programs",
            localField: "programId",
            foreignField: "_id",
            pipeline: [
              { $project: { _id: 0, programRoles: 1 } },
              { $limit: 1 },
            ],
            as: "__program",
          },
        },
        {
          $project: {
            studentRoleId: 1,
            __program: 1,
          },
        },
      ], {
        allowDiskUse: true,
        batchSize: context.batchSize,
      });
    await cursor.forEach((document) => {
      examined += 1;
      if (classify(document).state !== "valid") unresolved += 1;
    });
    const checkpointValid =
      context.checkpoint !== null &&
      "highWatermark" in context.checkpoint &&
      "lastId" in context.checkpoint;
    const errors = unresolved + (checkpointValid ? 0 : 1);
    return {
      ok: errors === 0,
      summary:
        "Effective Program purchase student-role coverage verified without exposing purchase data.",
      counts: {
        examined: examined + (checkpointValid ? 0 : 1),
        matched: unresolved + (checkpointValid ? 0 : 1),
        modified: 0,
        skipped: examined - unresolved,
        errors,
      },
    };
  },
} satisfies MigrationSourceDefinition;
