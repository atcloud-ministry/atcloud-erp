import type { ClientSession, Connection } from "mongoose";
import type {
  AggregationCursor,
  Collection,
  Document,
  FindCursor,
  ListIndexesCursor,
  WithId,
} from "mongodb";
import { MigrationUsageError } from "./MigrationErrors";
import {
  cloneMigrationAggregateReadOptions,
  cloneMigrationCountDocumentsOptions,
  cloneMigrationListIndexesOptions,
  cloneMigrationReadOnlyPipeline,
  createMigrationSafeAggregationCursor,
  createMigrationSafeFindCursor,
  createMigrationSafeIndexCursor,
  requireMigrationCollectionName,
  type MigrationReadCollection,
} from "./MigrationReadDatabase";

type CollectionMethod = (...args: never[]) => unknown;

export interface MigrationTransactionCollection<
  TSchema extends Document = Document,
> extends MigrationReadCollection<TSchema> {
  readonly insertOne: Collection<TSchema>["insertOne"];
  readonly insertMany: Collection<TSchema>["insertMany"];
  readonly updateOne: Collection<TSchema>["updateOne"];
  readonly updateMany: Collection<TSchema>["updateMany"];
  readonly replaceOne: Collection<TSchema>["replaceOne"];
  readonly deleteOne: Collection<TSchema>["deleteOne"];
  readonly deleteMany: Collection<TSchema>["deleteMany"];
  readonly findOneAndUpdate: Collection<TSchema>["findOneAndUpdate"];
  readonly findOneAndReplace: Collection<TSchema>["findOneAndReplace"];
  readonly findOneAndDelete: Collection<TSchema>["findOneAndDelete"];
  readonly bulkWrite: Collection<TSchema>["bulkWrite"];
}

export interface MigrationTransactionDatabase {
  readonly collection: <TSchema extends Document = Document>(
    name: string,
  ) => MigrationTransactionCollection<TSchema>;
}

export interface MigrationTransactionReadDatabase {
  readonly collection: <TSchema extends Document = Document>(
    name: string,
  ) => MigrationReadCollection<TSchema>;
}

function frameworkSessionOptions(
  options: unknown,
  session: ClientSession,
): Readonly<Record<string, unknown>> & { readonly session: ClientSession } {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new MigrationUsageError(
      "Migration database operation options are invalid.",
    );
  }

  try {
    return { ...(options ?? {}), session };
  } catch {
    throw new MigrationUsageError(
      "Migration database operation options are invalid.",
    );
  }
}

function bindWithFrameworkSession<TMethod extends CollectionMethod>(
  method: TMethod,
  receiver: object,
  session: ClientSession,
  optionsIndex: number,
  defaults: Readonly<Record<number, unknown>> = {},
  prepare?: (args: unknown[]) => void,
): TMethod {
  return ((...providedArgs: unknown[]) => {
    const args = providedArgs.slice(0, optionsIndex + 1);
    while (args.length < optionsIndex) {
      args.push(defaults[args.length]);
    }
    prepare?.(args);
    args[optionsIndex] = frameworkSessionOptions(
      args[optionsIndex],
      session,
    );
    return Reflect.apply(method, receiver, args);
  }) as unknown as TMethod;
}

function createSessionBoundReadMethods<TSchema extends Document>(
  collection: Collection<TSchema>,
  session: ClientSession,
): MigrationReadCollection<TSchema> {
  const nativeFind = bindWithFrameworkSession(
    collection.find,
    collection,
    session,
    1,
    { 0: {} },
  );
  const find = ((...args: unknown[]) =>
    createMigrationSafeFindCursor(
      Reflect.apply(nativeFind, undefined, args) as FindCursor<
        WithId<TSchema>
      >,
    )) as MigrationReadCollection<TSchema>["find"];
  const listIndexes = ((...args: unknown[]) => {
    if (args.length > 1) {
      throw new MigrationUsageError(
        "Migration listIndexes options are invalid.",
      );
    }
    const options = cloneMigrationListIndexesOptions(args[0]);
    const cursor = Reflect.apply(
      collection.listIndexes,
      collection,
      options === undefined ? [] : [options],
    ) as ListIndexesCursor;
    return createMigrationSafeIndexCursor(cursor);
  }) as MigrationReadCollection<TSchema>["listIndexes"];
  const nativeAggregate = bindWithFrameworkSession(
    collection.aggregate,
    collection,
    session,
    1,
    { 0: [] },
    (args) => {
      args[0] = cloneMigrationReadOnlyPipeline(args[0]) ?? [];
      args[1] = cloneMigrationAggregateReadOptions(args[1]);
    },
  );
  const aggregate = ((...args: unknown[]) =>
    createMigrationSafeAggregationCursor(
      Reflect.apply(
        nativeAggregate,
        undefined,
        args,
      ) as AggregationCursor<Document>,
    )) as MigrationReadCollection<TSchema>["aggregate"];

  return {
    find,
    findOne: bindWithFrameworkSession(
      collection.findOne,
      collection,
      session,
      1,
      { 0: {} },
    ),
    countDocuments: bindWithFrameworkSession(
      collection.countDocuments,
      collection,
      session,
      1,
      { 0: {} },
      (args) => {
        args[1] = cloneMigrationCountDocumentsOptions(args[1]);
      },
    ),
    estimatedDocumentCount: bindWithFrameworkSession(
      collection.estimatedDocumentCount,
      collection,
      session,
      0,
    ),
    distinct: bindWithFrameworkSession(
      collection.distinct,
      collection,
      session,
      2,
      { 1: {} },
    ),
    listIndexes,
    aggregate,
  };
}

function requireDatabase(connection: Connection) {
  const database = connection.db;
  if (!database) {
    throw new MigrationUsageError(
      "Migration transaction database is unavailable.",
    );
  }
  return database;
}

export function createMigrationTransactionReadDatabase(
  connection: Connection,
  session: ClientSession,
): MigrationTransactionReadDatabase {
  const database = requireDatabase(connection);

  return Object.freeze({
    collection<TSchema extends Document = Document>(
      name: string,
    ): MigrationReadCollection<TSchema> {
      const collectionName = requireMigrationCollectionName(name);
      const collection = database.collection<TSchema>(collectionName);
      return Object.freeze(createSessionBoundReadMethods(collection, session));
    },
  });
}

export function createMigrationTransactionDatabase(
  connection: Connection,
  session: ClientSession,
): MigrationTransactionDatabase {
  const database = requireDatabase(connection);

  return Object.freeze({
    collection<TSchema extends Document = Document>(
      name: string,
    ): MigrationTransactionCollection<TSchema> {
      const collectionName = requireMigrationCollectionName(name);
      const collection = database.collection<TSchema>(collectionName);
      const readMethods = createSessionBoundReadMethods(collection, session);

      return Object.freeze({
        ...readMethods,
        insertOne: bindWithFrameworkSession(
          collection.insertOne,
          collection,
          session,
          1,
        ),
        insertMany: bindWithFrameworkSession(
          collection.insertMany,
          collection,
          session,
          1,
        ),
        updateOne: bindWithFrameworkSession(
          collection.updateOne,
          collection,
          session,
          2,
        ),
        updateMany: bindWithFrameworkSession(
          collection.updateMany,
          collection,
          session,
          2,
        ),
        replaceOne: bindWithFrameworkSession(
          collection.replaceOne,
          collection,
          session,
          2,
        ),
        deleteOne: bindWithFrameworkSession(
          collection.deleteOne,
          collection,
          session,
          1,
        ),
        deleteMany: bindWithFrameworkSession(
          collection.deleteMany,
          collection,
          session,
          1,
          { 0: {} },
        ),
        findOneAndUpdate: bindWithFrameworkSession(
          collection.findOneAndUpdate,
          collection,
          session,
          2,
        ),
        findOneAndReplace: bindWithFrameworkSession(
          collection.findOneAndReplace,
          collection,
          session,
          2,
        ),
        findOneAndDelete: bindWithFrameworkSession(
          collection.findOneAndDelete,
          collection,
          session,
          1,
        ),
        bulkWrite: bindWithFrameworkSession(
          collection.bulkWrite,
          collection,
          session,
          1,
        ),
      });
    },
  });
}
