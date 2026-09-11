import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import { ensureIntegrationDB } from "../setup/connect";

describe("Analytics export CSV rows mode", () => {
  let adminToken: string;

  beforeEach(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});

    const a = {
      ...TEST_REGISTRATION_PROFILE,
      username: "csv_rows_admin",
      email: "csv_rows_admin@example.com",
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
      { isVerified: true, role: "Administrator" },
    );
    const la = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: a.email, password: a.password })
      .expect(200);
    adminToken = la.body.data.accessToken;
  });

  it("GET /api/analytics/export?format=csv&mode=rows -> 200 text/csv with sections", async () => {
    const res = await request(app)
      .get("/api/analytics/export?format=csv&mode=rows&maxRows=5")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const body = res.text || res.body?.toString?.() || "";
    // Section headers
    expect(body).toContain("# Users\nUsername,Email,Role,CreatedAt\n");
    expect(body).toContain("# Events\nTitle,Format,Status,CreatedAt\n");
    expect(body).toContain(
      "# Registrations\nUserId,UserEmail,UserName,EventId,EventTitle,RoleId,RoleName,Status,AttendanceStatus,AttendanceConfirmed,RegistrationDate\n",
    );
  });
});
