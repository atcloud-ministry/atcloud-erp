import type { ClientSession, Connection } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { MigrationUsageError } from "../../../../src/services/migrations/MigrationErrors";
import {
  createMigrationTransactionDatabase,
  createMigrationTransactionReadDatabase,
} from "../../../../src/services/migrations/MigrationTransactionDatabase";

const READ_METHODS = [
  "aggregate",
  "countDocuments",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findOne",
  "listIndexes",
] as const;

const WRITE_METHODS = [
  "bulkWrite",
  "deleteMany",
  "deleteOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "insertMany",
  "insertOne",
  "replaceOne",
  "updateMany",
  "updateOne",
] as const;

function createCursorDouble<T>(documents: readonly T[] = []) {
  const cursor = {
    cursorClient: { db: vi.fn(), write: vi.fn() },
    cursorSession: { startTransaction: vi.fn() },
    client: { db: vi.fn() },
    namespace: "private.users",
    raw: { collection: "users" },
    stream: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    skip: vi.fn(),
    project: vi.fn(),
    match: vi.fn(),
    map: vi.fn(),
    toArray: vi.fn(async () => [...documents]),
    next: vi.fn(async () => documents[0] ?? null),
    tryNext: vi.fn(async () => documents[0] ?? null),
    hasNext: vi.fn(async () => documents.length > 0),
    forEach: vi.fn(async (iterator: (document: T) => boolean | void) => {
      for (const document of documents) {
        if (iterator(document) === false) break;
      }
    }),
    close: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: vi.fn(),
  };
  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  cursor.skip.mockReturnValue(cursor);
  cursor.project.mockReturnValue(cursor);
  cursor.match.mockReturnValue(cursor);
  cursor.map.mockReturnValue(cursor);
  return cursor;
}

function createHarness() {
  const cursors = {
    aggregate: createCursorDouble([{ role: "mentor" }]),
    find: createCursorDouble([{ _id: "user-1", role: "mentor" }]),
    indexes: createCursorDouble([{ name: "_id_" }]),
  };
  const raw = {
    aggregate: vi.fn(() => cursors.aggregate),
    countDocuments: vi.fn(),
    distinct: vi.fn(),
    estimatedDocumentCount: vi.fn(),
    find: vi.fn(() => cursors.find),
    findOne: vi.fn(),
    listIndexes: vi.fn(() => cursors.indexes),
    insertOne: vi.fn(),
    insertMany: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
    replaceOne: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndReplace: vi.fn(),
    findOneAndDelete: vi.fn(),
    bulkWrite: vi.fn(),
    command: vi.fn(),
    createIndex: vi.fn(),
    drop: vi.fn(),
  };
  const rawCollection = vi.fn(() => raw);
  const connection = {
    db: { collection: rawCollection },
    client: { privateUri: "mongodb://private-user:private-password@cluster" },
  } as unknown as Connection;
  const frameworkSession = {
    id: { id: "framework-session" },
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    abortTransaction: vi.fn(),
    endSession: vi.fn(),
  } as unknown as ClientSession;
  const callerSession = {
    id: { id: "caller-session-must-not-be-used" },
  } as unknown as ClientSession;

  return {
    callerSession,
    connection,
    cursors,
    frameworkSession,
    raw,
    rawCollection,
  };
}

function expectFrameworkSession(
  method: ReturnType<typeof vi.fn>,
  optionIndex: number,
  frameworkSession: ClientSession,
): void {
  expect(method).toHaveBeenCalledOnce();
  expect(method.mock.calls[0][optionIndex]).toMatchObject({
    session: frameworkSession,
    comment: "caller-option",
  });
}

describe("MigrationTransactionDatabase", () => {
  it("exposes frozen allowlisted surfaces without raw database or session handles", () => {
    const { connection, frameworkSession } = createHarness();
    const batchDatabase = createMigrationTransactionDatabase(
      connection,
      frameworkSession,
    );
    const verifyDatabase = createMigrationTransactionReadDatabase(
      connection,
      frameworkSession,
    );
    const batchCollection = batchDatabase.collection("users");
    const verifyCollection = verifyDatabase.collection("users");

    expect(Object.keys(batchDatabase)).toEqual(["collection"]);
    expect(Object.keys(verifyDatabase)).toEqual(["collection"]);
    expect(Object.keys(batchCollection).sort()).toEqual(
      [...READ_METHODS, ...WRITE_METHODS].sort(),
    );
    expect(Object.keys(verifyCollection).sort()).toEqual([...READ_METHODS]);
    expect(Object.isFrozen(batchDatabase)).toBe(true);
    expect(Object.isFrozen(verifyDatabase)).toBe(true);
    expect(Object.isFrozen(batchCollection)).toBe(true);
    expect(Object.isFrozen(verifyCollection)).toBe(true);

    for (const hiddenName of [
      "connection",
      "db",
      "client",
      "rawCollection",
      "session",
      "startSession",
      "startTransaction",
      "commitTransaction",
      "abortTransaction",
      "endSession",
      "command",
      "createIndex",
      "dropIndex",
      "drop",
      "rename",
    ]) {
      expect(batchDatabase).not.toHaveProperty(hiddenName);
      expect(verifyDatabase).not.toHaveProperty(hiddenName);
      expect(batchCollection).not.toHaveProperty(hiddenName);
      expect(verifyCollection).not.toHaveProperty(hiddenName);
    }
  });

  it("binds every batch data operation to the framework session while index metadata stays unbound", () => {
    const {
      callerSession,
      connection,
      frameworkSession,
      raw,
      rawCollection,
    } = createHarness();
    const collection = createMigrationTransactionDatabase(
      connection,
      frameworkSession,
    ).collection("users");
    const callerOptions = Object.freeze({
      comment: "caller-option",
      session: callerSession,
    });

    collection.find({ active: true }, callerOptions);
    void collection.findOne({ active: true }, callerOptions);
    void collection.countDocuments(
      { active: true },
      { comment: "caller-option" },
    );
    void collection.estimatedDocumentCount(callerOptions);
    void collection.distinct("role", { active: true }, callerOptions);
    collection.listIndexes({ comment: "caller-option" });
    collection.aggregate(
      [{ $match: { active: true } }],
      { comment: "caller-option" },
    );
    void collection.insertOne({ username: "amy" }, callerOptions);
    void collection.insertMany([{ username: "amy" }], callerOptions);
    void collection.updateOne(
      { username: "amy" },
      { $set: { active: true } },
      callerOptions,
    );
    void collection.updateMany(
      { active: false },
      { $set: { active: true } },
      callerOptions,
    );
    void collection.replaceOne(
      { username: "amy" },
      { username: "amy", active: true },
      callerOptions,
    );
    void collection.deleteOne({ username: "amy" }, callerOptions);
    void collection.deleteMany({ active: false }, callerOptions);
    void collection.findOneAndUpdate(
      { username: "amy" },
      { $set: { active: true } },
      callerOptions,
    );
    void collection.findOneAndReplace(
      { username: "amy" },
      { username: "amy", active: true },
      callerOptions,
    );
    void collection.findOneAndDelete({ username: "amy" }, callerOptions);
    void collection.bulkWrite(
      [
        {
          updateOne: {
            filter: { username: "amy" },
            update: { $set: { active: true } },
          },
        },
      ],
      callerOptions,
    );

    expect(rawCollection).toHaveBeenCalledWith("users");
    expectFrameworkSession(raw.find, 1, frameworkSession);
    expectFrameworkSession(raw.findOne, 1, frameworkSession);
    expectFrameworkSession(raw.countDocuments, 1, frameworkSession);
    expectFrameworkSession(raw.estimatedDocumentCount, 0, frameworkSession);
    expectFrameworkSession(raw.distinct, 2, frameworkSession);
    expect(raw.listIndexes).toHaveBeenCalledOnce();
    expect(raw.listIndexes).toHaveBeenCalledWith({
      comment: "caller-option",
    });
    expect(raw.listIndexes.mock.calls[0]?.[0]).not.toHaveProperty("session");
    expectFrameworkSession(raw.aggregate, 1, frameworkSession);
    expectFrameworkSession(raw.insertOne, 1, frameworkSession);
    expectFrameworkSession(raw.insertMany, 1, frameworkSession);
    expectFrameworkSession(raw.updateOne, 2, frameworkSession);
    expectFrameworkSession(raw.updateMany, 2, frameworkSession);
    expectFrameworkSession(raw.replaceOne, 2, frameworkSession);
    expectFrameworkSession(raw.deleteOne, 1, frameworkSession);
    expectFrameworkSession(raw.deleteMany, 1, frameworkSession);
    expectFrameworkSession(raw.findOneAndUpdate, 2, frameworkSession);
    expectFrameworkSession(raw.findOneAndReplace, 2, frameworkSession);
    expectFrameworkSession(raw.findOneAndDelete, 1, frameworkSession);
    expectFrameworkSession(raw.bulkWrite, 1, frameworkSession);
    expect(callerOptions.session).toBe(callerSession);
  });

  it("binds verify data reads while keeping wrapped index metadata reads unbound", () => {
    const {
      callerSession,
      connection,
      cursors,
      frameworkSession,
      raw,
    } = createHarness();
    const collection = createMigrationTransactionReadDatabase(
      connection,
      frameworkSession,
    ).collection("users");
    const options = { comment: "caller-option", session: callerSession };

    const findCursor = collection.find({}, options);
    const indexCursor = collection.listIndexes({ comment: "caller-option" });
    const aggregateCursor = collection.aggregate([], {
      comment: "caller-option",
    });

    expect(findCursor).not.toBe(cursors.find);
    expect(indexCursor).not.toBe(cursors.indexes);
    expect(aggregateCursor).not.toBe(cursors.aggregate);
    expect(Object.isFrozen(findCursor)).toBe(true);
    expect(Object.isFrozen(indexCursor)).toBe(true);
    expect(Object.isFrozen(aggregateCursor)).toBe(true);

    for (const cursor of [findCursor, indexCursor, aggregateCursor]) {
      for (const hiddenName of [
        "cursorClient",
        "client",
        "cursorSession",
        "session",
        "raw",
        "namespace",
        "stream",
        "map",
      ]) {
        expect(cursor).not.toHaveProperty(hiddenName);
      }
      expect(Symbol.asyncIterator in cursor).toBe(false);
    }

    expectFrameworkSession(raw.find, 1, frameworkSession);
    expect(raw.listIndexes).toHaveBeenCalledWith({
      comment: "caller-option",
    });
    expect(raw.listIndexes.mock.calls[0]?.[0]).not.toHaveProperty("session");
    expectFrameworkSession(raw.aggregate, 1, frameworkSession);
  });

  it("rejects caller sessions from unbound index reads in batch and verify wrappers", () => {
    for (const mode of ["batch", "verify"] as const) {
      const {
        callerSession,
        connection,
        cursors,
        frameworkSession,
        raw,
      } = createHarness();
      const collection =
        mode === "batch"
          ? createMigrationTransactionDatabase(
              connection,
              frameworkSession,
            ).collection("users")
          : createMigrationTransactionReadDatabase(
              connection,
              frameworkSession,
            ).collection("users");
      const callerOptions = Object.freeze({
        batchSize: 5,
        comment: "index-metadata",
        session: callerSession,
      });

      expect(() => collection.listIndexes(callerOptions)).toThrowError(
        MigrationUsageError,
      );
      expect(raw.listIndexes).not.toHaveBeenCalled();

      const indexCursor = collection.listIndexes({
        batchSize: 5,
        comment: "index-metadata",
      });
      expect(indexCursor).not.toBe(cursors.indexes);
      expect(Object.isFrozen(indexCursor)).toBe(true);
      expect(raw.listIndexes).toHaveBeenCalledWith({
        batchSize: 5,
        comment: "index-metadata",
      });
      expect(raw.listIndexes.mock.calls[0]?.[0]).not.toHaveProperty(
        "session",
      );
      expect(callerOptions.session).toBe(callerSession);
    }
  });

  it("keeps every cursor chain on the same safe wrapper", async () => {
    const { connection, cursors, frameworkSession } = createHarness();
    const collection = createMigrationTransactionDatabase(
      connection,
      frameworkSession,
    ).collection("users");
    const findCursor = collection.find({});
    const aggregateCursor = collection.aggregate([]);

    expect(findCursor.sort({ _id: 1 })).toBe(findCursor);
    expect(findCursor.limit(5)).toBe(findCursor);
    expect(findCursor.skip(1)).toBe(findCursor);
    expect(findCursor.project({ role: 1 })).toBe(findCursor);
    expect(aggregateCursor.match({ active: true })).toBe(aggregateCursor);
    expect(aggregateCursor.sort({ role: 1 })).toBe(aggregateCursor);
    expect(aggregateCursor.limit(5)).toBe(aggregateCursor);
    expect(aggregateCursor.skip(1)).toBe(aggregateCursor);
    expect(aggregateCursor.project({ role: 1 })).toBe(aggregateCursor);
    await expect(findCursor.toArray()).resolves.toEqual([
      { _id: "user-1", role: "mentor" },
    ]);

    expect(cursors.find.cursorClient.write).not.toHaveBeenCalled();
    expect(cursors.aggregate.cursorClient.write).not.toHaveBeenCalled();
    expect(cursors.find.map).not.toHaveBeenCalled();
    expect(cursors.aggregate.map).not.toHaveBeenCalled();
  });

  it("adds the framework session when callers omit filters and options", () => {
    const { connection, frameworkSession, raw } = createHarness();
    const collection = createMigrationTransactionReadDatabase(
      connection,
      frameworkSession,
    ).collection("users");

    collection.find();
    void collection.findOne();
    void collection.countDocuments();
    void collection.estimatedDocumentCount();
    void collection.distinct("role");
    collection.listIndexes();
    collection.aggregate();

    expect(raw.find).toHaveBeenCalledWith({}, { session: frameworkSession });
    expect(raw.findOne).toHaveBeenCalledWith({}, { session: frameworkSession });
    expect(raw.countDocuments).toHaveBeenCalledWith(
      {},
      { session: frameworkSession },
    );
    expect(raw.estimatedDocumentCount).toHaveBeenCalledWith({
      session: frameworkSession,
    });
    expect(raw.distinct).toHaveBeenCalledWith(
      "role",
      {},
      { session: frameworkSession },
    );
    expect(raw.listIndexes).toHaveBeenCalledWith();
    expect(raw.aggregate).toHaveBeenCalledWith(
      [],
      { session: frameworkSession },
    );
  });

  it.each([
    { stage: { $out: "private-output" } },
    { stage: { $facet: { nested: [{ $merge: { into: "private-target" } }] } } },
  ])("blocks persistence aggregates for batch and verify views %#", ({ stage }) => {
    const { connection, frameworkSession, raw } = createHarness();
    const batchCollection = createMigrationTransactionDatabase(
      connection,
      frameworkSession,
    ).collection("users");
    const verifyCollection = createMigrationTransactionReadDatabase(
      connection,
      frameworkSession,
    ).collection("users");

    expect(() => batchCollection.aggregate([stage])).toThrowError(
      "Migration aggregate pipeline contains a prohibited write stage.",
    );
    expect(() => verifyCollection.aggregate([stage])).toThrowError(
      MigrationUsageError,
    );
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it.each([
    { stage: { $lookup: { from: "schema_migrations", as: "ledger" } } },
    { stage: { $unionWith: "schema_migration_locks" } },
    {
      stage: {
        $graphLookup: {
          from: "schema_migrations",
          startWith: "$_id",
          connectFromField: "_id",
          connectToField: "_id",
          as: "ledger",
        },
      },
    },
  ])("blocks control collection reads for batch and verify views %#", ({ stage }) => {
    const { connection, frameworkSession, raw } = createHarness();
    const collections = [
      createMigrationTransactionDatabase(connection, frameworkSession).collection(
        "users",
      ),
      createMigrationTransactionReadDatabase(
        connection,
        frameworkSession,
      ).collection("users"),
    ];

    for (const collection of collections) {
      expect(() => collection.aggregate([stage])).toThrowError(
        MigrationUsageError,
      );
    }
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it("rejects toBSON and accessor aggregate bypasses without leaking their payload", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection, frameworkSession, raw } = createHarness();
    const collection = createMigrationTransactionDatabase(
      connection,
      frameworkSession,
    ).collection("users");
    const getter = vi.fn(() => ({ $out: secret }));
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: getter,
    });
    const payloads = [
      [{ $match: { toBSON: () => ({ $out: secret }) } }],
      [{ $match: accessor }],
    ];

    for (const pipeline of payloads) {
      let failure: unknown;
      try {
        collection.aggregate(pipeline);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MigrationUsageError);
      expect((failure as Error).message).not.toContain(secret);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it.each([
    { out: "private-output" },
    { writeConcern: { w: "majority" } },
    { bypassDocumentValidation: true },
    { explain: true },
    { readPreference: "primary" },
    { readConcern: { level: "snapshot" } },
    { session: { privateSession: true } },
  ])(
    "rejects non-allowlisted aggregate option in batch and verify views %#",
    (options) => {
      const { connection, frameworkSession, raw } = createHarness();
      const collections = [
        createMigrationTransactionDatabase(
          connection,
          frameworkSession,
        ).collection("users"),
        createMigrationTransactionReadDatabase(
          connection,
          frameworkSession,
        ).collection("users"),
      ];

      for (const collection of collections) {
        expect(() =>
          collection.aggregate([], options as never),
        ).toThrowError("Migration aggregate pipeline is invalid.");
      }
      expect(raw.aggregate).not.toHaveBeenCalled();
    },
  );

  it("rejects countDocuments output options in batch and verify views", () => {
    const { connection, frameworkSession, raw } = createHarness();
    const collections = [
      createMigrationTransactionDatabase(
        connection,
        frameworkSession,
      ).collection("users"),
      createMigrationTransactionReadDatabase(
        connection,
        frameworkSession,
      ).collection("users"),
    ];

    for (const collection of collections) {
      expect(() =>
        collection.countDocuments(
          {},
          { out: "private-output" } as never,
        ),
      ).toThrowError("Migration aggregate pipeline is invalid.");
    }
    expect(raw.countDocuments).not.toHaveBeenCalled();
  });

  it("reuses sanitized collection validation for both database views", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection, frameworkSession, rawCollection } = createHarness();
    const databases = [
      createMigrationTransactionDatabase(connection, frameworkSession),
      createMigrationTransactionReadDatabase(connection, frameworkSession),
    ];

    for (const database of databases) {
      for (const name of [
        `users/${secret}`,
        "schema_migrations",
        "schema_migration_locks",
      ]) {
        let failure: unknown;
        try {
          database.collection(name);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(MigrationUsageError);
        expect((failure as Error).message).not.toContain(secret);
        expect(JSON.stringify(failure)).not.toContain(secret);
      }
    }
    expect(rawCollection).not.toHaveBeenCalled();
  });
});
