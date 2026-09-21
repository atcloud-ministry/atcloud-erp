import { randomUUID } from "crypto";
import type { Collection, Document as MongoDocument } from "mongodb";
import type { ClientSession, Connection } from "mongoose";
import {
  MIGRATION_GLOBAL_LOCK_ID,
  MIGRATION_LEASE_COLLECTION_NAME,
} from "../../migrations/constants";
import { MIGRATION_ID_PATTERN } from "../../migrations/types";

export const SCHEMA_MIGRATION_LOCK_COLLECTION =
  MIGRATION_LEASE_COLLECTION_NAME;
export const GLOBAL_SCHEMA_MIGRATION_LOCK_ID = MIGRATION_GLOBAL_LOCK_ID;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

interface MigrationLeaseDocument {
  readonly _id: string;
  readonly owner: string;
  readonly runId: string;
  readonly token: string;
  readonly acquiredAt: Date;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
  readonly currentMigrationId?: string | null;
  readonly fence: number;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly releasedAt?: Date | null;
}

/**
 * An immutable snapshot of a lease. Identity is the owner/runId/token tuple;
 * expiry and revision are refreshed by operations that return a new handle.
 */
export interface MigrationLeaseHandle {
  readonly lockId: typeof GLOBAL_SCHEMA_MIGRATION_LOCK_ID;
  readonly owner: string;
  readonly runId: string;
  readonly token: string;
  readonly acquiredAt: Date;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
  readonly currentMigrationId: string | null;
  readonly fence: number;
  readonly revision: number;
}

export interface MigrationLeaseServiceOptions {
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly createToken?: () => string;
}

export interface AcquireMigrationLeaseInput {
  readonly runId: string;
  readonly currentMigrationId?: string | null;
}

abstract class MigrationLeaseError extends Error {
  abstract readonly code: string;
  declare readonly cause: unknown;

  protected constructor(message: string, cause?: unknown) {
    super(message);
    Object.defineProperty(this, "cause", {
      value: cause,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

export class MigrationLeaseContentionError extends MigrationLeaseError {
  readonly name = "MigrationLeaseContentionError";
  readonly code = "MIGRATION_LEASE_CONTENDED";

  constructor(cause?: unknown) {
    super("The global schema migration lease is already held.", cause);
  }
}

export class MigrationLeaseLostError extends MigrationLeaseError {
  readonly name = "MigrationLeaseLostError";
  readonly code = "MIGRATION_LEASE_LOST";

  constructor(cause?: unknown) {
    super("The global schema migration lease is no longer held.", cause);
  }
}

export class MigrationLeaseUsageError extends MigrationLeaseError {
  readonly name = "MigrationLeaseUsageError";
  readonly code = "MIGRATION_LEASE_USAGE_ERROR";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

function requireIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new MigrationLeaseUsageError(`Invalid migration lease ${name}.`);
  }
  return value;
}

function requireUuid(value: unknown, name: "runId" | "token"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new MigrationLeaseUsageError(`Invalid migration lease ${name}.`);
  }
  return value;
}

function requireMigrationId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !MIGRATION_ID_PATTERN.test(value)) {
    throw new MigrationLeaseUsageError(
      "Invalid migration lease currentMigrationId.",
    );
  }
  return value;
}

function requireLeaseDuration(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_LEASE_DURATION_MS
  ) {
    throw new MigrationLeaseUsageError(
      `Migration lease duration must be an integer between 1 and ${MAX_LEASE_DURATION_MS} milliseconds.`,
    );
  }
  return Number(value);
}

function requireActiveSession(session: ClientSession | undefined):
  | ClientSession
  | undefined {
  if (session === undefined) return undefined;
  if (
    !session ||
    typeof session !== "object" ||
    typeof session.inTransaction !== "function" ||
    !session.inTransaction()
  ) {
    throw new MigrationLeaseUsageError(
      "Migration lease fencing requires an active ClientSession transaction.",
    );
  }
  return session;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 11_000 || code === 11_001;
}

function readDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MigrationLeaseLostError();
  }
  return new Date(value.getTime());
}

function readCounter(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new MigrationLeaseLostError();
  }
  return Number(value);
}

function toHandle(document: unknown): MigrationLeaseHandle {
  if (!document || typeof document !== "object") {
    throw new MigrationLeaseLostError();
  }
  const candidate = document as Partial<MigrationLeaseDocument>;
  if (candidate._id !== GLOBAL_SCHEMA_MIGRATION_LOCK_ID) {
    throw new MigrationLeaseLostError();
  }

  const handle: MigrationLeaseHandle = {
    lockId: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
    owner: requireIdentifier(candidate.owner, "owner"),
    runId: requireUuid(candidate.runId, "runId"),
    token: requireUuid(candidate.token, "token"),
    acquiredAt: readDate(candidate.acquiredAt),
    heartbeatAt: readDate(candidate.heartbeatAt),
    expiresAt: readDate(candidate.expiresAt),
    currentMigrationId: requireMigrationId(candidate.currentMigrationId),
    fence: readCounter(candidate.fence),
    revision: readCounter(candidate.revision),
  };
  return Object.freeze(handle);
}

/**
 * A MongoDB-backed global lease for schema migrations.
 *
 * The fixed `_id` is the uniqueness constraint. Acquisition first attempts a
 * server-time expired-lease takeover and then a fixed-id upsert for an absent
 * lock; an E11000 race is mapped to sanitized contention. `assertHeld()` is a
 * fenced write, so calling it inside the same transaction as a migration batch
 * makes lease takeover conflict with that transaction.
 */
export class MigrationLeaseService {
  private readonly owner: string;
  private readonly leaseDurationMs: number;
  private readonly createToken: () => string;
  private readonly collection: Collection<MigrationLeaseDocument>;

  constructor(
    connection: Connection,
    options: MigrationLeaseServiceOptions,
  ) {
    if (!connection || !connection.db) {
      throw new MigrationLeaseUsageError(
        "MongoDB connection is not ready for migration leases.",
      );
    }
    if (!options || typeof options !== "object") {
      throw new MigrationLeaseUsageError(
        "Migration lease options are required.",
      );
    }

    this.owner = requireIdentifier(options.owner, "owner");
    this.leaseDurationMs = requireLeaseDuration(options.leaseDurationMs);
    this.createToken = options.createToken ?? randomUUID;
    this.collection = connection.db.collection<MigrationLeaseDocument>(
      SCHEMA_MIGRATION_LOCK_COLLECTION,
    );
  }

  async acquire(
    input: AcquireMigrationLeaseInput,
  ): Promise<MigrationLeaseHandle> {
    if (!input || typeof input !== "object") {
      throw new MigrationLeaseUsageError(
        "Migration lease acquire input is required.",
      );
    }
    const runId = requireUuid(input.runId, "runId");
    const currentMigrationId = requireMigrationId(input.currentMigrationId);
    const token = requireUuid(this.createToken(), "token");
    const update = this.acquireUpdatePipeline(runId, token, currentMigrationId);

    let document: unknown;
    try {
      // `$expr` cannot be combined with an upsert. First attempt an atomic
      // server-time takeover, then use the fixed `_id` to race safely for an
      // absent lock document. A competing/live lock turns the second upsert
      // into E11000 and is reported as contention without exposing its owner.
      document = await this.collection.findOneAndUpdate(
        {
          _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
          $expr: { $lte: ["$expiresAt", "$$NOW"] },
        },
        update,
        {
          returnDocument: "after",
          writeConcern: { w: "majority" },
        },
      );
      if (!document) {
        document = await this.collection.findOneAndUpdate(
          {
            _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
            expiresAt: { $exists: false },
          },
          update,
          {
            upsert: true,
            returnDocument: "after",
            writeConcern: { w: "majority" },
          },
        );
      }
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new MigrationLeaseContentionError(error);
      }
      throw error;
    }

    if (!document) throw new MigrationLeaseContentionError();
    const handle = toHandle(document);
    if (
      handle.owner !== this.owner ||
      handle.runId !== runId ||
      handle.token !== token
    ) {
      throw new MigrationLeaseLostError();
    }
    return handle;
  }

  async renew(handleInput: MigrationLeaseHandle): Promise<MigrationLeaseHandle> {
    const handle = this.requireOwnedHandle(handleInput);

    const document = await this.collection.findOneAndUpdate(
      this.activeLeaseFilter(handle),
      [
        {
          $set: {
            heartbeatAt: "$$NOW",
            expiresAt: this.serverExpiryExpression(),
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
    if (!document) throw new MigrationLeaseLostError();
    return this.requireReturnedIdentity(toHandle(document), handle, {
      revision: handle.revision + 1,
      currentMigrationId: handle.currentMigrationId,
    });
  }

  async assertHeld(
    handleInput: MigrationLeaseHandle,
    sessionInput?: ClientSession,
  ): Promise<MigrationLeaseHandle> {
    const handle = this.requireOwnedHandle(handleInput);
    const session = requireActiveSession(sessionInput);

    const document = await this.collection.findOneAndUpdate(
      this.activeLeaseFilter(handle),
      [
        {
          $set: {
            heartbeatAt: "$$NOW",
            updatedAt: "$$NOW",
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      {
        returnDocument: "after",
        ...(session
          ? { session }
          : { writeConcern: { w: "majority" as const } }),
      },
    );
    if (!document) throw new MigrationLeaseLostError();
    return this.requireReturnedIdentity(toHandle(document), handle, {
      revision: handle.revision + 1,
      currentMigrationId: handle.currentMigrationId,
    });
  }

  /**
   * Reconciles a handle after an uncertain transaction commit. This is a
   * majority read only: it neither extends the lease nor advances revision.
   */
  async refreshOwned(
    handleInput: MigrationLeaseHandle,
  ): Promise<MigrationLeaseHandle> {
    const handle = this.requireOwnedHandle(handleInput);
    const document = await this.collection.findOne(
      this.activeLeaseIdentityFilter(handle),
      { readConcern: { level: "majority" } },
    );
    if (!document) throw new MigrationLeaseLostError();

    const returned = toHandle(document);
    if (
      returned.owner !== handle.owner ||
      returned.runId !== handle.runId ||
      returned.token !== handle.token ||
      returned.fence !== handle.fence ||
      (handle.currentMigrationId !== null &&
        returned.currentMigrationId !== handle.currentMigrationId) ||
      returned.revision < handle.revision
    ) {
      throw new MigrationLeaseLostError();
    }
    return returned;
  }

  async updateCurrentMigration(
    handleInput: MigrationLeaseHandle,
    currentMigrationIdInput: string | null,
    sessionInput?: ClientSession,
  ): Promise<MigrationLeaseHandle> {
    const handle = this.requireOwnedHandle(handleInput);
    const currentMigrationId = requireMigrationId(currentMigrationIdInput);
    const session = requireActiveSession(sessionInput);

    const document = await this.collection.findOneAndUpdate(
      this.activeLeaseFilter(handle),
      [
        {
          $set: {
            currentMigrationId: { $literal: currentMigrationId },
            heartbeatAt: "$$NOW",
            updatedAt: "$$NOW",
            revision: { $add: ["$revision", 1] },
          },
        },
      ],
      {
        returnDocument: "after",
        ...(session
          ? { session }
          : { writeConcern: { w: "majority" as const } }),
      },
    );
    if (!document) throw new MigrationLeaseLostError();
    return this.requireReturnedIdentity(toHandle(document), handle, {
      revision: handle.revision + 1,
      currentMigrationId,
    });
  }

  async release(
    handleInput: MigrationLeaseHandle,
    sessionInput?: ClientSession,
  ): Promise<void> {
    const handle = this.requireOwnedHandle(handleInput);
    const session = requireActiveSession(sessionInput);
    const result = await this.collection.updateOne(
      this.activeLeaseFilter(handle),
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
      session
        ? { session }
        : { writeConcern: { w: "majority" as const } },
    );
    if (result.matchedCount !== 1) throw new MigrationLeaseLostError();
  }

  private requireOwnedHandle(
    handle: MigrationLeaseHandle,
  ): MigrationLeaseHandle {
    if (!handle || typeof handle !== "object") {
      throw new MigrationLeaseUsageError(
        "A migration lease handle is required.",
      );
    }
    if (handle.lockId !== GLOBAL_SCHEMA_MIGRATION_LOCK_ID) {
      throw new MigrationLeaseUsageError("Invalid migration lease lockId.");
    }
    const owner = requireIdentifier(handle.owner, "owner");
    if (owner !== this.owner) {
      throw new MigrationLeaseUsageError(
        "Migration lease handle belongs to a different owner.",
      );
    }
    requireUuid(handle.runId, "runId");
    requireUuid(handle.token, "token");
    readDate(handle.acquiredAt);
    readDate(handle.heartbeatAt);
    readDate(handle.expiresAt);
    requireMigrationId(handle.currentMigrationId);
    readCounter(handle.fence);
    readCounter(handle.revision);
    return handle;
  }

  private activeLeaseFilter(
    handle: MigrationLeaseHandle,
  ): Readonly<Record<string, unknown>> {
    return {
      ...this.activeLeaseIdentityFilter(handle),
      revision: handle.revision,
    };
  }

  private activeLeaseIdentityFilter(
    handle: MigrationLeaseHandle,
  ): Readonly<Record<string, unknown>> {
    return {
      _id: GLOBAL_SCHEMA_MIGRATION_LOCK_ID,
      owner: handle.owner,
      runId: handle.runId,
      token: handle.token,
      fence: handle.fence,
      ...(handle.currentMigrationId
        ? { currentMigrationId: handle.currentMigrationId }
        : {}),
      $expr: { $gt: ["$expiresAt", "$$NOW"] },
    };
  }

  private serverExpiryExpression(): Readonly<Record<string, unknown>> {
    return {
      $dateAdd: {
        startDate: "$$NOW",
        unit: "millisecond",
        amount: this.leaseDurationMs,
      },
    };
  }

  private acquireUpdatePipeline(
    runId: string,
    token: string,
    currentMigrationId: string | null,
  ): MongoDocument[] {
    return [
      {
        $set: {
          owner: { $literal: this.owner },
          runId: { $literal: runId },
          token: { $literal: token },
          acquiredAt: "$$NOW",
          heartbeatAt: "$$NOW",
          expiresAt: this.serverExpiryExpression(),
          currentMigrationId: { $literal: currentMigrationId },
          createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
          updatedAt: "$$NOW",
          releasedAt: "$$REMOVE",
          fence: { $add: [{ $ifNull: ["$fence", 0] }, 1] },
          revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] },
        },
      },
    ];
  }

  private requireReturnedIdentity(
    returned: MigrationLeaseHandle,
    expected: MigrationLeaseHandle,
    expectedState: {
      readonly revision: number;
      readonly currentMigrationId: string | null;
    },
  ): MigrationLeaseHandle {
    if (
      returned.owner !== expected.owner ||
      returned.runId !== expected.runId ||
      returned.token !== expected.token ||
      returned.fence !== expected.fence ||
      returned.revision !== expectedState.revision ||
      returned.currentMigrationId !== expectedState.currentMigrationId
    ) {
      throw new MigrationLeaseLostError();
    }
    return returned;
  }
}
