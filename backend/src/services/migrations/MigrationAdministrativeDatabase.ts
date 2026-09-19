import type { Connection } from "mongoose";
import type { IndexDescriptionInfo } from "mongodb";
import { MigrationUsageError } from "./MigrationErrors";
import { requireMigrationCollectionName } from "./MigrationReadDatabase";

const INDEX_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,119}$/u;

export interface MigrationTtlIndexInput {
  readonly collectionName: string;
  readonly indexName: string;
  readonly field: string;
  readonly expireAfterSeconds: number;
}

export interface MigrationUniqueIndexInput {
  readonly collectionName: string;
  readonly indexName: string;
  readonly field: string;
}

export interface MigrationDropIndexInput {
  readonly collectionName: string;
  readonly indexName: string;
  readonly field: string;
}

export interface MigrationAdministrativeDatabase {
  reconcileTtlIndex(input: MigrationTtlIndexInput): Promise<void>;
  reconcileUniqueIndex(input: MigrationUniqueIndexInput): Promise<void>;
  dropIndexIfMatches(input: MigrationDropIndexInput): Promise<void>;
}

function requireInput(input: MigrationTtlIndexInput): MigrationTtlIndexInput {
  const collectionName = requireMigrationCollectionName(input?.collectionName);
  if (
    typeof input.indexName !== "string" ||
    !INDEX_NAME_PATTERN.test(input.indexName) ||
    typeof input.field !== "string" ||
    !FIELD_NAME_PATTERN.test(input.field) ||
    !Number.isSafeInteger(input.expireAfterSeconds) ||
    input.expireAfterSeconds < 0
  ) {
    throw new MigrationUsageError("Migration TTL index input is invalid.");
  }
  return Object.freeze({ ...input, collectionName });
}

function requireNamedFieldInput<T extends MigrationUniqueIndexInput>(
  input: T,
): T & { readonly collectionName: string } {
  const collectionName = requireMigrationCollectionName(input?.collectionName);
  if (
    typeof input.indexName !== "string" ||
    !INDEX_NAME_PATTERN.test(input.indexName) ||
    typeof input.field !== "string" ||
    !FIELD_NAME_PATTERN.test(input.field)
  ) {
    throw new MigrationUsageError("Migration index input is invalid.");
  }
  return Object.freeze({ ...input, collectionName });
}

function isAscendingSingleFieldKey(
  value: unknown,
  field: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 && entries[0]?.[0] === field && entries[0]?.[1] === 1;
}

function isNamespaceNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown; readonly codeName?: unknown };
  return candidate.code === 26 || candidate.codeName === "NamespaceNotFound";
}

/**
 * A deliberately narrow non-transactional DDL port for versioned migrations.
 * MongoDB index metadata cannot be changed as part of the migration ledger
 * transaction, so callers must be idempotent and the normal migration verify
 * handler remains authoritative before the ledger can be marked applied.
 */
export function createMigrationAdministrativeDatabase(
  connection: Connection,
): MigrationAdministrativeDatabase {
  const database = connection.db;
  if (!database) {
    throw new MigrationUsageError(
      "Migration administrative database is unavailable.",
    );
  }

  return Object.freeze({
    async reconcileTtlIndex(rawInput: MigrationTtlIndexInput): Promise<void> {
      const input = requireInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        // createIndex creates the collection as well, which keeps a fresh
        // installation on the same versioned path as an existing database.
        indexes = [];
      }
      const named = indexes.find((index) => index.name === input.indexName);
      if (named && !isAscendingSingleFieldKey(named.key, input.field)) {
        throw new MigrationUsageError(
          "Migration TTL index name is already used by another key.",
        );
      }

      const existing =
        named ??
        indexes.find((index) => isAscendingSingleFieldKey(index.key, input.field));
      if (!existing) {
        await collection.createIndex(
          { [input.field]: 1 },
          {
            name: input.indexName,
            expireAfterSeconds: input.expireAfterSeconds,
          },
        );
        return;
      }

      if (existing.expireAfterSeconds === input.expireAfterSeconds) return;
      if (typeof existing.name !== "string" || !INDEX_NAME_PATTERN.test(existing.name)) {
        throw new MigrationUsageError("Existing migration TTL index is invalid.");
      }
      await database.command({
        collMod: input.collectionName,
        index: {
          name: existing.name,
          expireAfterSeconds: input.expireAfterSeconds,
        },
      });
    },

    async reconcileUniqueIndex(
      rawInput: MigrationUniqueIndexInput,
    ): Promise<void> {
      const input = requireNamedFieldInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        indexes = [];
      }
      const named = indexes.find((index) => index.name === input.indexName);
      if (named && !isAscendingSingleFieldKey(named.key, input.field)) {
        throw new MigrationUsageError(
          "Migration unique index name is already used by another key.",
        );
      }
      const existing =
        named ??
        indexes.find((index) => isAscendingSingleFieldKey(index.key, input.field));
      if (!existing) {
        await collection.createIndex(
          { [input.field]: 1 },
          { name: input.indexName, unique: true },
        );
        return;
      }
      if (existing.unique !== true) {
        throw new MigrationUsageError(
          "Existing migration index is not unique.",
        );
      }
    },

    async dropIndexIfMatches(rawInput: MigrationDropIndexInput): Promise<void> {
      const input = requireNamedFieldInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (isNamespaceNotFound(error)) return;
        throw error;
      }
      const named = indexes.find((index) => index.name === input.indexName);
      if (!named) return;
      if (!isAscendingSingleFieldKey(named.key, input.field)) {
        throw new MigrationUsageError(
          "Migration index name is already used by another key.",
        );
      }
      await collection.dropIndex(input.indexName);
    },
  });
}
