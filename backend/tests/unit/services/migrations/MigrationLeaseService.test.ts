import type { ClientSession, Connection } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
  MigrationLeaseContentionError,
  MigrationLeaseLostError,
  MigrationLeaseService,
  MigrationLeaseUsageError,
  SCHEMA_MIGRATION_LOCK_COLLECTION,
  type MigrationLeaseHandle,
} from "../../../../src/services/migrations/MigrationLeaseService";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-09T12:01:00.000Z");
const TOKEN = "11111111-1111-4111-8111-111111111111";
const OTHER_TOKEN = "22222222-2222-4222-8222-222222222222";
const OWNER = "render:migration-worker-1";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const MIGRATION_ID = "20260909_001_fixture";

function serverExpiryExpression() {
  return {
    $dateAdd: {
      startDate: "$$NOW",
      unit: "millisecond",
      amount: 60_000,
    },
  };
}

function acquirePipeline() {
  return [
    {
      $set: {
        owner: { $literal: OWNER },
        runId: { $literal: RUN_ID },
        token: { $literal: TOKEN },
        acquiredAt: "$$NOW",
        heartbeatAt: "$$NOW",
        expiresAt: serverExpiryExpression(),
        currentMigrationId: { $literal: null },
        createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
        updatedAt: "$$NOW",
        releasedAt: "$$REMOVE",
        fence: { $add: [{ $ifNull: ["$fence", 0] }, 1] },
        revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
      },
    },
  ];
}

function activeFilter(currentMigrationId: string | null = null) {
  return {
    _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
    owner: OWNER,
    runId: RUN_ID,
    token: TOKEN,
    fence: 1,
    revision: 1,
    ...(currentMigrationId ? { currentMigrationId } : {}),
    $expr: { $gt: ["$expiresAt", "$$NOW"] },
  };
}

function activeIdentityFilter(currentMigrationId: string | null = null) {
  return {
    _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
    owner: OWNER,
    runId: RUN_ID,
    token: TOKEN,
    fence: 1,
    ...(currentMigrationId ? { currentMigrationId } : {}),
    $expr: { $gt: ["$expiresAt", "$$NOW"] },
  };
}

interface CollectionDouble {
  readonly findOne: ReturnType<typeof vi.fn>;
  readonly findOneAndUpdate: ReturnType<typeof vi.fn>;
  readonly updateOne: ReturnType<typeof vi.fn>;
}

function leaseDocument(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
    owner: OWNER,
    runId: RUN_ID,
    token: TOKEN,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: EXPIRES_AT,
    currentMigrationId: null,
    fence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function leaseHandle(
  overrides: Partial<MigrationLeaseHandle> = {},
): MigrationLeaseHandle {
  return {
    lockId: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
    owner: OWNER,
    runId: RUN_ID,
    token: TOKEN,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: EXPIRES_AT,
    currentMigrationId: null,
    fence: 1,
    revision: 1,
    ...overrides,
  };
}

function createConnection() {
  const collection: CollectionDouble = {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  };
  const rawCollection = vi.fn(() => collection);
  const connection = {
    db: { collection: rawCollection },
  } as unknown as Connection;
  return { collection, connection, rawCollection };
}

function activeSession(active = true): ClientSession {
  return {
    inTransaction: vi.fn(() => active),
  } as unknown as ClientSession;
}

describe("MigrationLeaseService", () => {
  let collection: CollectionDouble;
  let connection: Connection;
  let rawCollection: ReturnType<typeof vi.fn>;
  let service: MigrationLeaseService;

  beforeEach(() => {
    ({ collection, connection, rawCollection } = createConnection());
    service = new MigrationLeaseService(connection, {
      owner: OWNER,
      leaseDurationMs: 60_000,
      createToken: () => TOKEN,
    });
  });

  it("uses MongoDB server time to atomically take over an expired lock", async () => {
    collection.findOneAndUpdate.mockResolvedValue(leaseDocument());

    const handle = await service.acquire({ runId: RUN_ID });

    expect(rawCollection).toHaveBeenCalledWith(
      SCHEMA_MIGRATION_LOCK_COLLECTION,
    );
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
        $expr: { $lte: ["$expiresAt", "$$NOW"] },
      },
      acquirePipeline(),
      {
        returnDocument: "after",
        writeConcern: { w: "majority" },
      },
    );
    expect(handle).toMatchObject({
      lockId: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
      owner: OWNER,
      runId: RUN_ID,
      token: TOKEN,
      expiresAt: EXPIRES_AT,
      currentMigrationId: null,
      fence: 1,
      revision: 1,
    });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle).not.toHaveProperty("uri");
  });

  it("falls back to a fixed-id upsert only when no expirable lock exists", async () => {
    collection.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(leaseDocument());

    await expect(service.acquire({ runId: RUN_ID })).resolves.toMatchObject({
      runId: RUN_ID,
      token: TOKEN,
    });

    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
        expiresAt: { $exists: false },
      },
      acquirePipeline(),
      {
        upsert: true,
        returnDocument: "after",
        writeConcern: { w: "majority" },
      },
    );
  });

  it("maps the fixed _id duplicate-key race to a sanitized contention error", async () => {
    const cause = Object.assign(
      new Error("mongodb://private-user:private-password@cluster"),
      { code: 11_000 },
    );
    collection.findOneAndUpdate.mockRejectedValue(cause);

    const error = await service.acquire({ runId: RUN_ID }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(MigrationLeaseContentionError);
    expect(error).toMatchObject({
      code: "MIGRATION_LEASE_CONTENDED",
      cause,
    });
    expect(Object.prototype.propertyIsEnumerable.call(error, "cause")).toBe(
      false,
    );
    expect(JSON.stringify(error)).not.toContain("private-password");
    expect((error as Error).message).not.toContain("mongodb://");
  });

  it("does not misclassify non-duplicate database failures as contention", async () => {
    const failure = Object.assign(new Error("primary unavailable"), {
      code: 91,
    });
    collection.findOneAndUpdate.mockRejectedValue(failure);

    await expect(service.acquire({ runId: RUN_ID })).rejects.toBe(failure);
  });

  it("renews only the exact active lease identity using MongoDB server time", async () => {
    const laterExpiry = new Date("2026-09-09T12:02:00.000Z");
    collection.findOneAndUpdate.mockResolvedValue(
      leaseDocument({
        heartbeatAt: NOW,
        expiresAt: laterExpiry,
        revision: 2,
      }),
    );

    const renewed = await service.renew(leaseHandle());

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      activeFilter(),
      [
        {
          $set: {
            heartbeatAt: "$$NOW",
            expiresAt: serverExpiryExpression(),
            updatedAt: "$$NOW",
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      {
        returnDocument: "after",
        writeConcern: { w: "majority" },
      },
    );
    expect(renewed.expiresAt).toEqual(laterExpiry);
    expect(renewed.token).toBe(TOKEN);
    expect(renewed.revision).toBe(2);
  });

  it("turns assertHeld into a lock-document write inside the supplied transaction", async () => {
    const session = activeSession();
    collection.findOneAndUpdate.mockResolvedValue(
      leaseDocument({ revision: 2 }),
    );

    const asserted = await service.assertHeld(leaseHandle(), session);

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      activeFilter(),
      [
        {
          $set: {
            heartbeatAt: "$$NOW",
            updatedAt: "$$NOW",
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      { returnDocument: "after", session },
    );
    expect(asserted.revision).toBe(2);
  });

  it("refreshes an owned active lease after uncertain commit without extending it", async () => {
    const refreshedDocument = leaseDocument({
      currentMigrationId: MIGRATION_ID,
      revision: 4,
    });
    collection.findOne.mockResolvedValue(refreshedDocument);
    const staleHandle = leaseHandle({
      currentMigrationId: MIGRATION_ID,
      revision: 2,
    });

    const refreshed = await service.refreshOwned(staleHandle);

    expect(collection.findOne).toHaveBeenCalledWith(
      activeIdentityFilter(MIGRATION_ID),
      { readConcern: { level: "majority" } },
    );
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(refreshed).toMatchObject({
      owner: OWNER,
      runId: RUN_ID,
      token: TOKEN,
      fence: 1,
      currentMigrationId: MIGRATION_ID,
      revision: 4,
      heartbeatAt: NOW,
      expiresAt: EXPIRES_AT,
    });
  });

  it("allows the initial unpinned handle to discover the current migration", async () => {
    collection.findOne.mockResolvedValue(
      leaseDocument({ currentMigrationId: MIGRATION_ID, revision: 3 }),
    );

    await expect(service.refreshOwned(leaseHandle())).resolves.toMatchObject({
      currentMigrationId: MIGRATION_ID,
      revision: 3,
    });
    expect(collection.findOne).toHaveBeenCalledWith(activeIdentityFilter(), {
      readConcern: { level: "majority" },
    });
  });

  it("rejects refresh when identity, fence, current migration, expiry, or revision no longer matches", async () => {
    collection.findOne.mockResolvedValue(null);
    const handle = leaseHandle({ currentMigrationId: MIGRATION_ID });

    await expect(service.refreshOwned(handle)).rejects.toBeInstanceOf(
      MigrationLeaseLostError,
    );
    expect(collection.findOne).toHaveBeenCalledWith(
      activeIdentityFilter(MIGRATION_ID),
      { readConcern: { level: "majority" } },
    );

    collection.findOne.mockResolvedValueOnce(
      leaseDocument({ currentMigrationId: MIGRATION_ID, revision: 0 }),
    );
    await expect(service.refreshOwned(handle)).rejects.toBeInstanceOf(
      MigrationLeaseLostError,
    );
  });

  it("rejects a non-transactional session because it cannot provide batch fencing", async () => {
    await expect(
      service.assertHeld(leaseHandle(), activeSession(false)),
    ).rejects.toBeInstanceOf(MigrationLeaseUsageError);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("updates currentMigrationId only while the same active lease is held", async () => {
    const session = activeSession();
    collection.findOneAndUpdate.mockResolvedValue(
      leaseDocument({ currentMigrationId: MIGRATION_ID, revision: 2 }),
    );

    const updated = await service.updateCurrentMigration(
      leaseHandle(),
      MIGRATION_ID,
      session,
    );

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      activeFilter(),
      [
        {
          $set: {
            currentMigrationId: { $literal: MIGRATION_ID },
            heartbeatAt: "$$NOW",
            updatedAt: "$$NOW",
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      { returnDocument: "after", session },
    );
    expect(updated.currentMigrationId).toBe(MIGRATION_ID);
  });

  it("releases only the active owner/runId/token tuple and preserves the fencing counter", async () => {
    collection.updateOne.mockResolvedValue({ matchedCount: 1 });

    await expect(service.release(leaseHandle())).resolves.toBeUndefined();

    expect(collection.updateOne).toHaveBeenCalledWith(
      activeFilter(),
      [
        {
          $set: {
            expiresAt: "$$NOW",
            heartbeatAt: "$$NOW",
            releasedAt: "$$NOW",
            updatedAt: "$$NOW",
            owner: "$$REMOVE",
            runId: "$$REMOVE",
            token: "$$REMOVE",
            currentMigrationId: "$$REMOVE",
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      { writeConcern: { w: "majority" } },
    );
    expect(collection).not.toHaveProperty("deleteOne");
  });

  it.each([
    ["renew", (candidate: MigrationLeaseService) => candidate.renew(leaseHandle())],
    [
      "assert",
      (candidate: MigrationLeaseService) => candidate.assertHeld(leaseHandle()),
    ],
    [
      "update",
      (candidate: MigrationLeaseService) =>
        candidate.updateCurrentMigration(leaseHandle(), MIGRATION_ID),
    ],
  ])("reports a lost lease when %s no longer matches", async (_name, run) => {
    collection.findOneAndUpdate.mockResolvedValue(null);

    await expect(run(service)).rejects.toBeInstanceOf(MigrationLeaseLostError);
  });

  it("reports a lost lease when release no longer matches", async () => {
    collection.updateOne.mockResolvedValue({ matchedCount: 0 });

    await expect(service.release(leaseHandle())).rejects.toBeInstanceOf(
      MigrationLeaseLostError,
    );
  });

  it("validates configuration and identifiers before touching MongoDB", async () => {
    const disconnected = { db: undefined } as unknown as Connection;
    expect(
      () =>
        new MigrationLeaseService(disconnected, {
          owner: OWNER,
          leaseDurationMs: 60_000,
        }),
    ).toThrow(MigrationLeaseUsageError);
    expect(
      () =>
        new MigrationLeaseService(connection, {
          owner: "owner with spaces",
          leaseDurationMs: 60_000,
        }),
    ).toThrow(MigrationLeaseUsageError);
    expect(
      () =>
        new MigrationLeaseService(connection, {
          owner: OWNER,
          leaseDurationMs: 0,
        }),
    ).toThrow(MigrationLeaseUsageError);

    await expect(
      service.acquire({ runId: "run with spaces" }),
    ).rejects.toBeInstanceOf(MigrationLeaseUsageError);
    await expect(
      service.updateCurrentMigration(leaseHandle(), "not-a-version"),
    ).rejects.toBeInstanceOf(MigrationLeaseUsageError);
    await expect(
      service.renew(leaseHandle({ token: OTHER_TOKEN.slice(0, -1) })),
    ).rejects.toBeInstanceOf(MigrationLeaseUsageError);
    await expect(
      service.renew(leaseHandle({ owner: "other-owner" })),
    ).rejects.toBeInstanceOf(MigrationLeaseUsageError);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("validates the generated token before attempting acquisition", async () => {
    const invalidTokenService = new MigrationLeaseService(connection, {
      owner: OWNER,
      leaseDurationMs: 60_000,
      createToken: () => "not-a-token",
    });
    await expect(
      invalidTokenService.acquire({ runId: RUN_ID }),
    ).rejects.toBeInstanceOf(MigrationLeaseUsageError);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

});
