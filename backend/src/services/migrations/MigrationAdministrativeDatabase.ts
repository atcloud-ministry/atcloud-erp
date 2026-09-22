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

export interface MigrationCompoundUniqueIndexInput {
  readonly collectionName: string;
  readonly indexName: string;
  /** Ordered ascending fields. MongoDB compound-index order is significant. */
  readonly fields: readonly string[];
  /** Optional narrowly-scoped partial filter: { field: { $type: "string" } }. */
  readonly partialStringField?: string;
}

export interface MigrationCompoundIndexInput {
  readonly collectionName: string;
  readonly indexName: string;
  /** Ordered ascending fields. MongoDB compound-index order is significant. */
  readonly fields: readonly string[];
}

export interface MigrationPartialUniqueIndexInput {
  readonly collectionName: string;
  readonly indexName: string;
  readonly field: string;
  readonly partialField: string;
  readonly partialValues: readonly string[];
}

export interface MigrationAdministrativeDatabase {
  reconcileTtlIndex(input: MigrationTtlIndexInput): Promise<void>;
  reconcileExactTtlIndex(input: MigrationTtlIndexInput): Promise<void>;
  dropExactTtlIndexIfMatches(input: MigrationTtlIndexInput): Promise<void>;
  reconcileUniqueIndex(input: MigrationUniqueIndexInput): Promise<void>;
  dropIndexIfMatches(input: MigrationDropIndexInput): Promise<void>;
  reconcileCompoundUniqueIndex(
    input: MigrationCompoundUniqueIndexInput,
  ): Promise<void>;
  dropCompoundUniqueIndexIfMatches(
    input: MigrationCompoundUniqueIndexInput,
  ): Promise<void>;
  reconcileCompoundIndex(input: MigrationCompoundIndexInput): Promise<void>;
  dropCompoundIndexIfMatches(input: MigrationCompoundIndexInput): Promise<void>;
  reconcilePartialUniqueIndex(
    input: MigrationPartialUniqueIndexInput,
  ): Promise<void>;
  dropPartialUniqueIndexIfMatches(
    input: MigrationPartialUniqueIndexInput,
  ): Promise<void>;
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

function requireCompoundUniqueIndexInput(
  input: MigrationCompoundUniqueIndexInput,
): MigrationCompoundUniqueIndexInput {
  let collectionName: string;
  try {
    collectionName = requireMigrationCollectionName(input?.collectionName);
  } catch {
    throw new MigrationUsageError(
      "Migration compound unique index input is invalid.",
    );
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.indexName !== "string" ||
    !INDEX_NAME_PATTERN.test(input.indexName) ||
    !Array.isArray(input.fields) ||
    input.fields.length < 2 ||
    input.fields.length > 8 ||
    input.fields.some(
      (field) => typeof field !== "string" || !FIELD_NAME_PATTERN.test(field),
    ) ||
    new Set(input.fields).size !== input.fields.length ||
    (input.partialStringField !== undefined &&
      (typeof input.partialStringField !== "string" ||
        !FIELD_NAME_PATTERN.test(input.partialStringField) ||
        !input.fields.includes(input.partialStringField)))
  ) {
    throw new MigrationUsageError(
      "Migration compound unique index input is invalid.",
    );
  }
  return Object.freeze({
    collectionName,
    indexName: input.indexName,
    fields: Object.freeze([...input.fields]),
    ...(input.partialStringField
      ? { partialStringField: input.partialStringField }
      : {}),
  });
}

function requireCompoundIndexInput(
  input: MigrationCompoundIndexInput,
): MigrationCompoundIndexInput {
  let collectionName: string;
  try {
    collectionName = requireMigrationCollectionName(input?.collectionName);
  } catch {
    throw new MigrationUsageError(
      "Migration compound index input is invalid.",
    );
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.indexName !== "string" ||
    !INDEX_NAME_PATTERN.test(input.indexName) ||
    !Array.isArray(input.fields) ||
    input.fields.length < 2 ||
    input.fields.length > 8 ||
    input.fields.some(
      (field) => typeof field !== "string" || !FIELD_NAME_PATTERN.test(field),
    ) ||
    new Set(input.fields).size !== input.fields.length
  ) {
    throw new MigrationUsageError(
      "Migration compound index input is invalid.",
    );
  }
  return Object.freeze({
    collectionName,
    indexName: input.indexName,
    fields: Object.freeze([...input.fields]),
  });
}

function requirePartialUniqueIndexInput(
  input: MigrationPartialUniqueIndexInput,
): MigrationPartialUniqueIndexInput {
  let collectionName: string;
  try {
    collectionName = requireMigrationCollectionName(input?.collectionName);
  } catch {
    throw new MigrationUsageError(
      "Migration partial unique index input is invalid.",
    );
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.indexName !== "string" ||
    !INDEX_NAME_PATTERN.test(input.indexName) ||
    typeof input.field !== "string" ||
    !FIELD_NAME_PATTERN.test(input.field) ||
    typeof input.partialField !== "string" ||
    !FIELD_NAME_PATTERN.test(input.partialField) ||
    !Array.isArray(input.partialValues) ||
    input.partialValues.length < 1 ||
    input.partialValues.length > 16 ||
    input.partialValues.some(
      (value) =>
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 80 ||
        !/^[a-z][a-z0-9_]*$/u.test(value),
    ) ||
    new Set(input.partialValues).size !== input.partialValues.length
  ) {
    throw new MigrationUsageError(
      "Migration partial unique index input is invalid.",
    );
  }
  return Object.freeze({
    collectionName,
    indexName: input.indexName,
    field: input.field,
    partialField: input.partialField,
    partialValues: Object.freeze([...input.partialValues]),
  });
}

function isAscendingSingleFieldKey(
  value: unknown,
  field: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 && entries[0]?.[0] === field && entries[0]?.[1] === 1;
}

function hasPlainIndexOptions(index: IndexDescriptionInfo): boolean {
  return (
    index.unique !== true &&
    index.sparse !== true &&
    index.collation === undefined &&
    index.hidden !== true &&
    index.partialFilterExpression === undefined
  );
}

function isAscendingCompoundKey(
  value: unknown,
  fields: readonly string[],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length === fields.length &&
    entries.every(
      ([field, direction], index) =>
        field === fields[index] && direction === 1,
    )
  );
}

function hasExactPartialStringFilter(
  value: unknown,
  field: string | undefined,
): boolean {
  if (field === undefined) return value === undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== field) return false;
  const condition = entries[0]?.[1];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  const conditionEntries = Object.entries(condition as Record<string, unknown>);
  return (
    conditionEntries.length === 1 &&
    conditionEntries[0]?.[0] === "$type" &&
    conditionEntries[0]?.[1] === "string"
  );
}

function isExactCompoundUniqueIndex(
  index: IndexDescriptionInfo,
  input: MigrationCompoundUniqueIndexInput,
): boolean {
  return (
    isAscendingCompoundKey(index.key, input.fields) &&
    index.unique === true &&
    index.sparse !== true &&
    index.expireAfterSeconds === undefined &&
    index.collation === undefined &&
    index.hidden !== true &&
    hasExactPartialStringFilter(
      index.partialFilterExpression,
      input.partialStringField,
    )
  );
}

function isExactCompoundIndex(
  index: IndexDescriptionInfo,
  input: MigrationCompoundIndexInput,
): boolean {
  return (
    isAscendingCompoundKey(index.key, input.fields) &&
    index.unique !== true &&
    index.sparse !== true &&
    index.expireAfterSeconds === undefined &&
    index.collation === undefined &&
    index.hidden !== true &&
    index.partialFilterExpression === undefined
  );
}

function isExactPartialUniqueIndex(
  index: IndexDescriptionInfo,
  input: MigrationPartialUniqueIndexInput,
): boolean {
  if (
    !isAscendingSingleFieldKey(index.key, input.field) ||
    index.unique !== true ||
    index.sparse === true ||
    index.expireAfterSeconds !== undefined ||
    index.collation !== undefined ||
    index.hidden === true
  ) {
    return false;
  }
  const partial = index.partialFilterExpression;
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    return false;
  }
  const entries = Object.entries(partial as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== input.partialField) {
    return false;
  }
  const condition = entries[0]?.[1];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return false;
  }
  const conditions = Object.entries(condition as Record<string, unknown>);
  return (
    conditions.length === 1 &&
    conditions[0]?.[0] === "$in" &&
    Array.isArray(conditions[0]?.[1]) &&
    conditions[0][1].length === input.partialValues.length &&
    conditions[0][1].every(
      (value, index_) => value === input.partialValues[index_],
    )
  );
}

function buildAscendingKey(fields: readonly string[]): Record<string, 1> {
  const key: Record<string, 1> = {};
  for (const field of fields) key[field] = 1;
  return key;
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

    async reconcileExactTtlIndex(
      rawInput: MigrationTtlIndexInput,
    ): Promise<void> {
      const input = requireInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        indexes = [];
      }
      const named = indexes.find((index) => index.name === input.indexName);
      if (
        named &&
        (!isAscendingSingleFieldKey(named.key, input.field) ||
          !hasPlainIndexOptions(named))
      ) {
        throw new MigrationUsageError(
          "Migration exact TTL index name is already used by another definition.",
        );
      }
      if (
        indexes.some(
          (index) =>
            index.name !== input.indexName &&
            isAscendingSingleFieldKey(index.key, input.field),
        )
      ) {
        throw new MigrationUsageError(
          "Migration exact TTL index key already exists under another definition.",
        );
      }
      if (!named) {
        await collection.createIndex(
          { [input.field]: 1 },
          {
            name: input.indexName,
            expireAfterSeconds: input.expireAfterSeconds,
          },
        );
        return;
      }
      if (named.expireAfterSeconds === input.expireAfterSeconds) return;
      await database.command({
        collMod: input.collectionName,
        index: {
          name: input.indexName,
          expireAfterSeconds: input.expireAfterSeconds,
        },
      });
    },

    async dropExactTtlIndexIfMatches(
      rawInput: MigrationTtlIndexInput,
    ): Promise<void> {
      const input = requireInput(rawInput);
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
      if (
        !isAscendingSingleFieldKey(named.key, input.field) ||
        !hasPlainIndexOptions(named) ||
        named.expireAfterSeconds !== input.expireAfterSeconds
      ) {
        throw new MigrationUsageError(
          "Migration exact TTL index name is already used by another definition.",
        );
      }
      await collection.dropIndex(input.indexName);
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

    async reconcileCompoundUniqueIndex(
      rawInput: MigrationCompoundUniqueIndexInput,
    ): Promise<void> {
      const input = requireCompoundUniqueIndexInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        indexes = [];
      }

      const named = indexes.find((index) => index.name === input.indexName);
      const competingKey = indexes.find(
        (index) =>
          index.name !== input.indexName &&
          isAscendingCompoundKey(index.key, input.fields),
      );
      if (competingKey) {
        throw new MigrationUsageError(
          "Migration compound unique index key already exists under another definition.",
        );
      }
      if (named) {
        if (!isExactCompoundUniqueIndex(named, input)) {
          throw new MigrationUsageError(
            "Migration compound unique index name is already used by another definition.",
          );
        }
        return;
      }

      await collection.createIndex(buildAscendingKey(input.fields), {
        name: input.indexName,
        unique: true,
        ...(input.partialStringField
          ? {
              partialFilterExpression: {
                [input.partialStringField]: { $type: "string" },
              },
            }
          : {}),
      });
    },

    async dropCompoundUniqueIndexIfMatches(
      rawInput: MigrationCompoundUniqueIndexInput,
    ): Promise<void> {
      const input = requireCompoundUniqueIndexInput(rawInput);
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
      if (!isExactCompoundUniqueIndex(named, input)) {
        throw new MigrationUsageError(
          "Migration compound unique index name is already used by another definition.",
        );
      }
      await collection.dropIndex(input.indexName);
    },

    async reconcileCompoundIndex(
      rawInput: MigrationCompoundIndexInput,
    ): Promise<void> {
      const input = requireCompoundIndexInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        indexes = [];
      }

      const named = indexes.find((index) => index.name === input.indexName);
      const competingKey = indexes.find(
        (index) =>
          index.name !== input.indexName &&
          isAscendingCompoundKey(index.key, input.fields),
      );
      if (competingKey) {
        throw new MigrationUsageError(
          "Migration compound index key already exists under another definition.",
        );
      }
      if (named) {
        if (!isExactCompoundIndex(named, input)) {
          throw new MigrationUsageError(
            "Migration compound index name is already used by another definition.",
          );
        }
        return;
      }

      await collection.createIndex(buildAscendingKey(input.fields), {
        name: input.indexName,
      });
    },

    async dropCompoundIndexIfMatches(
      rawInput: MigrationCompoundIndexInput,
    ): Promise<void> {
      const input = requireCompoundIndexInput(rawInput);
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
      if (!isExactCompoundIndex(named, input)) {
        throw new MigrationUsageError(
          "Migration compound index name is already used by another definition.",
        );
      }
      await collection.dropIndex(input.indexName);
    },

    async reconcilePartialUniqueIndex(
      rawInput: MigrationPartialUniqueIndexInput,
    ): Promise<void> {
      const input = requirePartialUniqueIndexInput(rawInput);
      const collection = database.collection(input.collectionName);
      let indexes: IndexDescriptionInfo[];
      try {
        indexes = await collection.listIndexes().toArray();
      } catch (error) {
        if (!isNamespaceNotFound(error)) throw error;
        indexes = [];
      }

      const named = indexes.find((index) => index.name === input.indexName);
      const competingKey = indexes.find(
        (index) =>
          index.name !== input.indexName &&
          isAscendingSingleFieldKey(index.key, input.field),
      );
      if (competingKey) {
        throw new MigrationUsageError(
          "Migration partial unique index key already exists under another definition.",
        );
      }
      if (named) {
        if (!isExactPartialUniqueIndex(named, input)) {
          throw new MigrationUsageError(
            "Migration partial unique index name is already used by another definition.",
          );
        }
        return;
      }

      await collection.createIndex(
        { [input.field]: 1 },
        {
          name: input.indexName,
          unique: true,
          partialFilterExpression: {
            [input.partialField]: { $in: [...input.partialValues] },
          },
        },
      );
    },

    async dropPartialUniqueIndexIfMatches(
      rawInput: MigrationPartialUniqueIndexInput,
    ): Promise<void> {
      const input = requirePartialUniqueIndexInput(rawInput);
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
      if (!isExactPartialUniqueIndex(named, input)) {
        throw new MigrationUsageError(
          "Migration partial unique index name is already used by another definition.",
        );
      }
      await collection.dropIndex(input.indexName);
    },
  });
}
