import crypto from "crypto";
import mongoose from "mongoose";
import RefreshSession, {
  type RefreshSessionRevocationReason,
} from "../../models/RefreshSession";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RefreshSessionClaims {
  readonly userId?: unknown;
  readonly sid?: unknown;
  readonly jti?: unknown;
}

export interface RefreshSessionIdentity {
  readonly familyId: string;
  readonly tokenId: string;
}

export interface RefreshSessionRotationResult {
  readonly expiresAt: Date;
  readonly lifetimeMs: number;
}

export class RefreshSessionRejectedError extends Error {
  readonly code: "invalid_session" | "token_reuse";

  constructor(code: "invalid_session" | "token_reuse") {
    super("Refresh session rejected.");
    this.name = "RefreshSessionRejectedError";
    this.code = code;
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RefreshSessionRejectedError("invalid_session");
  }
  return value.toLowerCase();
}

function requireUserId(value: unknown): string {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw new RefreshSessionRejectedError("invalid_session");
  }
  return value;
}

function hashTokenId(tokenId: string): string {
  return crypto.createHash("sha256").update(tokenId, "utf8").digest("hex");
}

function requireFutureDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RefreshSessionRejectedError("invalid_session");
  }
  if (value.getTime() <= Date.now()) {
    throw new RefreshSessionRejectedError("invalid_session");
  }
  return value;
}

function requireLifetimeMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new RefreshSessionRejectedError("invalid_session");
  }
  return value;
}

export class RefreshSessionService {
  static createIdentity(): RefreshSessionIdentity {
    return Object.freeze({
      familyId: crypto.randomUUID(),
      tokenId: crypto.randomUUID(),
    });
  }

  static createRotationIdentity(familyId: unknown): RefreshSessionIdentity {
    return Object.freeze({
      familyId: requireUuid(familyId),
      tokenId: crypto.randomUUID(),
    });
  }

  static async register(input: {
    readonly userId: string;
    readonly identity: RefreshSessionIdentity;
    readonly expiresAt: Date;
    readonly refreshLifetimeMs: number;
  }): Promise<void> {
    const userId = requireUserId(input.userId);
    const familyId = requireUuid(input.identity.familyId);
    const tokenId = requireUuid(input.identity.tokenId);
    const expiresAt = requireFutureDate(input.expiresAt);
    const refreshLifetimeMs = requireLifetimeMs(input.refreshLifetimeMs);

    await RefreshSession.create({
      familyId,
      userId,
      currentJtiHash: hashTokenId(tokenId),
      refreshLifetimeMs,
      expiresAt,
    });
  }

  static async rotate(input: {
    readonly claims: RefreshSessionClaims;
    readonly nextIdentity: RefreshSessionIdentity;
    readonly nextExpiresAt: Date;
  }): Promise<RefreshSessionRotationResult> {
    const userId = requireUserId(input.claims.userId);
    const familyId = requireUuid(input.claims.sid);
    const currentTokenId = requireUuid(input.claims.jti);
    if (requireUuid(input.nextIdentity.familyId) !== familyId) {
      throw new RefreshSessionRejectedError("invalid_session");
    }
    const nextTokenId = requireUuid(input.nextIdentity.tokenId);
    const nextExpiresAt = requireFutureDate(input.nextExpiresAt);
    const now = new Date();
    const currentJtiHash = hashTokenId(currentTokenId);

    const current = await RefreshSession.findOne({
      familyId,
      userId,
      revokedAt: null,
      expiresAt: { $gt: now },
    })
      .select("+currentJtiHash revision refreshLifetimeMs expiresAt")
      .lean();

    if (!current) {
      throw new RefreshSessionRejectedError("invalid_session");
    }
    const lifetimeMs = requireLifetimeMs(current.refreshLifetimeMs);
    const expectedExpiry = new Date(current.expiresAt).getTime();
    // Rotation never extends a device family's absolute expiry. The signed JWT
    // and persisted session must continue to agree on the exact second.
    if (nextExpiresAt.getTime() !== expectedExpiry) {
      throw new RefreshSessionRejectedError("invalid_session");
    }

    const rotated = await RefreshSession.findOneAndUpdate(
      {
        familyId,
        userId,
        currentJtiHash,
        revision: current.revision,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          currentJtiHash: hashTokenId(nextTokenId),
          expiresAt: nextExpiresAt,
        },
        $inc: { revision: 1 },
      },
      { new: true },
    ).select("expiresAt");

    if (rotated) {
      return Object.freeze({
        expiresAt: new Date(rotated.expiresAt),
        lifetimeMs,
      });
    }

    // A JWT with a valid signature and family id that no longer matches the
    // active JTI is a consumed-token replay (including a concurrent replay).
    // Revoke the whole device family so a race winner cannot remain usable.
    const revoked = await RefreshSession.findOneAndUpdate(
      {
        familyId,
        userId,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          revokedAt: now,
          revocationReason: "token_reuse",
        },
        $inc: { revision: 1 },
      },
      { new: true },
    ).select("_id");

    throw new RefreshSessionRejectedError(
      revoked ? "token_reuse" : "invalid_session",
    );
  }

  static async revokeCurrent(
    claims: RefreshSessionClaims,
    expectedUserId: string,
  ): Promise<void> {
    const userId = requireUserId(claims.userId);
    if (userId !== requireUserId(expectedUserId)) {
      throw new RefreshSessionRejectedError("invalid_session");
    }
    const familyId = requireUuid(claims.sid);
    requireUuid(claims.jti);
    await RefreshSession.updateOne(
      { familyId, userId, revokedAt: null },
      {
        $set: { revokedAt: new Date(), revocationReason: "logout" },
        $inc: { revision: 1 },
      },
    );
  }

  static async revokeAllForUser(
    userIdValue: string,
    reason: Exclude<RefreshSessionRevocationReason, "logout" | "token_reuse">,
  ): Promise<number> {
    const userId = requireUserId(userIdValue);
    const result = await RefreshSession.updateMany(
      { userId, revokedAt: null },
      {
        $set: { revokedAt: new Date(), revocationReason: reason },
        $inc: { revision: 1 },
      },
    );
    return result.modifiedCount;
  }
}

export const __refreshSessionTestUtils = Object.freeze({ hashTokenId });
