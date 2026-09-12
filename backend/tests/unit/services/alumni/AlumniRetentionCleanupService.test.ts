import mongoose, { type ClientSession, type Model } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { IAlumniImportBatch } from "../../../../src/models/AlumniImportBatch";
import type { IAlumniInvitation } from "../../../../src/models/AlumniInvitation";
import {
  AlumniRetentionCleanupService,
  type AlumniRetentionRunContext,
} from "../../../../src/services/alumni/AlumniRetentionCleanupService";
import {
  WORKER_CAPABILITIES,
  WORKER_SERVICE_KEYS,
} from "../../../../src/services/authorization/WorkerAuthorizationService";

const NOW = new Date("2032-03-12T12:00:00.000Z");

function queryReturning<T>(rows: readonly T[]) {
  const query = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(rows),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function context(): AlumniRetentionRunContext {
  return {} as AlumniRetentionRunContext;
}

function setup(options: {
  readonly importRows?: readonly Record<string, unknown>[];
  readonly invitationRows?: readonly Record<string, unknown>[];
  readonly importModifiedCount?: number;
  readonly invitationModifiedCount?: number;
  readonly authorizeError?: Error;
} = {}) {
  const importQuery = queryReturning(options.importRows ?? []);
  const invitationQuery = queryReturning(options.invitationRows ?? []);
  const importBatchModel = {
    find: vi.fn().mockReturnValue(importQuery),
    updateOne: vi.fn().mockResolvedValue({
      matchedCount: options.importModifiedCount ?? 1,
      modifiedCount: options.importModifiedCount ?? 1,
    }),
  } as unknown as Model<IAlumniImportBatch>;
  const invitationModel = {
    find: vi.fn().mockReturnValue(invitationQuery),
    updateOne: vi.fn().mockResolvedValue({
      matchedCount: options.invitationModifiedCount ?? 1,
      modifiedCount: options.invitationModifiedCount ?? 1,
    }),
  } as unknown as Model<IAlumniInvitation>;
  const session = { inTransaction: () => true } as ClientSession;
  const transactions = {
    run: vi.fn(async (operation: (value: ClientSession) => Promise<unknown>) =>
      operation(session),
    ),
  };
  const audit = { recordRequiredInTransaction: vi.fn().mockResolvedValue(undefined) };
  const authorization = {
    assertCapability: options.authorizeError
      ? vi.fn().mockRejectedValue(options.authorizeError)
      : vi.fn().mockResolvedValue(undefined),
  };
  const service = new AlumniRetentionCleanupService({
    now: () => new Date(NOW),
    transactions,
    audit,
    authorization,
    importBatchModel,
    invitationModel,
  });
  return {
    service,
    importBatchModel,
    invitationModel,
    importQuery,
    invitationQuery,
    transactions,
    audit,
    authorization,
    session,
  };
}

describe("AlumniRetentionCleanupService", () => {
  it("authorizes first, then purges bounded import and invitation candidates with CAS audits", async () => {
    const batchId = new mongoose.Types.ObjectId();
    const activeId = new mongoose.Types.ObjectId();
    const invalidatedId = new mongoose.Types.ObjectId();
    const fixture = setup({
      importRows: [{ _id: batchId, revision: 2, status: "completed" }],
      invitationRows: [
        { _id: activeId, revision: 3, status: "active" },
        { _id: invalidatedId, revision: 4, status: "invalidated" },
      ],
    });
    const runContext = context();

    await expect(fixture.service.runBounded(runContext)).resolves.toEqual({
      importCandidatesScanned: 1,
      importBatchesPurged: 1,
      invitationCandidatesScanned: 2,
      invitationsPurged: 2,
    });

    expect(fixture.authorization.assertCapability).toHaveBeenCalledWith(
      runContext,
      WORKER_CAPABILITIES.ALUMNI_RETENTION_PURGE,
      {
        resource: { type: "alumni_retention", id: "expired-private-data" },
      },
    );
    expect(
      fixture.authorization.assertCapability.mock.invocationCallOrder[0],
    ).toBeLessThan(
      (fixture.importBatchModel.find as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    );
    expect(fixture.importQuery.limit).toHaveBeenCalledWith(100);
    expect(fixture.invitationQuery.limit).toHaveBeenCalledWith(100);
    expect(fixture.importBatchModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: batchId,
        revision: 2,
        status: "completed",
        rawDataPurgeAt: { $lte: NOW },
      }),
      {
        $unset: {
          rawHeaders: 1,
          rawRows: 1,
          rowErrors: 1,
          rowResults: 1,
        },
        $set: { rawDataPurgedAt: NOW, revision: 3 },
      },
      expect.objectContaining({ session: fixture.session }),
    );
    expect(fixture.invitationModel.updateOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ _id: activeId, revision: 3, status: "active" }),
      expect.objectContaining({
        $unset: expect.objectContaining({
          contactEmail: 1,
          contactLookupHash: 1,
          activeContactLookupHash: 1,
          matchedUserId: 1,
          tokenHash: 1,
        }),
        $set: {
          status: "invalidated",
          invalidatedAt: NOW,
          contactPurgedAt: NOW,
          revision: 4,
        },
      }),
      expect.objectContaining({ session: fixture.session }),
    );
    expect(fixture.invitationModel.updateOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        _id: invalidatedId,
        revision: 4,
        status: "invalidated",
      }),
      expect.objectContaining({
        $set: { contactPurgedAt: NOW, revision: 5 },
      }),
      expect.objectContaining({ session: fixture.session }),
    );
    expect(fixture.audit.recordRequiredInTransaction).toHaveBeenCalledTimes(3);
    expect(fixture.audit.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "alumni_import.raw_data_purged",
        actor: { type: "worker", key: WORKER_SERVICE_KEYS.ALUMNI_RETENTION },
        reasonCode: "retention_expired",
        target: { model: "AlumniImportBatch", id: batchId.toString() },
        details: expect.objectContaining({ retentionDays: 30 }),
      }),
      fixture.session,
    );
    const serializedAudit = JSON.stringify(
      fixture.audit.recordRequiredInTransaction.mock.calls,
    );
    expect(serializedAudit).not.toContain("contactEmail");
    expect(serializedAudit).not.toContain("tokenHash");
  });

  it("does not audit stale candidates when revision CAS loses", async () => {
    const fixture = setup({
      importRows: [
        {
          _id: new mongoose.Types.ObjectId(),
          revision: 7,
          status: "failed",
        },
      ],
      invitationRows: [
        {
          _id: new mongoose.Types.ObjectId(),
          revision: 8,
          status: "active",
        },
      ],
      importModifiedCount: 0,
      invitationModifiedCount: 0,
    });

    await expect(fixture.service.runBounded(context())).resolves.toEqual({
      importCandidatesScanned: 1,
      importBatchesPurged: 0,
      invitationCandidatesScanned: 1,
      invitationsPurged: 0,
    });
    expect(fixture.audit.recordRequiredInTransaction).not.toHaveBeenCalled();
  });

  it("fails closed on authorization denial before any candidate read", async () => {
    const denial = new Error("denied");
    const fixture = setup({ authorizeError: denial });

    await expect(fixture.service.runBounded(context())).rejects.toBe(denial);
    expect(fixture.importBatchModel.find).not.toHaveBeenCalled();
    expect(fixture.invitationModel.find).not.toHaveBeenCalled();
    expect(fixture.transactions.run).not.toHaveBeenCalled();
  });

  it("coalesces authorized overlapping runs and clears the guard after completion", async () => {
    let releaseFirstRead!: (value: readonly Record<string, unknown>[]) => void;
    const firstRead = new Promise<readonly Record<string, unknown>[]>((resolve) => {
      releaseFirstRead = resolve;
    });
    const fixture = setup();
    fixture.importQuery.exec.mockReturnValueOnce(firstRead);

    const first = fixture.service.runBounded(context());
    const second = fixture.service.runBounded(context());
    await vi.waitFor(() => expect(fixture.importBatchModel.find).toHaveBeenCalledOnce());
    releaseFirstRead([]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        importCandidatesScanned: 0,
        importBatchesPurged: 0,
        invitationCandidatesScanned: 0,
        invitationsPurged: 0,
      },
      {
        importCandidatesScanned: 0,
        importBatchesPurged: 0,
        invitationCandidatesScanned: 0,
        invitationsPurged: 0,
      },
    ]);
    expect(fixture.authorization.assertCapability).toHaveBeenCalledTimes(2);
    expect(fixture.importBatchModel.find).toHaveBeenCalledOnce();
    expect(fixture.invitationModel.find).toHaveBeenCalledOnce();

    await fixture.service.runBounded(context());
    expect(fixture.importBatchModel.find).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded candidate limits", () => {
    expect(
      () => new AlumniRetentionCleanupService({ maxCandidatesPerKind: 0 }),
    ).toThrow("maxCandidatesPerKind");
    expect(
      () => new AlumniRetentionCleanupService({ maxCandidatesPerKind: 501 }),
    ).toThrow("maxCandidatesPerKind");
  });
});
