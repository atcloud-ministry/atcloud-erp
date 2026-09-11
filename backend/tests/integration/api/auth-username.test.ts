import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import mongoose from "mongoose";

describe("Auth Username Validation (Option C)", () => {
  afterAll(async () => {
    // Shared integration harness owns connection lifecycle.
  });

  const baseUser = {
    ...TEST_REGISTRATION_PROFILE,
    email: "u1@example.com",
    password: "StrongPass1",
    confirmPassword: "StrongPass1",
    firstName: "First",
    lastName: "Last",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
  };

  it("rejects invalid username format", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...baseUser, username: "Bad-Name" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Validation/i);
  });

  it("accepts valid lowercase username and enforces case-insensitive uniqueness", async () => {
    const suffix = Date.now().toString(36);
    const uname = `caseuser_${suffix}`;
    const unameCase = `CaseUser_${suffix}`; // same letters, different case
    const ok = await request(app)
      .post("/api/auth/register")
      .send({
        ...baseUser,
        email: `u2_${suffix}@example.com`,
        username: uname,
      });
    expect(ok.status).toBe(201);

    const dup = await request(app)
      .post("/api/auth/register")
      .send({
        ...baseUser,
        email: `u3_${suffix}@example.com`,
        username: unameCase, // different case should conflict after normalization
      });
    expect(dup.status).toBe(409);
  });
});
