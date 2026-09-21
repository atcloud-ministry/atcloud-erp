/**
 * Token Refresh API Integration Tests
 *
 * Tests the token refresh endpoint:
 * - POST /api/auth/refresh-token
 *
 * Coverage includes:
 * - Successful token refresh
 * - Missing refresh token
 * - Invalid/malformed token
 * - Expired token
 * - User not found/inactive
 * - Cookie handling
 * - Error scenarios
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import app from "../../../src/app";
import crypto from "crypto";
import { RefreshSession, User } from "../../../src/models";
import { ensureIntegrationDB } from "../setup/connect";
import { createAndLoginTestUser } from "../../test-utils/createTestUser";
import { ROLES } from "../../../src/utils/roleUtils";
import { TokenService } from "../../../src/middleware/auth";

describe("Token Refresh API Integration Tests", () => {
  let testUser: any;
  let testUserToken: string;
  let validRefreshToken: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    // Clean up
    await Promise.all([User.deleteMany({}), RefreshSession.deleteMany({})]);

    // Create test user and get tokens
    const result = await createAndLoginTestUser({
      username: "tokenuser",
      email: "token@test.com",
      password: "Password123!",
      role: ROLES.PARTICIPANT,
      verified: true,
    });
    testUserToken = result.token;

    // Get user from database
    testUser = await User.findOne({ email: "token@test.com" });

    validRefreshToken = result.refreshToken!;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([User.deleteMany({}), RefreshSession.deleteMany({})]);
  });

  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  describe("POST /api/auth/refresh-token", () => {
    describe("Successful Token Refresh", () => {
      it("should successfully refresh tokens with valid refresh token", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.message).toMatch(/token refreshed successfully/i);
        expect(response.body.data).toBeDefined();
        expect(response.body.data.accessToken).toBeDefined();
        expect(typeof response.body.data.accessToken).toBe("string");
        expect(response.body.data).not.toHaveProperty("refreshToken");
      });

      it("should set new refresh token cookie", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        const setCookieHeader = response.headers["set-cookie"];
        expect(setCookieHeader).toBeDefined();

        if (setCookieHeader) {
          const cookieString = Array.isArray(setCookieHeader)
            ? setCookieHeader.join("; ")
            : setCookieHeader;

          expect(cookieString).toMatch(/refreshToken/);
          expect(cookieString).toMatch(/httponly/i);
          expect(cookieString).toMatch(/path=\/api\/auth/i);
        }
      });

      it("keeps a non-remembered family at its fixed one-day expiry after rotation", async () => {
        const original = TokenService.verifyRefreshToken(validRefreshToken);
        expect((original.exp! - original.iat!) * 1_000).toBe(86_400_000);

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);
        const rotatedCookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
        const rotatedToken = rotatedCookie?.slice("refreshToken=".length);
        const rotated = TokenService.verifyRefreshToken(rotatedToken!);
        expect(rotated.exp).toBe(original.exp);

        const session = await RefreshSession.findOne({ familyId: rotated.sid });
        expect(session?.refreshLifetimeMs).toBe(86_400_000);
        expect(session?.expiresAt.getTime()).toBe(original.exp! * 1_000);
      });

      it("uses the configured lifetime for remembered families", async () => {
        const previous = process.env.JWT_REFRESH_EXPIRE;
        process.env.JWT_REFRESH_EXPIRE = "9d";
        try {
          const response = await request(app)
            .post("/api/auth/login")
            .send({
              emailOrUsername: "token@test.com",
              password: "Password123!",
              rememberMe: true,
            })
            .expect(200);
          const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
          const token = cookie?.slice("refreshToken=".length);
          const claims = TokenService.verifyRefreshToken(token!);
          expect((claims.exp! - claims.iat!) * 1_000).toBe(9 * 86_400_000);
          await expect(
            RefreshSession.findOne({ familyId: claims.sid }).lean(),
          ).resolves.toMatchObject({ refreshLifetimeMs: 9 * 86_400_000 });
        } finally {
          if (previous === undefined) delete process.env.JWT_REFRESH_EXPIRE;
          else process.env.JWT_REFRESH_EXPIRE = previous;
        }
      });

      it("stores a JTI hash rather than the raw identifier or JWT", async () => {
        const claims = TokenService.verifyRefreshToken(validRefreshToken);
        const session = await RefreshSession.findOne({ familyId: claims.sid })
          .select("+currentJtiHash")
          .lean();
        expect(session?.currentJtiHash).toBe(
          crypto.createHash("sha256").update(claims.jti).digest("hex"),
        );
        expect(JSON.stringify(session)).not.toContain(claims.jti);
        expect(JSON.stringify(session)).not.toContain(validRefreshToken);
      });

      it("issues immediately usable tokens after a password-change marker", async () => {
        const changedAt = new Date();
        await User.updateOne({ _id: testUser._id }, { passwordChangedAt: changedAt });

        const login = await request(app)
          .post("/api/auth/login")
          .send({
            emailOrUsername: "token@test.com",
            password: "Password123!",
            rememberMe: false,
          })
          .expect(200);
        const accessToken = login.body.data.accessToken as string;
        const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
        const refreshToken = cookie?.slice("refreshToken=".length);
        const accessClaims = TokenService.decodeToken(accessToken) as { iat: number };
        const refreshClaims = TokenService.verifyRefreshToken(refreshToken!);

        expect(accessClaims.iat).toBeGreaterThan(
          Math.floor(changedAt.getTime() / 1_000),
        );
        expect(refreshClaims.iat).toBeGreaterThan(
          Math.floor(changedAt.getTime() / 1_000),
        );
        await request(app)
          .get("/api/auth/profile")
          .set("Authorization", `Bearer ${accessToken}`)
          .expect(200);
        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", cookie!)
          .expect(200);
      });

      it("should return valid access token that can be used", async () => {
        const refreshResponse = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        const newAccessToken = refreshResponse.body.data.accessToken;

        // Use new access token to access protected endpoint
        const profileResponse = await request(app)
          .get("/api/auth/profile")
          .set("Authorization", `Bearer ${newAccessToken}`)
          .expect(200);

        expect(profileResponse.body.success).toBe(true);
        expect(profileResponse.body.data.user).toBeDefined();
      });
    });

    describe("Missing Refresh Token", () => {
      it("should return 401 when refresh token not provided", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/refresh token not provided/i);
        expect(response.headers["set-cookie"]?.join(";")).toMatch(
          /refreshToken=;/,
        );
      });

      it("should return 401 when cookie header is empty", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", "")
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(/refresh token not provided/i);
      });
    });

    describe("Invalid Refresh Token", () => {
      it("should return 401 for malformed token", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", "refreshToken=invalid-token-format")
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(
          /invalid refresh token|token refresh failed/i
        );
      });

      it("should return 401 for token with invalid signature", async () => {
        const fakeToken =
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ.invalidsignature";

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${fakeToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(
          /invalid refresh token|token refresh failed/i
        );
      });

      it("should return 401 for token without userId", async () => {
        // Create token without userId
        const tokenWithoutUserId = TokenService.generateTokenPair({
          _id: undefined as any,
        } as any).refreshToken;

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${tokenWithoutUserId}`)
          .expect(401);

        expect(response.body.success).toBe(false);
      });
    });

    describe("Expired Refresh Token", () => {
      it("should return 401 for expired token", async () => {
        // Mock TokenService to return null (invalid/expired)
        const expiredToken = "expired.token.value";
        vi.spyOn(TokenService, "verifyRefreshToken").mockReturnValue(
          null as any
        );

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${expiredToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(
          /invalid refresh token|token refresh failed/i
        );

        vi.restoreAllMocks();
      });
    });

    describe("User Validation", () => {
      it("should return 401 when user not found", async () => {
        // Delete the user
        await User.deleteOne({ _id: testUser._id });

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(
          /user not found|inactive|token refresh failed/i
        );
      });

      it("should return 401 when user is inactive", async () => {
        // Deactivate user
        await User.updateOne({ _id: testUser._id }, { isActive: false });

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.message).toMatch(
          /user not found|inactive|token refresh failed/i
        );
      });

      it("should return 401 when user is unverified", async () => {
        await User.updateOne({ _id: testUser._id }, { isVerified: false });

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);
      });

      it("revokes a refresh token issued before passwordChangedAt", async () => {
        const decoded = TokenService.decodeToken(validRefreshToken) as {
          iat: number;
        };
        await User.updateOne(
          { _id: testUser._id },
          { passwordChangedAt: new Date((decoded.iat + 1) * 1_000) },
        );

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);
      });

      it("fails closed for a refresh token in the password-change second", async () => {
        const decoded = TokenService.decodeToken(validRefreshToken) as {
          iat: number;
        };
        await User.updateOne(
          { _id: testUser._id },
          { passwordChangedAt: new Date(decoded.iat * 1_000 + 750) },
        );

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);
      });

      it("accepts a refresh token issued in a later second", async () => {
        const decoded = TokenService.decodeToken(validRefreshToken) as {
          iat: number;
        };
        await User.updateOne(
          { _id: testUser._id },
          { passwordChangedAt: new Date((decoded.iat - 1) * 1_000 + 750) },
        );

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);
      });

      it("does not revive pre-deactivation access or refresh tokens after reactivation", async () => {
        const securityStamp = new Date();
        await User.updateOne(
          { _id: testUser._id },
          { isActive: false, passwordChangedAt: securityStamp },
        );
        await User.updateOne({ _id: testUser._id }, { isActive: true });

        await request(app)
          .get("/api/auth/profile")
          .set("Authorization", `Bearer ${testUserToken}`)
          .expect(401);
        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);

        const login = await request(app)
          .post("/api/auth/login")
          .send({
            emailOrUsername: "token@test.com",
            password: "Password123!",
            rememberMe: false,
          })
          .expect(200);
        await request(app)
          .get("/api/auth/profile")
          .set("Authorization", `Bearer ${login.body.data.accessToken}`)
          .expect(200);
      });
    });

    describe("Cookie Security Settings", () => {
      it("should set httpOnly flag on refresh token cookie", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        const setCookieHeader = response.headers["set-cookie"];
        if (setCookieHeader) {
          const cookieString = Array.isArray(setCookieHeader)
            ? setCookieHeader[0]
            : setCookieHeader;

          expect(cookieString).toMatch(/httponly/i);
        }
      });

      it("should set sameSite=strict on refresh token cookie", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        const setCookieHeader = response.headers["set-cookie"];
        if (setCookieHeader) {
          const cookieString = Array.isArray(setCookieHeader)
            ? setCookieHeader[0]
            : setCookieHeader;

          expect(cookieString).toMatch(/samesite=strict/i);
        }
      });

      it("should set maxAge on refresh token cookie", async () => {
        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        const setCookieHeader = response.headers["set-cookie"];
        if (setCookieHeader) {
          const cookieString = Array.isArray(setCookieHeader)
            ? setCookieHeader[0]
            : setCookieHeader;

          expect(cookieString).toMatch(/max-age/i);
        }
      });
    });

    describe("Multiple Refresh Operations", () => {
      it("allows only one concurrent rotation and revokes the raced family", async () => {
        const promises = Array(3)
          .fill(null)
          .map(() =>
            request(app)
              .post("/api/auth/refresh-token")
              .set("Cookie", `refreshToken=${validRefreshToken}`)
          );

        const responses = await Promise.all(promises);

        expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
        expect(responses.filter((response) => response.status === 401)).toHaveLength(2);

        const winner = responses.find((response) => response.status === 200)!;
        const winnerCookie = winner.headers["set-cookie"]?.[0]?.split(";")[0];
        expect(winnerCookie).toBeDefined();
        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", winnerCookie!)
          .expect(401);
      });

      it("keeps separately logged-in device families independent", async () => {
        const secondLogin = await request(app)
          .post("/api/auth/login")
          .send({
            emailOrUsername: "token@test.com",
            password: "Password123!",
            rememberMe: false,
          })
          .expect(200);
        const secondCookie = secondLogin.headers["set-cookie"]?.[0]?.split(";")[0];

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);
        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", secondCookie!)
          .expect(200);
      });

      it("revokes only the family presented on logout", async () => {
        const secondLogin = await request(app)
          .post("/api/auth/login")
          .send({
            emailOrUsername: "token@test.com",
            password: "Password123!",
            rememberMe: false,
          })
          .expect(200);
        const secondCookie = secondLogin.headers["set-cookie"]?.[0]?.split(";")[0];

        await request(app)
          .post("/api/auth/logout")
          .set("Authorization", `Bearer ${testUserToken}`)
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);
        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", secondCookie!)
          .expect(200);
      });
    });

    describe("Different User Roles", () => {
      it("should refresh token for administrator", async () => {
        const adminResult = await createAndLoginTestUser({
          username: "adminuser",
          email: "admin@test.com",
          password: "Password123!",
          role: ROLES.ADMINISTRATOR,
          verified: true,
        });

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${adminResult.refreshToken}`)
          .expect(200);

        expect(response.body.success).toBe(true);
      });

      it("should refresh token for leader", async () => {
        const leaderResult = await createAndLoginTestUser({
          username: "leaderuser",
          email: "leader@test.com",
          password: "Password123!",
          role: ROLES.LEADER,
          verified: true,
        });

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${leaderResult.refreshToken}`)
          .expect(200);

        expect(response.body.success).toBe(true);
      });
    });

    describe("Response Time", () => {
      it("should respond quickly (< 200ms)", async () => {
        const start = Date.now();

        await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(200);

        const duration = Date.now() - start;
        expect(duration).toBeLessThan(200);
      });
    });

    describe("Error Handling", () => {
      it("should handle database errors gracefully", async () => {
        // Temporarily break User.findById
        vi.spyOn(User, "findById").mockRejectedValue(new Error("DB Error"));

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(503);

        expect(response.body.success).toBe(false);

      });

      it("should handle TokenService errors gracefully", async () => {
        vi.spyOn(TokenService, "verifyRefreshToken").mockImplementation(() => {
          throw new Error("Token service error");
        });

        const response = await request(app)
          .post("/api/auth/refresh-token")
          .set("Cookie", `refreshToken=${validRefreshToken}`)
          .expect(401);

        expect(response.body.success).toBe(false);

        vi.restoreAllMocks();
      });
    });
  });
});
