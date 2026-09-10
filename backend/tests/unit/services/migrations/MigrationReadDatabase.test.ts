import { mongo, type Connection } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { MigrationUsageError } from "../../../../src/services/migrations/MigrationErrors";
import { createMigrationReadDatabase } from "../../../../src/services/migrations/MigrationReadDatabase";

const READ_METHODS = [
  "aggregate",
  "countDocuments",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findOne",
  "listIndexes",
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

function createConnectionDouble() {
  const cursors = {
    aggregate: createCursorDouble([{ role: "mentor" }]),
    find: createCursorDouble([{ _id: "user-1", role: "mentor" }]),
    indexes: createCursorDouble([{ name: "_id_" }]),
  };
  const raw = {
    aggregate: vi.fn(() => cursors.aggregate),
    countDocuments: vi.fn(async () => 17),
    distinct: vi.fn(async () => ["mentor", "mentee"]),
    estimatedDocumentCount: vi.fn(async () => 23),
    find: vi.fn(() => cursors.find),
    findOne: vi.fn(async () => ({ _id: "user-1" })),
    listIndexes: vi.fn(() => cursors.indexes),
    insertOne: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    createIndex: vi.fn(),
  };
  const rawCollection = vi.fn(() => raw);
  const connection = {
    db: { collection: rawCollection },
    client: { secret: "mongodb://private-user:private-password@cluster" },
  } as unknown as Connection;

  return { connection, cursors, raw, rawCollection };
}

describe("MigrationReadDatabase", () => {
  it("exposes and freezes only the approved read API", () => {
    const { connection } = createConnectionDouble();

    const database = createMigrationReadDatabase(connection);
    const collection = database.collection("program.enrollments");

    expect(Object.keys(database)).toEqual(["collection"]);
    expect(Object.isFrozen(database)).toBe(true);
    expect(Object.keys(collection).sort()).toEqual([...READ_METHODS]);
    expect(Object.isFrozen(collection)).toBe(true);

    for (const hiddenName of [
      "connection",
      "db",
      "client",
      "command",
      "insertOne",
      "insertMany",
      "updateOne",
      "updateMany",
      "replaceOne",
      "deleteOne",
      "deleteMany",
      "bulkWrite",
      "createIndex",
      "dropIndex",
      "rename",
      "rawCollection",
    ]) {
      expect(database).not.toHaveProperty(hiddenName);
      expect(collection).not.toHaveProperty(hiddenName);
    }
  });

  it("delegates every read call while replacing native cursors", async () => {
    const { connection, cursors, raw, rawCollection } =
      createConnectionDouble();
    const database = createMigrationReadDatabase(connection);
    const collection = database.collection("users");
    const filter = { active: true };
    const findOptions = { limit: 5 };
    const countOptions = { maxTimeMS: 1_000 };
    const distinctOptions = { maxTimeMS: 500 };
    const indexOptions = { batchSize: 10 };
    const pipeline = [{ $match: filter }, { $project: { role: 1 } }];
    const aggregateOptions = { allowDiskUse: false };

    expect(collection.find(filter, findOptions)).not.toBe(cursors.find);
    await expect(collection.findOne(filter, findOptions)).resolves.toEqual({
      _id: "user-1",
    });
    await expect(
      collection.countDocuments(filter, countOptions),
    ).resolves.toBe(17);
    await expect(
      collection.estimatedDocumentCount(countOptions),
    ).resolves.toBe(23);
    await expect(
      collection.distinct("role", filter, distinctOptions),
    ).resolves.toEqual(["mentor", "mentee"]);
    expect(collection.listIndexes(indexOptions)).not.toBe(cursors.indexes);
    expect(collection.aggregate(pipeline, aggregateOptions)).not.toBe(
      cursors.aggregate,
    );

    expect(rawCollection).toHaveBeenCalledOnce();
    expect(rawCollection).toHaveBeenCalledWith("users");
    expect(raw.find).toHaveBeenCalledWith(filter, findOptions);
    expect(raw.findOne).toHaveBeenCalledWith(filter, findOptions);
    expect(raw.countDocuments).toHaveBeenCalledWith(filter, countOptions);
    expect(raw.estimatedDocumentCount).toHaveBeenCalledWith(countOptions);
    expect(raw.distinct).toHaveBeenCalledWith(
      "role",
      filter,
      distinctOptions,
    );
    expect(raw.listIndexes).toHaveBeenCalledWith(indexOptions);
    expect(raw.aggregate).toHaveBeenCalledWith(pipeline, aggregateOptions);
    expect(raw.aggregate.mock.calls[0][0]).not.toBe(pipeline);
  });

  it("returns frozen cursor wrappers with only safe methods", async () => {
    const { connection, cursors } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const findCursor = collection.find({});
    const aggregateCursor = collection.aggregate([]);
    const indexCursor = collection.listIndexes();
    const findMethods = [
      "close",
      "forEach",
      "hasNext",
      "limit",
      "next",
      "project",
      "skip",
      "sort",
      "toArray",
      "tryNext",
    ];
    const aggregateMethods = [...findMethods, "match"].sort();
    const indexMethods = [
      "close",
      "forEach",
      "hasNext",
      "next",
      "toArray",
      "tryNext",
    ];

    expect(Object.keys(findCursor).sort()).toEqual(findMethods);
    expect(Object.keys(aggregateCursor).sort()).toEqual(aggregateMethods);
    expect(Object.keys(indexCursor).sort()).toEqual(indexMethods);
    expect(Object.isFrozen(findCursor)).toBe(true);
    expect(Object.isFrozen(aggregateCursor)).toBe(true);
    expect(Object.isFrozen(indexCursor)).toBe(true);

    for (const cursor of [findCursor, aggregateCursor, indexCursor]) {
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

    expect(findCursor.sort({ _id: 1 })).toBe(findCursor);
    expect(findCursor.limit(10)).toBe(findCursor);
    expect(findCursor.skip(2)).toBe(findCursor);
    expect(findCursor.project({ role: 1 })).toBe(findCursor);
    await expect(findCursor.toArray()).resolves.toEqual([
      { _id: "user-1", role: "mentor" },
    ]);
    await expect(findCursor.next()).resolves.toEqual({
      _id: "user-1",
      role: "mentor",
    });
    await expect(findCursor.tryNext()).resolves.toEqual({
      _id: "user-1",
      role: "mentor",
    });
    await expect(findCursor.hasNext()).resolves.toBe(true);
    await expect(findCursor.forEach(() => undefined)).resolves.toBeUndefined();
    await expect(findCursor.close({ timeoutMS: 100 })).resolves.toBeUndefined();

    expect(cursors.find.sort).toHaveBeenCalledWith({ _id: 1 }, undefined);
    expect(cursors.find.limit).toHaveBeenCalledWith(10);
    expect(cursors.find.skip).toHaveBeenCalledWith(2);
    expect(cursors.find.project).toHaveBeenCalledWith({ role: 1 });
    expect(cursors.find.map).not.toHaveBeenCalled();
    expect(cursors.find.cursorClient.write).not.toHaveBeenCalled();
  });

  it("does not let native cursor callback binding expose the raw cursor", async () => {
    const { connection, cursors } = createConnectionDouble();
    cursors.find.forEach.mockImplementation(
      async (
        iterator: (this: unknown, document: { _id: string; role: string }) => void,
      ) => {
        iterator.call(cursors.find, { _id: "user-1", role: "mentor" });
      },
    );
    const cursor = createMigrationReadDatabase(connection)
      .collection("users")
      .find({});
    const callbackReceivers: unknown[] = [];

    await cursor.forEach(function observeThis(this: unknown) {
      callbackReceivers.push(this);
    });

    expect(callbackReceivers).toEqual([undefined]);
    expect(cursor).not.toHaveProperty("map");
  });

  it.each([
    "",
    " users",
    "users ",
    ".users",
    "users.",
    "users..archive",
    "system.users",
    "schema_migrations",
    "schema_migration_locks",
    "$cmd",
    "users\0archive",
    "a".repeat(121),
  ])("rejects unsafe collection name %# without touching MongoDB", (name) => {
    const { connection, rawCollection } = createConnectionDouble();
    const database = createMigrationReadDatabase(connection);

    expect(() => database.collection(name)).toThrowError(MigrationUsageError);
    expect(() => database.collection(name)).toThrowError(
      "Migration collection name is invalid.",
    );
    expect(rawCollection).not.toHaveBeenCalled();
  });

  it.each([
    { pipeline: [{ $out: "private-output" }] },
    { pipeline: [{ $merge: { into: "private-merge-target" } }] },
    {
      pipeline: [
        {
          $facet: {
            nested: [
              { $match: { active: true } },
              { $out: "private-nested-output" },
            ],
          },
        },
      ],
    },
    {
      pipeline: [
        {
          $lookup: {
            from: "users",
            pipeline: [{ $merge: { into: "private-nested-merge" } }],
            as: "matches",
          },
        },
      ],
    },
  ])("blocks a persistence stage anywhere in pipeline %#", ({ pipeline }) => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );

    expect(() => collection.aggregate(pipeline)).toThrowError(
      MigrationUsageError,
    );
    expect(() => collection.aggregate(pipeline)).toThrowError(
      "Migration aggregate pipeline contains a prohibited write stage.",
    );
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it.each([
    [{ $lookup: { from: "schema_migrations", as: "ledger" } }],
    [
      {
        $graphLookup: {
          from: "schema_migration_locks",
          startWith: "$_id",
          connectFromField: "_id",
          connectToField: "_id",
          as: "locks",
        },
      },
    ],
    [{ $unionWith: "schema_migrations" }],
    [{ $unionWith: { coll: "schema_migration_locks", pipeline: [] } }],
    [
      {
        $facet: {
          nested: [
            { $lookup: { from: "schema_migrations", as: "ledger" } },
          ],
        },
      },
    ],
    [{ $lookup: { from: { db: "admin", coll: "users" }, as: "users" } }],
  ])("blocks control or cross-database collection reads %#", (pipeline) => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );

    expect(() => collection.aggregate(pipeline as never)).toThrowError(
      MigrationUsageError,
    );
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it("allows safe same-database aggregation collection references", () => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const pipeline = [
      { $lookup: { from: "programs", as: "programs" } },
      { $unionWith: { coll: "events", pipeline: [] } },
      {
        $graphLookup: {
          from: "registrations",
          startWith: "$_id",
          connectFromField: "_id",
          connectToField: "userId",
          as: "registrations",
        },
      },
    ];

    collection.aggregate(pipeline);

    expect(raw.aggregate).toHaveBeenCalledOnce();
    expect(raw.aggregate.mock.calls[0][0]).toEqual(pipeline);
  });

  it("does not disclose rejected collection names or pipeline payloads", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection } = createConnectionDouble();
    const database = createMigrationReadDatabase(connection);

    const collectionError = (() => {
      try {
        database.collection(`users/${secret}`);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const collection = database.collection("users");
    const pipelineError = (() => {
      try {
        collection.aggregate([{ $facet: { nested: [{ $out: secret }] } }]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(collectionError).toBeInstanceOf(MigrationUsageError);
    expect(pipelineError).toBeInstanceOf(MigrationUsageError);
    expect((collectionError as Error).message).not.toContain(secret);
    expect((pipelineError as Error).message).not.toContain(secret);
    expect(JSON.stringify(collectionError)).not.toContain(secret);
    expect(JSON.stringify(pipelineError)).not.toContain(secret);
  });

  it("rejects custom prototypes, toBSON hooks, and accessors without evaluating payloads", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const getter = vi.fn(() => ({ $out: secret }));
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "hidden", {
      enumerable: true,
      get: getter,
    });
    class CustomBson {
      toBSON() {
        return { $out: secret };
      }
    }
    const payloads: unknown[] = [
      [{ $match: new CustomBson() }],
      [{ $match: { toBSON: () => ({ $merge: { into: secret } }) } }],
      [{ $match: accessor }],
    ];

    for (const payload of payloads) {
      let failure: unknown;
      try {
        collection.aggregate(payload as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MigrationUsageError);
      expect((failure as Error).message).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it("allows explicit BSON scalar leaves and isolates the validated pipeline clone", () => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const objectIdHex = "64b64c3f2f9a4c1d2e3f4a5b";
    const objectId = new mongo.ObjectId(objectIdHex);
    const createdAt = new Date("2026-09-09T00:00:00.000Z");
    const digest = Buffer.from("read-only");
    const pattern = /^mentor$/gu;
    const pipeline = [
      {
        $match: {
          _id: objectId,
          createdAt,
          digest,
          pattern,
        },
      },
    ];

    collection.aggregate(pipeline);
    const forwarded = raw.aggregate.mock.calls[0][0];
    const forwardedMatch = forwarded[0].$match;

    expect(forwardedMatch._id).not.toBe(objectId);
    expect(forwardedMatch.createdAt).not.toBe(createdAt);
    expect(forwardedMatch.digest).not.toBe(digest);
    expect(forwardedMatch.pattern).not.toBe(pattern);

    objectId.buffer.fill(0);
    createdAt.setTime(0);
    digest.fill(0);
    pattern.lastIndex = 7;
    pipeline[0] = { $out: "mutated-after-validation" } as never;

    expect(forwarded).not.toBe(pipeline);
    expect(forwarded[0]).not.toBe(pipeline[0]);
    expect(forwarded).not.toEqual([
      { $out: "mutated-after-validation" },
    ]);
    expect(forwardedMatch._id.toHexString()).toBe(objectIdHex);
    expect(forwardedMatch.createdAt.toISOString()).toBe(
      "2026-09-09T00:00:00.000Z",
    );
    expect(Buffer.from(forwardedMatch.digest).toString()).toBe("read-only");
    expect(forwardedMatch.pattern.lastIndex).toBe(0);
  });

  it("rejects augmented scalar hooks and descriptors without evaluating them", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const toBSON = vi.fn(() => ({ $out: secret }));
    const getter = vi.fn(() => ({ $merge: { into: secret } }));
    const objectId = new mongo.ObjectId();
    const date = new Date();
    const digest = Buffer.from("read-only");

    Object.defineProperty(objectId, "toBSON", {
      configurable: true,
      value: toBSON,
    });
    Object.defineProperty(date, "hidden", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    Object.defineProperty(digest, Symbol("hidden"), {
      configurable: true,
      value: secret,
    });

    for (const scalar of [objectId, date, digest]) {
      let failure: unknown;
      try {
        collection.aggregate([{ $match: { scalar } }]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MigrationUsageError);
      expect((failure as Error).message).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
    expect(toBSON).not.toHaveBeenCalled();
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
    { cursor: { batchSize: 10 } },
  ])("rejects non-allowlisted aggregate option %#", (options) => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );

    expect(() => collection.aggregate([], options as never)).toThrowError(
      "Migration aggregate pipeline is invalid.",
    );
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
  ])("rejects non-allowlisted countDocuments option %#", (options) => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );

    expect(() =>
      collection.countDocuments({}, options as never),
    ).toThrowError("Migration aggregate pipeline is invalid.");
    expect(raw.countDocuments).not.toHaveBeenCalled();
  });

  it("rejects countDocuments option getters before touching the raw collection", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const getter = vi.fn(() => secret);
    const options: Record<string, unknown> = {};
    Object.defineProperty(options, "out", {
      enumerable: true,
      get: getter,
    });

    let failure: unknown;
    try {
      collection.countDocuments({}, options as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MigrationUsageError);
    expect((failure as Error).message).not.toContain(secret);
    expect(getter).not.toHaveBeenCalled();
    expect(raw.countDocuments).not.toHaveBeenCalled();
  });

  it("rejects aggregate option getters and custom prototypes without reading secrets", () => {
    const secret = "private-user:private-password@private-cluster";
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const getter = vi.fn(() => secret);
    const getterOptions: Record<string, unknown> = {};
    Object.defineProperty(getterOptions, "out", {
      enumerable: true,
      get: getter,
    });
    const customOptions = Object.create({ out: secret }) as Record<
      string,
      unknown
    >;

    for (const options of [getterOptions, customOptions]) {
      let failure: unknown;
      try {
        collection.aggregate([], options as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MigrationUsageError);
      expect((failure as Error).message).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(raw.aggregate).not.toHaveBeenCalled();
  });

  it("clones allowlisted aggregate options before the native cursor retains them", () => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const options = {
      allowDiskUse: false,
      hint: { active: 1 },
      let: { requestedRole: "mentor" },
    };

    collection.aggregate([], options);
    const forwarded = raw.aggregate.mock.calls[0][1];
    options.hint.active = -1;
    options.let.requestedRole = "mutated";

    expect(forwarded).not.toBe(options);
    expect(forwarded).toEqual({
      allowDiskUse: false,
      hint: { active: 1 },
      let: { requestedRole: "mentor" },
    });
  });

  it("clones allowlisted countDocuments options before delegation", async () => {
    const { connection, raw } = createConnectionDouble();
    const collection = createMigrationReadDatabase(connection).collection(
      "users",
    );
    const options = {
      hint: { active: 1 },
      let: { requestedRole: "mentor" },
      limit: 10,
      skip: 2,
    };

    await collection.countDocuments({}, options);
    const forwarded = raw.countDocuments.mock.calls[0][1];
    options.hint.active = -1;
    options.let.requestedRole = "mutated";

    expect(forwarded).not.toBe(options);
    expect(forwarded).toEqual({
      hint: { active: 1 },
      let: { requestedRole: "mentor" },
      limit: 10,
      skip: 2,
    });
  });

  it("rejects an unavailable connection without exposing connection details", () => {
    const connection = {
      db: undefined,
      uri: "mongodb://private-user:private-password@private-cluster",
    } as unknown as Connection;

    expect(() => createMigrationReadDatabase(connection)).toThrowError(
      "Migration read database is unavailable.",
    );
  });
});
