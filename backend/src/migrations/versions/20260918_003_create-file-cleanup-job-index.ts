import type { MigrationSourceDefinition } from "../types";

export const migration = {
  id: "20260918_003_create-file-cleanup-job-index",
  description:
    "Create the unique durable avatar and image cleanup-job index used by account deletion.",

  prepare: async (context) => {
    context.signal?.throwIfAborted();
    if (context.direction === "up") {
      await context.database.reconcileUniqueIndex({
        collectionName: "filecleanupjobs",
        indexName: "uniq_file_cleanup_job",
        field: "jobKey",
      });
    } else {
      await context.database.dropIndexIfMatches({
        collectionName: "filecleanupjobs",
        indexName: "uniq_file_cleanup_job",
        field: "jobKey",
      });
    }
    context.signal?.throwIfAborted();
  },

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const indexes: Array<{
      readonly name?: string;
      readonly key: Readonly<Record<string, unknown>>;
      readonly unique?: boolean;
    }> = await context.database
      .collection("filecleanupjobs")
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
        // A fresh namespace is the normal first-deploy state.
        return [];
      });
    const ready = indexes.some((index) => {
      const entries = Object.entries(index.key);
      return (
        index.name === "uniq_file_cleanup_job" &&
        index.unique === true &&
        entries.length === 1 &&
        entries[0]?.[0] === "jobKey" &&
        entries[0]?.[1] === 1
      );
    });
    return {
      summary: "Reconcile the durable file-cleanup job index.",
      counts: {
        examined: indexes.length,
        matched: Number(ready),
        modified: Number(!ready),
        skipped: Number(ready),
        errors: 0,
      },
      estimatedBatches: 1,
      warnings: [],
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: null,
      counts: {
        examined: 1,
        matched: 1,
        modified: 1,
        skipped: 0,
        errors: 0,
      },
    };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true,
      checkpoint: null,
      counts: {
        examined: 1,
        matched: 1,
        modified: 1,
        skipped: 0,
        errors: 0,
      },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const indexes: Array<{
      readonly name?: string;
      readonly key: Readonly<Record<string, unknown>>;
      readonly unique?: boolean;
    }> = await context.database
      .collection("filecleanupjobs")
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
    const matches = indexes.filter((index) => {
      const entries = Object.entries(index.key);
      return (
        index.name === "uniq_file_cleanup_job" &&
        index.unique === true &&
        entries.length === 1 &&
        entries[0]?.[0] === "jobKey" &&
        entries[0]?.[1] === 1
      );
    }).length;
    const ok = context.direction === "up" ? matches === 1 : matches === 0;
    return {
      ok,
      summary: "Verified the durable file-cleanup job index.",
      counts: {
        examined: indexes.length,
        matched: matches,
        modified: 0,
        skipped: indexes.length - matches,
        errors: ok ? 0 : 1,
      },
    };
  },
} satisfies MigrationSourceDefinition;
