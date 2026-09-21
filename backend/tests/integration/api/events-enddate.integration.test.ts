import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

describe("Event endDate support", () => {
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    // Register and promote an admin user
    const reg = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      firstName: "Admin",
      lastName: "User",
      email: "enddate.admin@example.com",
      username: "enddateadmin",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    });
    adminId = reg.body.data.user.id;
    await User.findByIdAndUpdate(adminId, {
      isVerified: true,
      role: "Administrator",
    });
    const login = await request(app).post("/api/auth/login").send({
      emailOrUsername: "enddate.admin@example.com",
      password: "AdminPass123!",
    });
    adminToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await User.deleteOne({ _id: adminId });
  });

  it("creates an event with a different endDate and returns it", async () => {
    const startDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    // end the next day
    const endDate = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Overnight Conference",
        description: "Test",
        date: startDate,
        endDate,
        time: "22:00",
        endTime: "02:00",
        type: "Conference",
        format: "Online",
        agenda: "Intro, sessions, fellowship, and closing remarks.",
        organizer: "Org",
        purpose: "Testing endDate",
        roles: [
          {
            id: "r1",
            name: "Common Participant (Zoom)",
            maxParticipants: 5,
            description: "General attendee",
          },
        ],
      })
      .expect(201);

    expect(res.body.data.event.endDate).toBe(endDate);
    expect(res.body.data.event.date).toBe(startDate);
  });

  it("rejects events whose end is before start across dates/times", async () => {
    const startDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    // same day, but end time before start time
    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Invalid Range",
        description: "Test",
        date: startDate,
        endDate: startDate,
        time: "10:00",
        endTime: "09:00",
        type: "Conference",
        format: "Online",
        agenda: "Sessions",
        organizer: "Org",
        purpose: "Testing invalid",
        roles: [
          {
            id: "r1",
            name: "Common Participant (Zoom)",
            maxParticipants: 5,
            description: "General attendee",
          },
        ],
      });

    expect([400, 422]).toContain(res.statusCode);
    expect(res.body.success).toBe(false);
  });

  it("allows earlier endTime when endDate is after start date (overnight)", async () => {
    const startDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const endDate = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Overnight Earlier EndTime",
        description: "Test",
        date: startDate,
        endDate,
        time: "18:30",
        endTime: "07:15", // earlier clock time, but next-day endDate
        type: "Conference",
        format: "Online",
        agenda:
          "Intro, evening sessions, overnight break, and morning wrap-up.",
        organizer: "Org",
        purpose: "Validate that earlier endTime passes when endDate is later",
        roles: [
          {
            id: "r1",
            name: "Common Participant (Zoom)",
            maxParticipants: 5,
            description: "General attendee",
          },
        ],
      })
      .expect(201);

    expect(res.body.data.event.date).toBe(startDate);
    expect(res.body.data.event.endDate).toBe(endDate);
  });
});
