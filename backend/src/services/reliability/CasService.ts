import type {
  ClientSession,
  FilterQuery,
  HydratedDocument,
  Model,
} from "mongoose";

export interface RevisionedEntity {
  readonly _id: unknown;
  revision: number;
}

export type CasUpdateDocument = Readonly<Record<string, unknown>>;

export interface CasUpdateInput<TDocument extends RevisionedEntity> {
  readonly model: Model<TDocument>;
  readonly id: unknown;
  readonly expectedRevision: number;
  readonly update: CasUpdateDocument;
  readonly additionalFilter?: FilterQuery<TDocument>;
  /** Pass the active transaction session, or explicitly pass null for atomic single-document use. */
  readonly session: ClientSession | null;
}

export type CasConflictReason = "revision_mismatch" | "guard_failed";

abstract class CasError extends Error {
  abstract readonly code: string;
}

export class CasValidationError extends CasError {
  readonly name = "CasValidationError";
  readonly code = "CAS_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
  }
}

export class CasNotFoundError extends CasError {
  readonly name = "CasNotFoundError";
  readonly code = "CAS_RESOURCE_NOT_FOUND";

  constructor(public readonly resourceId: string) {
    super(`CAS resource was not found: ${resourceId}`);
  }
}

export class CasConflictError extends CasError {
  readonly name = "CasConflictError";
  readonly code = "CAS_CONFLICT";

  constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
    public readonly reason: CasConflictReason,
  ) {
    super(
      reason === "revision_mismatch"
        ? `CAS revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}.`
        : `CAS guard rejected the update at revision ${expectedRevision}.`,
    );
  }
}

const ALLOWED_UPDATE_OPERATORS = new Set([
  "$addToSet",
  "$bit",
  "$currentDate",
  "$inc",
  "$max",
  "$min",
  "$mul",
  "$pop",
  "$pull",
  "$pullAll",
  "$push",
  "$rename",
  "$set",
  "$unset",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProtectedPath(path: string): boolean {
  return (
    path === "_id" ||
    path.startsWith("_id.") ||
    path === "revision" ||
    path.startsWith("revision.")
  );
}

function assertMutablePaths(
  operator: string,
  updatePayload: Record<string, unknown>,
): void {
  for (const [path, value] of Object.entries(updatePayload)) {
    if (isProtectedPath(path)) {
      throw new CasValidationError(
        `CAS callers cannot modify protected field "${path}".`,
      );
    }
    if (
      operator === "$rename" &&
      typeof value === "string" &&
      isProtectedPath(value)
    ) {
      throw new CasValidationError(
        `CAS callers cannot rename a field to protected field "${value}".`,
      );
    }
  }
}

export function buildRevisionFencedUpdate(
  requestedUpdate: CasUpdateDocument,
): Record<string, unknown> {
  if (!isPlainRecord(requestedUpdate)) {
    throw new CasValidationError("CAS update must be a plain object.");
  }

  const entries = Object.entries(requestedUpdate);
  if (entries.length === 0) {
    throw new CasValidationError("CAS update cannot be empty.");
  }

  const operatorEntryCount = entries.filter(([key]) => key.startsWith("$")).length;
  if (operatorEntryCount !== 0 && operatorEntryCount !== entries.length) {
    throw new CasValidationError(
      "CAS update cannot mix update operators with direct field assignments.",
    );
  }

  if (operatorEntryCount === 0) {
    assertMutablePaths("$set", requestedUpdate);
    return {
      $set: { ...requestedUpdate },
      $inc: { revision: 1 },
    };
  }

  const update: Record<string, unknown> = {};
  for (const [operator, value] of entries) {
    if (!ALLOWED_UPDATE_OPERATORS.has(operator)) {
      throw new CasValidationError(
        `CAS update operator "${operator}" is not allowed.`,
      );
    }
    if (!isPlainRecord(value)) {
      throw new CasValidationError(
        `CAS update operator "${operator}" requires an object value.`,
      );
    }
    assertMutablePaths(operator, value);
    update[operator] = { ...value };
  }

  const increments = update.$inc;
  update.$inc = {
    ...(isPlainRecord(increments) ? increments : {}),
    revision: 1,
  };
  return update;
}

function requireExpectedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CasValidationError(
      "expectedRevision must be a non-negative safe integer.",
    );
  }
  return value;
}

function requireResourceId(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    throw new CasValidationError("CAS resource id is required.");
  }
  return value;
}

function requireExplicitSession(
  input: { readonly session: ClientSession | null },
): ClientSession | null {
  if (!Object.prototype.hasOwnProperty.call(input, "session")) {
    throw new CasValidationError(
      "CAS callers must explicitly provide an active transaction session or null.",
    );
  }

  const session = (input as { readonly session: unknown }).session;
  if (session === null) return null;

  try {
    if (
      session &&
      typeof session === "object" &&
      typeof (session as { inTransaction?: unknown }).inTransaction ===
        "function" &&
      (session as ClientSession).inTransaction()
    ) {
      return session as ClientSession;
    }
  } catch {
    // Convert invalid/hostile session implementations to the stable CAS error.
  }

  throw new CasValidationError(
    "CAS session must be null or an active MongoDB transaction session.",
  );
}

export class CasService {
  static async update<TDocument extends RevisionedEntity>(
    input: CasUpdateInput<TDocument>,
  ): Promise<HydratedDocument<TDocument>> {
    const id = requireResourceId(input.id);
    const expectedRevision = requireExpectedRevision(input.expectedRevision);
    const session = requireExplicitSession(input);
    const update = buildRevisionFencedUpdate(input.update);
    const revisionFilter = {
      _id: id,
      revision: expectedRevision,
    } as FilterQuery<TDocument>;
    const filter = input.additionalFilter
      ? ({ $and: [input.additionalFilter, revisionFilter] } as FilterQuery<TDocument>)
      : revisionFilter;
    const updated = await input.model.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
      ...(session ? { session } : {}),
    });
    if (updated) return updated;

    const current = await input.model.findOne(
      { _id: id } as FilterQuery<TDocument>,
      { revision: 1 },
      session ? { session } : undefined,
    );
    if (!current) throw new CasNotFoundError(String(id));

    const actualRevision = Number(current.revision);
    if (!Number.isSafeInteger(actualRevision) || actualRevision < 0) {
      throw new CasValidationError(
        `Stored CAS revision is invalid for resource ${String(id)}.`,
      );
    }

    throw new CasConflictError(
      expectedRevision,
      actualRevision,
      actualRevision === expectedRevision
        ? "guard_failed"
        : "revision_mismatch",
    );
  }
}
