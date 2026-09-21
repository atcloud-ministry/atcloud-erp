import mongoose, { Schema } from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import AuditLog from "../../../src/models/AuditLog";
import NotificationOutbox from "../../../src/models/NotificationOutbox";
import { AuditLogService } from "../../../src/services/AuditLogService";
import {
  CasConflictError,
  CasService,
  type RevisionedEntity,
} from "../../../src/services/reliability/CasService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { NotificationOutboxService } from "../../../src/services/reliability/NotificationOutboxService";
import { ensureIntegrationDB } from "../setup/connect";

interface TransactionFixture {
  operationKey: string;
  value: number;
}

interface CasFixture extends RevisionedEntity {
  _id: mongoose.Types.ObjectId;
  counter: number;
  revision: number;
}

const TransactionFixtureModel =
  (mongoose.models.M0TransactionFixture as
    | mongoose.Model<TransactionFixture>
    | undefined) ||
  mongoose.model<TransactionFixture>(
    "M0TransactionFixture",
    new Schema<TransactionFixture>(
      {
        operationKey: { type: String, required: true, unique: true },
        value: { type: Number, required: true },
      },
      { collection: "m0_transaction_fixtures", timestamps: true },
    ),
  );

const CasFixtureModel =
  (mongoose.models.M0CasFixture as mongoose.Model<CasFixture> | undefined) ||
  mongoose.model<CasFixture>(
    "M0CasFixture",
    new Schema<CasFixture>(
      {
        counter: { type: Number, required: true },
        revision: { type: Number, required: true, min: 0 },
      },
      { collection: "m0_cas_fixtures", timestamps: true },
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

describe("M0 transaction atomicity and CAS", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await Promise.all([
      TransactionFixtureModel.init(),
      CasFixtureModel.init(),
      AuditLog.init(),
      NotificationOutbox.init(),
    ]);
    await assertTransactionalTestTopology();
  });

  beforeEach(async () => {
    await Promise.all([
      TransactionFixtureModel.deleteMany({}),
      CasFixtureModel.deleteMany({}),
      AuditLog.deleteMany({}),
      NotificationOutbox.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      TransactionFixtureModel.deleteMany({}),
      CasFixtureModel.deleteMany({}),
      AuditLog.deleteMany({}),
      NotificationOutbox.deleteMany({}),
    ]);
  });

  it("commits domain, required audit, and outbox writes together", async () => {
    const transactions = new MongoTransactionService(mongoose.connection);
    const outbox = new NotificationOutboxService();

    await transactions.run(async (session) => {
      await TransactionFixtureModel.create(
        [{ operationKey: "commit-one", value: 41 }],
        { session },
      );
      await AuditLogService.recordRequiredInTransaction(
        {
          action: "m0.transaction.commit",
          actor: { type: "system", key: "m0-foundation-test" },
          source: "system",
          outcome: "success",
          target: { model: "M0TransactionFixture", id: "commit-one" },
          correlationId: "m0-commit-one",
          details: { value: 41 },
        },
        session,
      );
      await outbox.enqueueInTransaction({
        topic: "m0.transaction",
        dedupeKey: "commit-one",
        payloadVersion: 1,
        payload: { operationKey: "commit-one", value: 41 },
        correlationId: "m0-commit-one",
        session,
      });
    });

    expect(
      await TransactionFixtureModel.countDocuments({ operationKey: "commit-one" }),
    ).toBe(1);
    expect(
      await AuditLog.countDocuments({
        action: "m0.transaction.commit",
        correlationId: "m0-commit-one",
      }),
    ).toBe(1);
    expect(
      await NotificationOutbox.countDocuments({
        topic: "m0.transaction",
        correlationId: "m0-commit-one",
        status: "pending",
      }),
    ).toBe(1);
  });

  it("rolls back domain, required audit, and outbox writes together", async () => {
    const transactions = new MongoTransactionService(mongoose.connection);
    const outbox = new NotificationOutboxService();

    await expect(
      transactions.run(async (session) => {
        await TransactionFixtureModel.create(
          [{ operationKey: "rollback-one", value: 99 }],
          { session },
        );
        await AuditLogService.recordRequiredInTransaction(
          {
            action: "m0.transaction.rollback",
            actor: { type: "system", key: "m0-foundation-test" },
            source: "system",
            outcome: "failure",
            target: { model: "M0TransactionFixture", id: "rollback-one" },
            correlationId: "m0-rollback-one",
          },
          session,
        );
        await outbox.enqueueInTransaction({
          topic: "m0.transaction",
          dedupeKey: "rollback-one",
          payloadVersion: 1,
          payload: { operationKey: "rollback-one", value: 99 },
          correlationId: "m0-rollback-one",
          session,
        });
        throw new Error("force transaction rollback");
      }),
    ).rejects.toThrow("force transaction rollback");

    expect(
      await TransactionFixtureModel.countDocuments({ operationKey: "rollback-one" }),
    ).toBe(0);
    expect(
      await AuditLog.countDocuments({ correlationId: "m0-rollback-one" }),
    ).toBe(0);
    expect(
      await NotificationOutbox.countDocuments({ correlationId: "m0-rollback-one" }),
    ).toBe(0);
  });

  it("allows only one of two concurrent updates at the same revision", async () => {
    const fixture = await CasFixtureModel.create({ counter: 0, revision: 0 });
    const update = () =>
      CasService.update<CasFixture>({
        model: CasFixtureModel,
        id: fixture._id,
        expectedRevision: 0,
        update: { $inc: { counter: 1 } },
        session: null,
      });

    const settled = await Promise.allSettled([update(), update()]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = (rejected[0] as PromiseRejectedResult).reason;
    expect(conflict).toBeInstanceOf(CasConflictError);
    expect(conflict).toMatchObject({
      code: "CAS_CONFLICT",
      reason: "revision_mismatch",
      expectedRevision: 0,
      actualRevision: 1,
    });

    const persisted = await CasFixtureModel.findById(fixture._id).lean();
    expect(persisted).toMatchObject({ counter: 1, revision: 1 });
  });
});
