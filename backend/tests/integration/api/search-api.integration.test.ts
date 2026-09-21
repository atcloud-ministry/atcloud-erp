import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

// Note: validation middleware already covered; here we do happy paths and auth behavior

// Run this suite sequentially to avoid concurrent beforeEach collisions
describe("Search API integration", { concurrent: false }, () => {
  let token: string;
  // Track the unique email pattern we generate so cleanup is scoped and safe for parallel suites
  const emailPrefix = "srchuser"; // keep short to satisfy username max length (<=20)

  beforeEach(async () => {
    // Only delete users created by this spec to avoid cross-file interference
    await User.deleteMany({ email: { $regex: `^${emailPrefix}` } });

    // Build a compact unique id using base36 time + random; no underscores to satisfy username rules
    const compactId = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`; // ~12 chars
    // Username must be 3-20 chars, lowercase, start with letter, only [a-z0-9_]
    const username = `${emailPrefix}${compactId}`.slice(0, 20);
    const email = `${emailPrefix}${compactId}@example.com`;
    const u = {
      ...TEST_REGISTRATION_PROFILE,
      username,
      email,
      password: "Passw0rd!",
      confirmPassword: "Passw0rd!",
      firstName: "Search",
      lastName: "User",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    };
    await request(app).post("/api/auth/register").send(u).expect(201);
    await User.findOneAndUpdate(
      { email: u.email },
      { isVerified: true, role: "Administrator" },
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: u.email, password: u.password })
      .expect(200);
    token = login.body.data.accessToken;
  });

  afterEach(async () => {
    // Clean up only users created by this spec
    await User.deleteMany({ email: { $regex: `^${emailPrefix}` } });
  });

  it("users: 401 without token", async () => {
    await request(app).get("/api/search/users?q=sea").expect(401);
  });

  it("users: 200 with an account-manager token", async () => {
    const res = await request(app)
      .get("/api/search/users?q=sea")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("users");
  });

  it("events: 200 with token", async () => {
    const res = await request(app)
      .get("/api/search/events?q=event")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("events");
  });

  it("global: 200 with token", async () => {
    const res = await request(app)
      .get("/api/search/global?q=all")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("users");
    expect(res.body.data).toHaveProperty("events");
  });
});
