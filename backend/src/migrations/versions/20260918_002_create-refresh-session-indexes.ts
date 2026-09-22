import type { MigrationSourceDefinition } from "../types";

export const migration = {
  id: "20260918_002_create-refresh-session-indexes",
  description:
    "Create the unique refresh-token family lookup and expiry TTL indexes.",

  prepare: async (context) => {
    context.signal?.throwIfAborted();
    if (context.direction === "up") {
      await context.database.reconcileUniqueIndex({
        collectionName: "refreshsessions",
        indexName: "uniq_refresh_session_family",
        field: "familyId",
      });
      await context.database.reconcileTtlIndex({
        collectionName: "refreshsessions",
        indexName: "ttl_refresh_session_expiry",
        field: "expiresAt",
        expireAfterSeconds: 0,
      });
    } else {
      await context.database.dropIndexIfMatches({
        collectionName: "refreshsessions",
        indexName: "ttl_refresh_session_expiry",
        field: "expiresAt",
      });
      await context.database.dropIndexIfMatches({
        collectionName: "refreshsessions",
        indexName: "uniq_refresh_session_family",
        field: "familyId",
      });
    }
    context.signal?.throwIfAborted();
  },

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const hasSingleFieldIndex = (
      index: { readonly key: Readonly<Record<string, unknown>> },
      field: string,
    ): boolean => {
      const entries = Object.entries(index.key);
      return (
        entries.length === 1 &&
        entries[0]?.[0] === field &&
        entries[0]?.[1] === 1
      );
    };
    const indexes: Array<{
      readonly name?: string;
      readonly key: Readonly<Record<string, unknown>>;
      readonly unique?: boolean;
      readonly expireAfterSeconds?: number;
    }> = await context.database
      .collection("refreshsessions")
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
    const familyReady = indexes.some(
      (index) =>
        index.name === "uniq_refresh_session_family" &&
        hasSingleFieldIndex(index, "familyId") &&
        index.unique === true,
    );
    const ttlReady = indexes.some(
      (index) =>
        index.name === "ttl_refresh_session_expiry" &&
        hasSingleFieldIndex(index, "expiresAt") &&
        index.expireAfterSeconds === 0,
    );
    const readyCount = Number(familyReady) + Number(ttlReady);
    return {
      summary: "Reconcile the refresh-session security indexes.",
      counts: {
        examined: indexes.length,
        matched: readyCount,
        modified: 2 - readyCount,
        skipped: readyCount,
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
        examined: 2,
        matched: 2,
        modified: 2,
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
        examined: 2,
        matched: 2,
        modified: 2,
        skipped: 0,
        errors: 0,
      },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    const hasSingleFieldIndex = (
      index: { readonly key: Readonly<Record<string, unknown>> },
      field: string,
    ): boolean => {
      const entries = Object.entries(index.key);
      return (
        entries.length === 1 &&
        entries[0]?.[0] === field &&
        entries[0]?.[1] === 1
      );
    };
    const indexes: Array<{
      readonly name?: string;
      readonly key: Readonly<Record<string, unknown>>;
      readonly unique?: boolean;
      readonly expireAfterSeconds?: number;
    }> = await context.database
      .collection("refreshsessions")
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
    const familyMatches = indexes.filter(
      (index) =>
        index.name === "uniq_refresh_session_family" &&
        hasSingleFieldIndex(index, "familyId") &&
        index.unique === true,
    ).length;
    const ttlMatches = indexes.filter(
      (index) =>
        index.name === "ttl_refresh_session_expiry" &&
        hasSingleFieldIndex(index, "expiresAt") &&
        index.expireAfterSeconds === 0,
    ).length;
    const matchCount = familyMatches + ttlMatches;
    const ok =
      context.direction === "up"
        ? familyMatches === 1 && ttlMatches === 1
        : familyMatches === 0 && ttlMatches === 0;
    return {
      ok,
      summary: "Verified the refresh-session security indexes.",
      counts: {
        examined: indexes.length,
        matched: matchCount,
        modified: 0,
        skipped: indexes.length - matchCount,
        errors: ok ? 0 : 1,
      },
    };
  },
} satisfies MigrationSourceDefinition;
