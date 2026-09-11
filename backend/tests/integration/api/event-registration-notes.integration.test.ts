import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Integration Test: Ensure registration notes are returned in event detail API
 * Focuses on regression where notes stopped appearing in API responses
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";

describe("Event registration notes exposure", () => {
  let userToken: string;
  let userId: string;
  let eventId: string;

  beforeAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});

    // Register & verify user
    const userRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "noteuser",
      email: "noteuser@example.com",
      password: "NoteUserPass123!",
      confirmPassword: "NoteUserPass123!",
      firstName: "Note",
      lastName: "User",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    userId = userRes.body.data.user.id;
    await User.findByIdAndUpdate(userId, { isVerified: true });

    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: "noteuser@example.com",
      password: "NoteUserPass123!",
    });
    userToken = loginRes.body.data.accessToken;

    // Create simple event directly
    const event = await Event.create({
      title: "Notes Event",
      description: "Event to test notes visibility",
      date: new Date(Date.now() + 86400000).toISOString().split("T")[0],
      time: "10:00",
      endTime: "11:00",
      location: "Test Location",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "Test",
      organizer: "QA",
      createdBy: new mongoose.Types.ObjectId(userId),
      roles: [
        {
          id: "role-1",
          name: "Group A Participants",
          maxParticipants: 10,
          description: "Group A",
        },
      ],
      status: "upcoming",
      timeZone: "Etc/UTC",
    } as any);
    eventId = (event as any)._id.toString();

    // Perform signup through API to ensure full snapshot logic runs
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        roleId: "role-1",
        notes: "Looking forward to it!",
        specialRequirements: "None",
      })
      .expect(200);
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
  });

  it("returns registration notes in event detail", async () => {
    const res = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    const registrations = res.body.data.event.roles[0].registrations;
    expect(registrations.length).toBe(1);
    expect(registrations[0]).toHaveProperty("notes", "Looking forward to it!");
    expect(registrations[0]).toHaveProperty("specialRequirements", "None");
  });
});
