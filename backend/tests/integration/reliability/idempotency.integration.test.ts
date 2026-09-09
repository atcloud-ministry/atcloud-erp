import mongoose, { Schema, type ClientSession } from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import IdempotencyRecord from "../../../src/models/IdempotencyRecord";
import {
  IdempotencyKeyConflictError,
  IdempotencyService,
  type IdempotencyRecordRepository,
} from "../../../src/services/reliability/IdempotencyService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

interface IdempotentDomainFixture {
  operationKey: string;
  value: number;
}

const IdempotentDomainFixtureModel =
  (mongoose.models.M0IdempotentDomainFixture as
    | mongoose.Model<IdempotentDomainFixture>
    | undefined) ||
  mongoose.model<IdempotentDomainFixture>(
    "M0IdempotentDomainFixture",
    new Schema<IdempotentDomainFixture>(
      {
        operationKey: { type: String, required: true, unique: true },
        value: { type: Number, required: true },
      },
      { collection: "m0_idempotent_domain_fixtures", timestamps: true },
    ),
  );

async function assertTransactionalTestTopology(): Promise<void> {
  const db = mongoose.connection.db;
  expect(db).toBeDefined();
  const hello = (await db!.admin().command({ hello: 1 })) as {
    msg?: unknown;
    setName?: unknown;
  };
  expect(
    hello.setName === "rs0" || hello.msg === "isdbgrid",
    `M0 reliability tests require rs0 or a sharded deployment; received ${JSON.stringify(
      { setName: hello.setName, msg: hello.msg },
    )}`,
  ).toBe(true);

  const capability = await new MongoTransactionService(
    mongoose.connection,
  ).assertTopologyCapability(true);
  expect(capability.supported).toBe(true);
  expect(["replica_set", "sharded"]).toContain(capability.topology);
}

describe("M0 idempotent business writes", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await Promise.all([
      IdempotentDomainFixtureModel.init(),
      IdempotencyRecord.init(),
    ]);
    await assertTransactionalTestTopology();
  });

  beforeEach(async () => {
    await Promise.all([
      IdempotentDomainFixtureModel.deleteMany({}),
      IdempotencyRecord.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      IdempotentDomainFixtureModel.deleteMany({}),
      IdempotencyRecord.deleteMany({}),
    ]);
  });

  it("replays the same key and payload without repeating the business write", async () => {
    const service = new IdempotencyService(
      new MongoTransactionService(mongoose.connection),
    );
    const executeBusinessWrite = vi.fn(async (session: ClientSession) => {
      await IdempotentDomainFixtureModel.create(
        [{ operationKey: "payment-one", value: 125 }],
        { session },
      );
      return {
        httpStatus: 201,
        response: { operationKey: "payment-one", value: 125 },
      };
    });
    const input = {
      scope: "m0.payment.create",
      actorKey: "507f1f77bcf86cd799439011",
      key: "11111111-1111-4111-8111-111111111111",
      requestPayload: { amount: 125, currency: "USD" },
      execute: executeBusinessWrite,
    };

    const first = await service.execute(input);
    const replay = await service.execute(input);

    expect(first).toMatchObject({
      replayed: false,
      httpStatus: 201,
      response: { operationKey: "payment-one", value: 125 },
    });
    expect(replay).toMatchObject({
      receiptId: first.receiptId,
      replayed: true,
      httpStatus: 201,
      response: { operationKey: "payment-one", value: 125 },
    });
    expect(executeBusinessWrite).toHaveBeenCalledTimes(1);
    expect(
      await IdempotentDomainFixtureModel.countDocuments({
        operationKey: "payment-one",
      }),
    ).toBe(1);
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);
    const receipt = await IdempotencyRecord.findById(first.receiptId).lean();
    expect(receipt).toMatchObject({
      hashVersion: 1,
      scope: "m0.payment.create",
      state: "completed",
    });
    expect(receipt?.actorKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt).not.toHaveProperty("actorKey");
    expect(receipt).not.toHaveProperty("key");
    expect(receipt).not.toHaveProperty("requestPayload");
  });

  it("executes only once when identical requests start concurrently", async () => {
    const realRepository =
      IdempotencyRecord as unknown as IdempotencyRecordRepository;
    let initialReadCount = 0;
    let releaseInitialReads!: () => void;
    const bothInitialReadsCompleted = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const synchronizedRepository: IdempotencyRecordRepository = {
      findOne: async (filter, projection, options) => {
        const record = await realRepository.findOne(filter, projection, options);
        if (!record && options?.session && initialReadCount < 2) {
          initialReadCount += 1;
          if (initialReadCount === 2) releaseInitialReads();
          await bothInitialReadsCompleted;
        }
        return record;
      },
      create: (documents, options) =>
        realRepository.create(documents, options),
      updateOne: (filter, update, options) =>
        realRepository.updateOne(filter, update, options),
      deleteOne: (filter, options) =>
        realRepository.deleteOne(filter, options),
    };
    const service = new IdempotencyService(
      new MongoTransactionService(mongoose.connection),
      synchronizedRepository,
    );
    const executeBusinessWrite = vi.fn(async (session: ClientSession) => {
      await IdempotentDomainFixtureModel.create(
        [{ operationKey: "payment-concurrent", value: 250 }],
        { session },
      );
      return {
        httpStatus: 201,
        response: { operationKey: "payment-concurrent", value: 250 },
      };
    });
    const input = {
      scope: "m0.payment.create",
      actorKey: "507f1f77bcf86cd799439011",
      key: "22222222-2222-4222-8222-222222222222",
      requestPayload: { amount: 250, currency: "USD" },
      execute: executeBusinessWrite,
    };

    const results = await Promise.all([
      service.execute(input),
      service.execute(input),
    ]);

    expect(initialReadCount).toBe(2);
    expect(results.filter((result) => result.replayed === false)).toHaveLength(1);
    expect(results.filter((result) => result.replayed === true)).toHaveLength(1);
    expect(results[0].receiptId).toBe(results[1].receiptId);
    expect(executeBusinessWrite).toHaveBeenCalledTimes(1);
    expect(
      await IdempotentDomainFixtureModel.countDocuments({
        operationKey: "payment-concurrent",
      }),
    ).toBe(1);
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);
  });

  it("rejects reuse of the same key with a different payload", async () => {
    const service = new IdempotencyService(
      new MongoTransactionService(mongoose.connection),
    );
    await service.execute({
      scope: "m0.payment.create",
      actorKey: "507f1f77bcf86cd799439011",
      key: "33333333-3333-4333-8333-333333333333",
      requestPayload: { amount: 125, currency: "USD" },
      execute: async (session) => {
        await IdempotentDomainFixtureModel.create(
          [{ operationKey: "payment-conflict", value: 125 }],
          { session },
        );
        return {
          httpStatus: 201,
          response: { operationKey: "payment-conflict", value: 125 },
        };
      },
    });

    const conflictingExecute = vi.fn(async () => ({
      httpStatus: 201,
      response: { operationKey: "should-not-run", value: 999 },
    }));
    const conflict = await service
      .execute({
        scope: "m0.payment.create",
        actorKey: "507f1f77bcf86cd799439011",
        key: "33333333-3333-4333-8333-333333333333",
        requestPayload: { amount: 999, currency: "USD" },
        execute: conflictingExecute,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(conflict).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      scope: "m0.payment.create",
    });
    expect(conflictingExecute).not.toHaveBeenCalled();
    expect(
      await IdempotentDomainFixtureModel.countDocuments({
        operationKey: "payment-conflict",
      }),
    ).toBe(1);
    expect(await IdempotencyRecord.countDocuments({})).toBe(1);
  });
});
