import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import AuditLog from "../../../src/models/AuditLog";
import FeatureControl, {
  FEATURE_CONTROL_SINGLETON_ID,
} from "../../../src/models/FeatureControl";
import { CasConflictError } from "../../../src/services/reliability/CasService";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import {
  FeatureControlReleaseUnavailableError,
  FeatureControlService,
} from "../../../src/services/runtime/FeatureControlService";
import { ensureIntegrationDB } from "../setup/connect";

const actorId = "507f1f77bcf86cd799439011";

function createService(
  options: {
    releaseAvailable?: () => boolean;
  } = {},
): FeatureControlService {
  return new FeatureControlService({
    model: FeatureControl,
    transactions: new MongoTransactionService(mongoose.connection),
    releaseAvailable: options.releaseAvailable ?? (() => true),
  });
}

async function assertTransactionalTopology(): Promise<void> {
  const capability = await new MongoTransactionService(
    mongoose.connection,
  ).assertTopologyCapability(true);
  expect(capability.supported).toBe(true);
  expect(["replica_set", "sharded"]).toContain(capability.topology);
}

describe("alumni network feature control persistence", () => {
  beforeAll(async () => {
    expect(process.env.MONGODB_TEST_URI).toBeTruthy();
    await ensureIntegrationDB();
    await Promise.all([FeatureControl.init(), AuditLog.init()]);
    await assertTransactionalTopology();
  });

  beforeEach(async () => {
    await Promise.all([FeatureControl.deleteMany({}), AuditLog.deleteMany({})]);
  });

  afterAll(async () => {
    await Promise.all([FeatureControl.deleteMany({}), AuditLog.deleteMany({})]);
  });

  it("persists off/read_only/on transitions and reads them across service instances", async () => {
    const writer = createService();

    const readOnly = await writer.updateAlumniNetworkMode({
      mode: "read_only",
      expectedRevision: 0,
      actorId,
      actorRole: "Super Admin",
      correlationId: "feature-control-read-only",
    });
    expect(readOnly.data).toEqual({
      version: 1,
      revision: 1,
      alumniNetwork: {
        mode: "read_only",
        readable: true,
        writable: false,
      },
    });

    await writer.updateAlumniNetworkMode({
      mode: "on",
      expectedRevision: 1,
      actorId,
      actorRole: "Super Admin",
      correlationId: "feature-control-on",
    });
    await writer.updateAlumniNetworkMode({
      mode: "off",
      expectedRevision: 2,
      actorId,
      actorRole: "Super Admin",
      correlationId: "feature-control-off",
    });

    const freshReader = createService();
    await expect(freshReader.getOperationalRuntimeConfig()).resolves.toEqual({
      success: true,
      data: {
        version: 1,
        revision: 3,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
    expect(
      await AuditLog.countDocuments({
        action: "alumni_network.mode_changed",
        targetId: FEATURE_CONTROL_SINGLETON_ID,
      }),
    ).toBe(3);
  });

  it("allows only one concurrent writer for a revision and audits only the winner", async () => {
    await FeatureControl.create({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "off",
      revision: 0,
      changedBy: actorId,
    });
    const first = createService();
    const second = createService();

    const settled = await Promise.allSettled([
      first.updateAlumniNetworkMode({
        mode: "read_only",
        expectedRevision: 0,
        actorId,
        actorRole: "Super Admin",
        correlationId: "feature-control-concurrent-a",
      }),
      second.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 0,
        actorId,
        actorRole: "Super Admin",
        correlationId: "feature-control-concurrent-b",
      }),
    ]);

    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      CasConflictError,
    );
    expect(
      await AuditLog.countDocuments({
        action: "alumni_network.mode_changed",
      }),
    ).toBe(1);
    const stored = await FeatureControl.findById(FEATURE_CONTROL_SINGLETON_ID);
    expect(stored?.revision).toBe(1);
    expect(["read_only", "on"]).toContain(stored?.mode);
  });

  it("rolls back the control update when mandatory audit persistence fails", async () => {
    await FeatureControl.create({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "off",
      revision: 0,
      changedBy: actorId,
    });
    const service = new FeatureControlService({
      model: FeatureControl,
      transactions: new MongoTransactionService(mongoose.connection),
      releaseAvailable: () => true,
      writeRequiredAudit: async () => {
        throw new Error("forced audit failure");
      },
    });

    await expect(
      service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 0,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toThrow("forced audit failure");

    const stored = await FeatureControl.findById(FEATURE_CONTROL_SINGLETON_ID);
    expect(stored?.mode).toBe("off");
    expect(stored?.revision).toBe(0);
    expect(await AuditLog.countDocuments({})).toBe(0);
  });

  it("keeps persisted state while a closed deployment ceiling forces runtime off", async () => {
    await FeatureControl.create({
      _id: FEATURE_CONTROL_SINGLETON_ID,
      mode: "on",
      revision: 5,
      changedBy: actorId,
    });
    const service = createService({ releaseAvailable: () => false });

    await expect(service.getOperationalRuntimeConfig()).resolves.toMatchObject({
      data: {
        revision: 5,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
    await expect(
      service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 5,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toBeInstanceOf(FeatureControlReleaseUnavailableError);
    expect(
      (await FeatureControl.findById(FEATURE_CONTROL_SINGLETON_ID))?.mode,
    ).toBe("on");
  });
});
