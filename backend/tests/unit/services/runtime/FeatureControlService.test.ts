import type { ClientSession, Model } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlumniNetworkFeatureConfigurationError } from "../../../../src/config/alumniNetworkFeature";
import type { IFeatureControl } from "../../../../src/models/FeatureControl";
import { CasConflictError } from "../../../../src/services/reliability/CasService";
import { MongoTransactionCommitUncertainError } from "../../../../src/services/reliability/MongoTransactionService";
import {
  FeatureControlInputError,
  FeatureControlReleaseUnavailableError,
  FeatureControlService,
} from "../../../../src/services/runtime/FeatureControlService";

const actorId = "507f1f77bcf86cd799439011";
const session = { inTransaction: () => true } as ClientSession;

function buildHarness(options: {
  releaseAvailable?: () => boolean;
  current?: Partial<IFeatureControl> | null;
  readTimeoutMs?: number;
} = {}) {
  const current = options.current === undefined
    ? { _id: "alumni_network", mode: "off", revision: 0, changedBy: actorId }
    : options.current;
  const model = {
    findById: vi.fn().mockResolvedValue(current),
    create: vi.fn(),
  } as unknown as Model<IFeatureControl>;
  const transactions = {
    run: vi.fn(async (operation: (value: ClientSession) => Promise<unknown>) =>
      operation(session),
    ),
  };
  const writeRequiredAudit = vi.fn().mockResolvedValue(undefined);
  const casUpdate = vi.fn().mockResolvedValue({
    _id: "alumni_network",
    mode: "on",
    revision: 1,
    changedBy: actorId,
  });
  const migrationReadiness = {
    assertReady: vi.fn().mockResolvedValue(undefined),
  };
  const service = new FeatureControlService({
    model,
    transactions,
    writeRequiredAudit,
    casUpdate,
    releaseAvailable: options.releaseAvailable ?? (() => true),
    migrationReadiness,
    readTimeoutMs: options.readTimeoutMs,
  });
  return {
    service,
    model,
    transactions,
    writeRequiredAudit,
    casUpdate,
    migrationReadiness,
  };
}

describe("FeatureControlService", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["off", false, false],
    ["read_only", true, false],
    ["on", true, true],
  ] as const)("returns the exact %s runtime DTO", async (mode, readable, writable) => {
    const { service } = buildHarness({
      current: { mode, revision: 7 },
    });

    await expect(service.getRuntimeConfig()).resolves.toEqual({
      success: true,
      data: {
        version: 1,
        revision: 7,
        alumniNetwork: { mode, readable, writable },
      },
    });
  });

  it("forces a stored on mode off when the deployment ceiling is closed", async () => {
    const { service } = buildHarness({
      current: { mode: "on", revision: 9 },
      releaseAvailable: () => false,
    });
    await expect(service.getRuntimeConfig()).resolves.toEqual({
      success: true,
      data: {
        version: 1,
        revision: 9,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
  });

  it("fails Alumni reads and writes closed when migrations are not ready", async () => {
    const harness = buildHarness({ current: { mode: "on", revision: 4 } });
    harness.migrationReadiness.assertReady.mockRejectedValue(
      new Error("private migration state"),
    );

    await expect(harness.service.getRuntimeConfig()).resolves.toMatchObject({
      data: { alumniNetwork: { mode: "off" }, revision: 0 },
    });
    await expect(
      harness.service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 4,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toThrow("private migration state");
    expect(harness.transactions.run).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("database secret")],
    [new AlumniNetworkFeatureConfigurationError()],
  ])("fails public reads closed without exposing failures", async (failure) => {
    const harness = buildHarness();
    vi.mocked(harness.model.findById).mockRejectedValueOnce(failure);
    await expect(harness.service.getRuntimeConfig()).resolves.toEqual({
      success: true,
      data: {
        version: 1,
        revision: 0,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
  });

  it("keeps operational reads strict while public reads fail closed", async () => {
    const failure = new AlumniNetworkFeatureConfigurationError();
    const { service } = buildHarness({
      releaseAvailable: () => {
        throw failure;
      },
    });

    await expect(service.getOperationalRuntimeConfig()).rejects.toBe(failure);
    await expect(service.getRuntimeConfig()).resolves.toEqual({
      success: true,
      data: {
        version: 1,
        revision: 0,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
  });

  it("cancels an operational read at its bounded deadline", async () => {
    const harness = buildHarness({ readTimeoutMs: 5 });
    vi.mocked(harness.model.findById).mockImplementationOnce(
      (() => new Promise(() => undefined)) as never,
    );

    await expect(
      harness.service.getOperationalRuntimeConfig(),
    ).rejects.toBeDefined();
    expect(harness.model.findById).toHaveBeenCalledWith(
      "alumni_network",
      null,
      expect.objectContaining({
        maxTimeMS: 5,
        signal: expect.objectContaining({ aborted: true }),
      }),
    );
  });

  it("updates by CAS and writes the required audit in the same session", async () => {
    const harness = buildHarness();
    const result = await harness.service.updateAlumniNetworkMode({
      mode: "on",
      expectedRevision: 0,
      actorId,
      actorRole: "Super Admin",
      correlationId: "request-123",
    });

    expect(harness.transactions.run).toHaveBeenCalledOnce();
    expect(harness.casUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: harness.model,
        id: "alumni_network",
        expectedRevision: 0,
        session,
        update: {
          $set: { mode: "on", changedBy: actorId },
        },
      }),
    );
    expect(harness.writeRequiredAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "alumni_network.mode_changed",
        actor: { type: "user", id: actorId, role: "Super Admin" },
        source: "http",
        outcome: "success",
        target: { model: "FeatureControl", id: "alumni_network" },
        correlationId: "request-123",
        details: {
          fromMode: "off",
          toMode: "on",
          fromRevision: 0,
          toRevision: 1,
        },
      }),
      session,
    );
    expect(result.data.alumniNetwork).toEqual({
      mode: "on",
      readable: true,
      writable: true,
    });
    expect(result.data).not.toHaveProperty("reasonCode");
  });

  it("creates the singleton at virtual revision zero inside the transaction", async () => {
    const harness = buildHarness({ current: null });
    vi.mocked(harness.model.create).mockResolvedValueOnce([
      {
        _id: "alumni_network",
        mode: "read_only",
        revision: 1,
        changedBy: actorId,
      },
    ] as never);

    const result = await harness.service.updateAlumniNetworkMode({
      mode: "read_only",
      expectedRevision: 0,
      actorId,
      actorRole: "Super Admin",
    });

    expect(harness.model.create).toHaveBeenCalledWith(
      [
        {
          _id: "alumni_network",
          mode: "read_only",
          revision: 1,
          changedBy: actorId,
        },
      ],
      { session },
    );
    expect(result.data.revision).toBe(1);
  });

  it("rejects enabling modes above a closed deployment ceiling", async () => {
    const harness = buildHarness({ releaseAvailable: () => false });
    await expect(
      harness.service.updateAlumniNetworkMode({
        mode: "read_only",
        expectedRevision: 0,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toBeInstanceOf(FeatureControlReleaseUnavailableError);
    expect(harness.transactions.run).not.toHaveBeenCalled();
  });

  it("rejects invalid inputs before opening a transaction", async () => {
    const harness = buildHarness();
    await expect(
      harness.service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: -1,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toBeInstanceOf(FeatureControlInputError);
    expect(harness.transactions.run).not.toHaveBeenCalled();
  });

  it("propagates CAS conflicts and mandatory audit failures", async () => {
    const conflictHarness = buildHarness();
    conflictHarness.casUpdate.mockRejectedValueOnce(
      new CasConflictError(0, 1, "revision_mismatch"),
    );
    await expect(
      conflictHarness.service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 0,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toBeInstanceOf(CasConflictError);

    const auditHarness = buildHarness();
    auditHarness.writeRequiredAudit.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    await expect(
      auditHarness.service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 0,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toThrow("audit unavailable");
  });

  it("reconciles an uncertain commit only against the exact committed request", async () => {
    const committed = buildHarness({
      current: {
        _id: "alumni_network",
        mode: "on",
        revision: 3,
        changedBy: actorId,
      },
    });
    committed.transactions.run.mockRejectedValueOnce(
      new MongoTransactionCommitUncertainError(3, new Error("network")),
    );

    await expect(
      committed.service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 2,
        actorId,
        actorRole: "Super Admin",
      }),
    ).resolves.toMatchObject({ data: { revision: 3, alumniNetwork: { mode: "on" } } });

    const mismatch = buildHarness({
      current: {
        _id: "alumni_network",
        mode: "read_only",
        revision: 3,
        changedBy: actorId,
      },
    });
    const uncertain = new MongoTransactionCommitUncertainError(
      3,
      new Error("network"),
    );
    mismatch.transactions.run.mockRejectedValueOnce(uncertain);
    await expect(
      mismatch.service.updateAlumniNetworkMode({
        mode: "on",
        expectedRevision: 2,
        actorId,
        actorRole: "Super Admin",
      }),
    ).rejects.toBe(uncertain);
  });
});
