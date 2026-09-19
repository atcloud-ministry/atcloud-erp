import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

describe("Event time zone support", () => {
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    const reg = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      firstName: "TZ",
      lastName: "Admin",
      email: "tz.admin@example.com",
      username: "tzadmin",
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
      emailOrUsername: "tz.admin@example.com",
      password: "AdminPass123!",
    });
    adminToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await User.deleteOne({ _id: adminId });
  });

  it("stores and returns timeZone on create and detail", async () => {
    const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "TZ Event",
        description: "Test TZ",
        date,
        time: "09:00",
        endTime: "10:00",
        type: "Conference",
        format: "Online",
        agenda: "Intro, main content, discussion, Q&A, and closing remarks.",
        organizer: "Org",
        purpose: "Event purpose for testing",
        roles: [
          {
            id: "r1",
            name: "Common Participant (Zoom)",
            maxParticipants: 5,
            description: "General attendee",
          },
        ],
        timeZone: "America/Los_Angeles",
      })
      .expect(201);

    const eventId = createRes.body.data.event.id;
    expect(createRes.body.data.event.timeZone).toBe("America/Los_Angeles");

    const detailRes = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(detailRes.body.data.event.timeZone).toBe("America/Los_Angeles");
  });
});
