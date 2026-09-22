import type { ClientSession } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import IdempotencyRecord, {
  type IIdempotencyRecord,
} from "../../../../src/models/IdempotencyRecord";
import {
  IDEMPOTENCY_HASH_VERSION,
  IDEMPOTENCY_LIMITS,
  IdempotencyInProgressError,
  IdempotencyKeyConflictError,
  IdempotencyPayloadTooLargeError,
  IdempotencyPersistenceError,
  IdempotencyService,
  IdempotencyValidationError,
  canonicalizeIdempotencyPayload,
  hashIdempotencyPayload,
  hashIdempotencyValue,
  type IdempotencyRecordRepository,
} from "../../../../src/services/reliability/IdempotencyService";
import type {
  MongoTransactionAttemptContext,
  MongoTransactionService,
} from "../../../../src/services/reliability/MongoTransactionService";

const FIXED_NOW = new Date("2026-09-08T12:00:00.000Z");
const FUTURE_EXPIRY = new Date("2026-09-09T12:00:00.000Z");
const SCOPE = "alumni.help.create";
const ACTOR_KEY = "507f1f77bcf86cd799439011";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

function makeRecord(
  overrides: Partial<IIdempotencyRecord> = {},
): IIdempotencyRecord {
  return {
    _id: "receipt-1",
    hashVersion: IDEMPOTENCY_HASH_VERSION,
    scope: SCOPE,
    actorKeyHash: hashIdempotencyValue(SCOPE, "actor", ACTOR_KEY),
    keyHash: hashIdempotencyValue(SCOPE, "key", IDEMPOTENCY_KEY),
    requestHash: hashIdempotencyPayload(SCOPE, { message: "hello" }),
    state: "in_progress",
    expiresAt: FUTURE_EXPIRY,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  } as unknown as IIdempotencyRecord;
}

function createHarness(now: () => Date = () => new Date(FIXED_NOW)) {
  const session = { id: "session-1" } as unknown as ClientSession;
  const attemptContext: MongoTransactionAttemptContext = {
    attempt: 1,
    maxAttempts: 3,
  };
  const run = vi.fn(
    async <T>(
      operation: (
        activeSession: ClientSession,
        context: MongoTransactionAttemptContext,
      ) => Promise<T>,
    ): Promise<T> => operation(session, attemptContext),
  );
  const findOne = vi.fn().mockResolvedValue(null);
  const create = vi.fn().mockResolvedValue([makeRecord()]);
  const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
  const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
  const repository = {
    findOne,
    create,
    updateOne,
    deleteOne,
  } as unknown as IdempotencyRecordRepository;
  const transactions = {
    run: run as MongoTransactionService["run"],
  };
  const service = new IdempotencyService(
    transactions,
    repository,
    now,
  );

  return {
    service,
    session,
    attemptContext,
    run,
    findOne,
    create,
    updateOne,
    deleteOne,
  };
}

function baseInput() {
  return {
    scope: SCOPE,
    actorKey: ACTOR_KEY,
    key: IDEMPOTENCY_KEY,
    requestPayload: { message: "hello" },
  } as const;
}

describe("idempotency payload canonicalization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = {
      z: true,
      nested: { second: 2, first: 1 },
      values: ["a", "b"],
    };
    const right = {
      values: ["a", "b"],
      nested: { first: 1, second: 2 },
      z: true,
    };

    expect(canonicalizeIdempotencyPayload(left)).toBe(
      '{"nested":{"first":1,"second":2},"values":["a","b"],"z":true}',
    );
    expect(hashIdempotencyPayload(SCOPE, left)).toBe(
      hashIdempotencyPayload(SCOPE, right),
    );
    expect(hashIdempotencyPayload(SCOPE, ["a", "b"])).not.toBe(
      hashIdempotencyPayload(SCOPE, ["b", "a"]),
    );
  });

  it("domain-separates hashes and prevents cross-scope correlation", () => {
    expect(hashIdempotencyValue(SCOPE, "actor", ACTOR_KEY)).not.toBe(
      hashIdempotencyValue(SCOPE, "key", ACTOR_KEY),
    );
    expect(hashIdempotencyValue(SCOPE, "actor", ACTOR_KEY)).not.toBe(
      hashIdempotencyValue("alumni.help.accept", "actor", ACTOR_KEY),
    );
    expect(hashIdempotencyValue(SCOPE, "key", IDEMPOTENCY_KEY)).not.toBe(
      hashIdempotencyValue(
        "alumni.help.accept",
        "key",
        IDEMPOTENCY_KEY,
      ),
    );
    expect(hashIdempotencyPayload(SCOPE, { accepted: true })).not.toBe(
      hashIdempotencyPayload("alumni.help.accept", { accepted: true }),
    );
  });

  it("rejects unsupported, circular, sparse, and non-finite input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse = new Array(2);
    sparse[1] = "value";

    for (const payload of [
      undefined,
      BigInt(1),
      Number.NaN,
      new Date(),
      circular,
      sparse,
    ]) {
      expect(() => canonicalizeIdempotencyPayload(payload)).toThrow(
        IdempotencyValidationError,
      );
    }
  });

  it("enforces separate UTF-8 byte limits for request and response payloads", () => {
    expect(() =>
      canonicalizeIdempotencyPayload(
        "x".repeat(IDEMPOTENCY_LIMITS.maxRequestBytes + 1),
        "request",
      ),
    ).toThrow(IdempotencyPayloadTooLargeError);
    expect(() =>
      canonicalizeIdempotencyPayload(
        "x".repeat(IDEMPOTENCY_LIMITS.maxResponseBytes + 1),
        "response",
      ),
    ).toThrow(
      expect.objectContaining({
        payloadKind: "response",
        maxBytes: IDEMPOTENCY_LIMITS.maxResponseBytes,
      }),
    );
  });
});

describe("IdempotencyService", () => {
  it("executes the first request and persists domain result and receipt in one session", async () => {
    const harness = createHarness();
    const execute = vi.fn(async (session, context) => {
      expect(session).toBe(harness.session);
      expect(context).toBe(harness.attemptContext);
      return {
        httpStatus: 201,
        response: { z: 2, a: 1 },
        resource: { type: "AlumniHelp", id: "help:123" },
      };
    });

    await expect(
      harness.service.execute({ ...baseInput(), execute }),
    ).resolves.toEqual({
      receiptId: "receipt-1",
      replayed: false,
      httpStatus: 201,
      response: { a: 1, z: 2 },
      resource: { type: "AlumniHelp", id: "help:123" },
    });

    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.findOne).toHaveBeenCalledWith(
      {
        hashVersion: IDEMPOTENCY_HASH_VERSION,
        scope: SCOPE,
        actorKeyHash: hashIdempotencyValue(SCOPE, "actor", ACTOR_KEY),
        keyHash: hashIdempotencyValue(SCOPE, "key", IDEMPOTENCY_KEY),
      },
      undefined,
      { session: harness.session },
    );
    const createdDocument = harness.create.mock.calls[0][0][0];
    expect(createdDocument).toMatchObject({
      hashVersion: IDEMPOTENCY_HASH_VERSION,
      scope: SCOPE,
      actorKeyHash: hashIdempotencyValue(SCOPE, "actor", ACTOR_KEY),
      keyHash: hashIdempotencyValue(SCOPE, "key", IDEMPOTENCY_KEY),
      requestHash: hashIdempotencyPayload(SCOPE, { message: "hello" }),
      state: "in_progress",
    });
    expect(createdDocument).not.toHaveProperty("actorKey");
    expect(createdDocument).not.toHaveProperty("key");
    expect(harness.create.mock.calls[0][1]).toEqual({
      session: harness.session,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.updateOne).toHaveBeenCalledWith(
      { _id: "receipt-1", state: "in_progress" },
      {
        $set: {
          state: "completed",
          httpStatus: 201,
          response: { a: 1, z: 2 },
          resource: { type: "AlumniHelp", id: "help:123" },
          completedAt: FIXED_NOW,
          expiresAt: FUTURE_EXPIRY,
        },
      },
      { session: harness.session, runValidators: true },
    );
  });

  it("replays a completed receipt for the same canonical request", async () => {
    const harness = createHarness();
    const completed = makeRecord({
      requestHash: hashIdempotencyPayload(SCOPE, { b: 2, a: 1 }),
      state: "completed",
      httpStatus: 200,
      response: { accepted: true },
      completedAt: FIXED_NOW,
    });
    harness.findOne.mockResolvedValue(completed);
    const execute = vi.fn();

    await expect(
      harness.service.execute({
        ...baseInput(),
        requestPayload: { a: 1, b: 2 },
        execute,
      }),
    ).resolves.toEqual({
      receiptId: "receipt-1",
      replayed: true,
      httpStatus: 200,
      response: { accepted: true },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.updateOne).not.toHaveBeenCalled();
  });

  it("rejects reuse of the same actor-scoped key for a different request", async () => {
    const harness = createHarness();
    harness.findOne.mockResolvedValue(
      makeRecord({
        requestHash: hashIdempotencyPayload(SCOPE, { different: true }),
        state: "completed",
        httpStatus: 200,
        response: { accepted: true },
        completedAt: FIXED_NOW,
      }),
    );
    const execute = vi.fn();

    await expect(
      harness.service.execute({ ...baseInput(), execute }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(execute).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("reports an existing unfinished receipt without running the domain callback", async () => {
    const harness = createHarness();
    harness.findOne.mockResolvedValue(makeRecord());
    const execute = vi.fn();

    await expect(
      harness.service.execute({ ...baseInput(), execute }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("replaces a logically expired receipt inside the transaction", async () => {
    const harness = createHarness();
    harness.findOne.mockResolvedValue(
      makeRecord({ expiresAt: new Date("2026-09-08T11:59:59.000Z") }),
    );

    await harness.service.execute({
      ...baseInput(),
      execute: async () => ({ httpStatus: 204, resource: { type: "Help", id: "1" } }),
    });

    expect(harness.deleteOne).toHaveBeenCalledWith(
      {
        _id: "receipt-1",
        expiresAt: { $lte: FIXED_NOW },
      },
      { session: harness.session },
    );
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("starts the receipt TTL when the operation completes", async () => {
    const startedAt = new Date("2026-09-08T12:00:00.000Z");
    const completedAt = new Date("2026-09-08T12:00:45.000Z");
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(startedAt)
      .mockReturnValueOnce(completedAt);
    const harness = createHarness(clock);

    await harness.service.execute({
      ...baseInput(),
      ttlMs: IDEMPOTENCY_LIMITS.minTtlMs,
      execute: async () => ({
        httpStatus: 201,
        resource: { type: "AlumniHelp", id: "help-ttl" },
      }),
    });

    expect(harness.create.mock.calls[0][0][0]).toMatchObject({
      expiresAt: new Date(
        startedAt.getTime() + IDEMPOTENCY_LIMITS.minTtlMs,
      ),
    });
    expect(harness.updateOne.mock.calls[0][1]).toMatchObject({
      $set: {
        completedAt,
        expiresAt: new Date(
          completedAt.getTime() + IDEMPOTENCY_LIMITS.minTtlMs,
        ),
      },
    });
  });

  it("reconciles a concurrent unique-key insert by replaying its committed receipt", async () => {
    const harness = createHarness();
    harness.run.mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 }));
    harness.findOne.mockResolvedValue(
      makeRecord({
        state: "completed",
        httpStatus: 202,
        resource: { type: "AlumniHelp", id: "help-2" },
        completedAt: FIXED_NOW,
      }),
    );
    const execute = vi.fn();

    await expect(
      harness.service.execute({ ...baseInput(), execute }),
    ).resolves.toEqual({
      receiptId: "receipt-1",
      replayed: true,
      httpStatus: 202,
      resource: { type: "AlumniHelp", id: "help-2" },
    });
    expect(harness.findOne).toHaveBeenCalledWith({
      hashVersion: IDEMPOTENCY_HASH_VERSION,
      scope: SCOPE,
      actorKeyHash: hashIdempotencyValue(SCOPE, "actor", ACTOR_KEY),
      keyHash: hashIdempotencyValue(SCOPE, "key", IDEMPOTENCY_KEY),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails if the completion write loses ownership of the receipt", async () => {
    const harness = createHarness();
    harness.updateOne.mockResolvedValue({ matchedCount: 0 });

    await expect(
      harness.service.execute({
        ...baseInput(),
        execute: async () => ({ httpStatus: 200, response: { ok: true } }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyPersistenceError);
  });

  it("validates identifiers, TTL, status, and durable result shape", async () => {
    const invalidScope = createHarness();
    await expect(
      invalidScope.service.execute({
        ...baseInput(),
        scope: "Invalid Scope",
        execute: async () => ({ httpStatus: 200, response: { ok: true } }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyValidationError);
    expect(invalidScope.run).not.toHaveBeenCalled();

    const nonOpaqueActor = createHarness();
    await expect(
      nonOpaqueActor.service.execute({
        ...baseInput(),
        actorKey: "alumni@example.org",
        execute: async () => ({ httpStatus: 200, response: { ok: true } }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyValidationError);
    expect(nonOpaqueActor.run).not.toHaveBeenCalled();

    const nonUuidKey = createHarness();
    await expect(
      nonUuidKey.service.execute({
        ...baseInput(),
        key: "retry-key-1",
        execute: async () => ({ httpStatus: 200, response: { ok: true } }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyValidationError);
    expect(nonUuidKey.run).not.toHaveBeenCalled();

    const invalidTtl = createHarness();
    await expect(
      invalidTtl.service.execute({
        ...baseInput(),
        ttlMs: IDEMPOTENCY_LIMITS.minTtlMs - 1,
        execute: async () => ({ httpStatus: 200, response: { ok: true } }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyValidationError);
    expect(invalidTtl.run).not.toHaveBeenCalled();

    const invalidResult = createHarness();
    await expect(
      invalidResult.service.execute({
        ...baseInput(),
        execute: async () => ({ httpStatus: 99 }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyValidationError);
  });

  it("rejects an oversized response before completing the receipt", async () => {
    const harness = createHarness();

    await expect(
      harness.service.execute({
        ...baseInput(),
        execute: async () => ({
          httpStatus: 200,
          response: {
            resultCode: "x".repeat(IDEMPOTENCY_LIMITS.maxResponseBytes + 1),
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_PAYLOAD_TOO_LARGE",
      payloadKind: "response",
    });
    expect(harness.updateOne).not.toHaveBeenCalled();
  });

  it("rejects secret or human-authored content fields at any response depth", async () => {
    for (const response of [
      { accessToken: "secret" },
      { result: { openingMessage: "private prose" } },
      { items: [{ profileContent: "private prose" }] },
    ]) {
      const harness = createHarness();
      await expect(
        harness.service.execute({
          ...baseInput(),
          execute: async () => ({ httpStatus: 200, response }),
        }),
      ).rejects.toBeInstanceOf(IdempotencyValidationError);
      expect(harness.updateOne).not.toHaveBeenCalled();
    }
  });

  it("allows opaque references and hashes that name message or content resources", async () => {
    const harness = createHarness();

    await expect(
      harness.service.execute({
        ...baseInput(),
        actorKey: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        key: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
        requestPayload: { openingNote: "request content remains hashable" },
        execute: async () => ({
          httpStatus: 201,
          response: {
            status: "accepted",
            messageId: "message-123",
            messageCount: 1,
            contentHash: "a".repeat(64),
            requestId: "request-123",
          },
        }),
      }),
    ).resolves.toMatchObject({
      replayed: false,
      response: {
        status: "accepted",
        messageId: "message-123",
        contentHash: "a".repeat(64),
      },
    });
    expect(harness.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKeyHash: hashIdempotencyValue(
          SCOPE,
          "actor",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        keyHash: hashIdempotencyValue(
          SCOPE,
          "key",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ),
      }),
      undefined,
      { session: harness.session },
    );
  });

  it("fails closed instead of replaying a persisted response outside the DTO contract", async () => {
    const harness = createHarness();
    harness.findOne.mockResolvedValue(
      makeRecord({
        state: "completed",
        httpStatus: 200,
        response: { message: "private content" },
        completedAt: FIXED_NOW,
      }),
    );

    await expect(
      harness.service.execute({
        ...baseInput(),
        execute: async () => ({ httpStatus: 200, response: { ok: true } }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyValidationError);
  });
});

describe("IdempotencyRecord schema", () => {
  it("defines the actor-scoped unique receipt identity and TTL indexes", () => {
    expect(IdempotencyRecord.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { hashVersion: 1, scope: 1, actorKeyHash: 1, keyHash: 1 },
          expect.objectContaining({
            unique: true,
            name: "uniq_idempotency_scope_actor_key",
          }),
        ],
        [
          { expiresAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: "ttl_idempotency_records",
          }),
        ],
      ]),
    );
  });

  it("requires completed receipts to contain a durable response or resource", async () => {
    const hash = "a".repeat(64);
    const incomplete = new IdempotencyRecord({
      scope: "alumni.help.create",
      hashVersion: IDEMPOTENCY_HASH_VERSION,
      actorKeyHash: hash,
      keyHash: hash,
      requestHash: hash,
      state: "completed",
      httpStatus: 200,
      completedAt: FIXED_NOW,
      expiresAt: FUTURE_EXPIRY,
    });
    const resourceOnly = new IdempotencyRecord({
      scope: "alumni.help.create",
      hashVersion: IDEMPOTENCY_HASH_VERSION,
      actorKeyHash: hash,
      keyHash: hash,
      requestHash: hash,
      state: "completed",
      httpStatus: 201,
      resource: { type: "AlumniHelp", id: "help-3" },
      completedAt: FIXED_NOW,
      expiresAt: FUTURE_EXPIRY,
    });

    await expect(incomplete.validate()).rejects.toThrow(
      "Completed idempotency record requires a response or resource reference.",
    );
    await expect(resourceOnly.validate()).resolves.toBeUndefined();
  });

  it("enforces the safe replay DTO contract at the persistence boundary", async () => {
    const hash = "b".repeat(64);
    const unsafe = new IdempotencyRecord({
      scope: SCOPE,
      actorKeyHash: hash,
      keyHash: hash,
      requestHash: hash,
      state: "completed",
      httpStatus: 200,
      response: { result: { privateMessage: "must not persist" } },
      completedAt: FIXED_NOW,
      expiresAt: FUTURE_EXPIRY,
    });

    expect(unsafe.hashVersion).toBe(IDEMPOTENCY_HASH_VERSION);
    await expect(unsafe.validate()).rejects.toThrow(
      "Idempotency response must be a minimal JSON DTO without secrets or human-authored content.",
    );
  });

  it("enforces response resource limits at the persistence boundary", async () => {
    const hash = "c".repeat(64);
    const baseRecord = {
      scope: SCOPE,
      actorKeyHash: hash,
      keyHash: hash,
      requestHash: hash,
      state: "completed" as const,
      httpStatus: 200,
      completedAt: FIXED_NOW,
      expiresAt: FUTURE_EXPIRY,
    };
    let tooDeep: Record<string, unknown> = { ok: true };
    for (let depth = 0; depth <= IDEMPOTENCY_LIMITS.maxDepth; depth += 1) {
      tooDeep = { result: tooDeep };
    }

    const invalidResponses = [
      { resultCode: "x".repeat(IDEMPOTENCY_LIMITS.maxResponseBytes + 1) },
      tooDeep,
      { items: Array.from({ length: IDEMPOTENCY_LIMITS.maxNodes }, () => true) },
    ];

    for (const response of invalidResponses) {
      const record = new IdempotencyRecord({ ...baseRecord, response });
      await expect(record.validate()).rejects.toThrow(
        "Idempotency response must be a minimal JSON DTO without secrets or human-authored content.",
      );
    }
  });
});
