import type { MigrationSourceDefinition } from "../types";

export const migration = {
  id: "20260918_001_enforce-audit-log-ttl",
  description:
    "Enforce the approved 365-day AuditLog fallback TTL index.",

  prepare: async (context) => {
    context.signal?.throwIfAborted();
    await context.database.reconcileTtlIndex({
      collectionName: "auditlogs",
      indexName: "createdAt_1",
      field: "createdAt",
      expireAfterSeconds:
        context.direction === "up" ? 31_536_000 : 63_072_000,
    });
    context.signal?.throwIfAborted();
  },

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const indexes = await context.database
      .collection("auditlogs")
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
    const current = indexes.find((index) => {
      const entries = Object.entries(index.key);
      return (
        entries.length === 1 &&
        entries[0]?.[0] === "createdAt" &&
        entries[0]?.[1] === 1
      );
    });
    const alreadyApproved = current?.expireAfterSeconds === 31_536_000;
    return {
      summary: "Reconcile the AuditLog createdAt TTL index to 365 days.",
      counts: {
        examined: current ? 1 : 0,
        matched: current ? 1 : 0,
        modified: alreadyApproved ? 0 : 1,
        skipped: alreadyApproved ? 1 : 0,
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
    const indexes = await context.database
      .collection("auditlogs")
      .listIndexes()
      .toArray();
    const expectedSeconds =
      context.direction === "up" ? 31_536_000 : 63_072_000;
    const matching = indexes.filter((index) => {
      const entries = Object.entries(index.key);
      return (
        entries.length === 1 &&
        entries[0]?.[0] === "createdAt" &&
        entries[0]?.[1] === 1 &&
        index.expireAfterSeconds === expectedSeconds
      );
    });
    return {
      ok: matching.length === 1,
      summary: "Verified the AuditLog createdAt TTL index definition.",
      counts: {
        examined: indexes.length,
        matched: matching.length,
        modified: 0,
        skipped: indexes.length - matching.length,
        errors: matching.length === 1 ? 0 : 1,
      },
    };
  },
} satisfies MigrationSourceDefinition;
