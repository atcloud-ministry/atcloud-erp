import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import RefreshSession from "../../../src/models/RefreshSession";
import {
  RefreshSessionRejectedError,
  RefreshSessionService,
} from "../../../src/services/auth/RefreshSessionService";
import { ensureIntegrationDB } from "../setup/connect";

const DAY_MS = 24 * 60 * 60 * 1_000;

function registration(userId: string) {
  const identity = RefreshSessionService.createIdentity();
  const expiresAt = new Date(
    (Math.floor(Date.now() / 1_000) + DAY_MS / 1_000) * 1_000,
  );
  return { userId, identity, expiresAt, refreshLifetimeMs: DAY_MS };
}

function claims(input: ReturnType<typeof registration>) {
  return {
    userId: input.userId,
    sid: input.identity.familyId,
    jti: input.identity.tokenId,
  };
}

describe("RefreshSessionService integration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await RefreshSession.init();
  });

  afterEach(async () => {
    await RefreshSession.deleteMany({});
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  it("atomically permits one same-token rotation and revokes the raced family", async () => {
    const initial = registration(new mongoose.Types.ObjectId().toString());
    await RefreshSessionService.register(initial);

    const attempts = await Promise.allSettled(
      [
        RefreshSessionService.createRotationIdentity(initial.identity.familyId),
        RefreshSessionService.createRotationIdentity(initial.identity.familyId),
      ].map((nextIdentity) =>
        RefreshSessionService.rotate({
          claims: claims(initial),
          nextIdentity,
          nextExpiresAt: initial.expiresAt,
        }),
      ),
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toBeInstanceOf(RefreshSessionRejectedError);
    expect(rejection?.reason).toMatchObject({ code: "token_reuse" });
    await expect(
      RefreshSession.findOne({ familyId: initial.identity.familyId }).lean(),
    ).resolves.toMatchObject({
      revocationReason: "token_reuse",
      expiresAt: initial.expiresAt,
    });
  });

  it("detects sequential replay and makes the winner token unusable", async () => {
    const initial = registration(new mongoose.Types.ObjectId().toString());
    await RefreshSessionService.register(initial);
    const winner = RefreshSessionService.createRotationIdentity(
      initial.identity.familyId,
    );
    await RefreshSessionService.rotate({
      claims: claims(initial),
      nextIdentity: winner,
      nextExpiresAt: initial.expiresAt,
    });

    await expect(
      RefreshSessionService.rotate({
        claims: claims(initial),
        nextIdentity: RefreshSessionService.createRotationIdentity(
          initial.identity.familyId,
        ),
        nextExpiresAt: initial.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "token_reuse" });
    await expect(
      RefreshSessionService.rotate({
        claims: {
          userId: initial.userId,
          sid: winner.familyId,
          jti: winner.tokenId,
        },
        nextIdentity: RefreshSessionService.createRotationIdentity(
          initial.identity.familyId,
        ),
        nextExpiresAt: initial.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "invalid_session" });
  });

  it("rotates two device families independently", async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const first = registration(userId);
    const second = registration(userId);
    await Promise.all([
      RefreshSessionService.register(first),
      RefreshSessionService.register(second),
    ]);

    await Promise.all(
      [first, second].map((session) =>
        RefreshSessionService.rotate({
          claims: claims(session),
          nextIdentity: RefreshSessionService.createRotationIdentity(
            session.identity.familyId,
          ),
          nextExpiresAt: session.expiresAt,
        }),
      ),
    );

    expect(
      await RefreshSession.countDocuments({ userId, revokedAt: null }),
    ).toBe(2);
  });

  it("rejects an attempt to extend the absolute family expiry", async () => {
    const initial = registration(new mongoose.Types.ObjectId().toString());
    await RefreshSessionService.register(initial);
    await expect(
      RefreshSessionService.rotate({
        claims: claims(initial),
        nextIdentity: RefreshSessionService.createRotationIdentity(
          initial.identity.familyId,
        ),
        nextExpiresAt: new Date(initial.expiresAt.getTime() + DAY_MS),
      }),
    ).rejects.toMatchObject({ code: "invalid_session" });
  });
});
