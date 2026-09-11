import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

describe("Analytics API integration", () => {
  let participantToken: string;
  let adminToken: string;

  beforeEach(async () => {
    await User.deleteMany({});

    // participant
    const p = {
      ...TEST_REGISTRATION_PROFILE,
      username: "an_participant",
      email: "an_participant@example.com",
      password: "Passw0rd!",
      confirmPassword: "Passw0rd!",
      firstName: "Parti",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };
    await request(app).post("/api/auth/register").send(p).expect(201);
    await User.findOneAndUpdate({ email: p.email }, { isVerified: true });
    const lp = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: p.email, password: p.password })
      .expect(200);
    participantToken = lp.body.data.accessToken;

    // admin
    const a = {
      ...TEST_REGISTRATION_PROFILE,
      username: "an_admin",
      email: "an_admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };
    await request(app).post("/api/auth/register").send(a).expect(201);
    await User.findOneAndUpdate(
      { email: a.email },
      { isVerified: true, role: "Administrator" }
    );
    const la = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: a.email, password: a.password })
      .expect(200);
    adminToken = la.body.data.accessToken;
  });

  afterEach(async () => {
    await User.deleteMany({});
  });

  it("GET /api/analytics -> 401 without token", async () => {
    await request(app).get("/api/analytics").expect(401);
  });

  it("GET /api/analytics -> 403 for participant", async () => {
    const res = await request(app)
      .get("/api/analytics")
      .set("Authorization", `Bearer ${participantToken}`)
      .expect(403);
    expect(res.body.success).toBe(false);
  });

  it("GET /api/analytics -> 200 for admin", async () => {
    const res = await request(app)
      .get("/api/analytics")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("GET /api/analytics/users -> 200 for admin", async () => {
    const res = await request(app)
      .get("/api/analytics/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.success).toBe(true);
  });

  it("GET /api/analytics/events -> 200 for admin", async () => {
    const res = await request(app)
      .get("/api/analytics/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.success).toBe(true);
  });

  it("GET /api/analytics/donations -> 200 for admin and returns analytics shape", async () => {
    const res = await request(app)
      .get("/api/analytics/donations")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        totalRevenue: expect.any(Number),
        totalGifts: expect.any(Number),
        uniqueDonors: expect.any(Number),
        oneTime: expect.objectContaining({
          gifts: expect.any(Number),
          revenue: expect.any(Number),
        }),
        recurring: expect.objectContaining({
          gifts: expect.any(Number),
          revenue: expect.any(Number),
          activeDonations: expect.any(Number),
          onHoldDonations: expect.any(Number),
          scheduledDonations: expect.any(Number),
          frequencyBreakdown: expect.any(Array),
        }),
      })
    );
  });

  it("GET /api/analytics/financial-summary -> 200 for admin and returns financial summary shape", async () => {
    const res = await request(app)
      .get("/api/analytics/financial-summary")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        totalRevenue: expect.any(Number),
        totalTransactions: expect.any(Number),
        uniqueParticipants: expect.any(Number),
        growthRate: expect.any(Number),
        last30Days: expect.objectContaining({
          revenue: expect.any(Number),
          transactions: expect.any(Number),
          percentage: expect.any(Number),
        }),
        programs: expect.objectContaining({
          revenue: expect.any(Number),
          purchases: expect.any(Number),
          uniqueBuyers: expect.any(Number),
          last30Days: expect.objectContaining({
            revenue: expect.any(Number),
            purchases: expect.any(Number),
          }),
        }),
        donations: expect.objectContaining({
          revenue: expect.any(Number),
          gifts: expect.any(Number),
          uniqueDonors: expect.any(Number),
          last30Days: expect.objectContaining({
            revenue: expect.any(Number),
            donations: expect.any(Number),
          }),
        }),
      })
    );
  });
});
