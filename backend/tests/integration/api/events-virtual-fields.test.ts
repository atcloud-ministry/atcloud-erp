import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import app from "../../../src/app";
import Event from "../../../src/models/Event";
import User from "../../../src/models/User";
import { ensureIntegrationDB } from "../setup/connect";

describe("Event virtual meeting fields", () => {
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    // Ensure database connection is established
    await ensureIntegrationDB();

    // Clean up any existing events to prevent conflicts
    await Event.deleteMany({});

    // Register and promote an admin user
    const reg = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      firstName: "Admin",
      lastName: "User",
      email: "virtual.admin@example.com",
      username: "virtualadmin",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    adminId = reg.body.data.user.id;
    await User.findByIdAndUpdate(adminId, {
      isVerified: true,
      role: "Administrator",
    });
    const login = await request(app).post("/api/auth/login").send({
      emailOrUsername: "virtual.admin@example.com",
      password: "AdminPass123!",
    });
    adminToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await User.deleteOne({ _id: adminId });
    await Event.deleteMany({});
  });

  it("allows adding zoom fields later for Online events created empty", async () => {
    // Use a unique future date to avoid conflicts (30 days out)
    const eventDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Online Event Virtual Fields Test",
        description: "Test",
        date: eventDate,
        time: "10:00",
        endTime: "11:00",
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
        zoomLink: "",
        meetingId: "",
        passcode: "",
        suppressNotifications: true, // Suppress to avoid notification overhead
      })
      .expect(201);

    const id = createRes.body.data.event.id;
    const updateRes = await request(app)
      .put(`/api/events/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        zoomLink: "https://zoom.us/j/123456789",
        meetingId: "123 456 789",
        passcode: "secret",
      })
      .expect(200);

    expect(updateRes.body.data.event.zoomLink).toBe(
      "https://zoom.us/j/123456789"
    );
    expect(updateRes.body.data.event.meetingId).toBe("123 456 789");
    expect(updateRes.body.data.event.passcode).toBe("secret");

    const fromDb = (await Event.findById(id).lean()) as any;
    expect(fromDb?.zoomLink).toBe("https://zoom.us/j/123456789");
    expect(fromDb?.meetingId).toBe("123 456 789");
    expect(fromDb?.passcode).toBe("secret");

    // Clean up
    await Event.findByIdAndDelete(id);
  });

  it("allows adding zoom fields later for Hybrid events created empty", async () => {
    // Use a unique future date to avoid conflicts (35 days out)
    const eventDate = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Hybrid Event Virtual Fields Test",
        description: "Test",
        date: eventDate,
        time: "12:00",
        endTime: "13:00",
        type: "Conference",
        format: "Hybrid Participation",
        location: "Headquarters",
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
        zoomLink: "",
        meetingId: "",
        passcode: "",
        suppressNotifications: true, // Suppress to avoid notification overhead
      })
      .expect(201);

    const id = createRes.body.data.event.id;
    const updateRes = await request(app)
      .put(`/api/events/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        zoomLink: "https://zoom.us/j/987654321",
        meetingId: "987 654 321",
        passcode: "hybrid",
      })
      .expect(200);

    expect(updateRes.body.data.event.zoomLink).toBe(
      "https://zoom.us/j/987654321"
    );
    expect(updateRes.body.data.event.meetingId).toBe("987 654 321");
    expect(updateRes.body.data.event.passcode).toBe("hybrid");

    const fromDb = (await Event.findById(id).lean()) as any;
    expect(fromDb?.zoomLink).toBe("https://zoom.us/j/987654321");
    expect(fromDb?.meetingId).toBe("987 654 321");
    expect(fromDb?.passcode).toBe("hybrid");

    // Clean up
    await Event.findByIdAndDelete(id);
  });

  it("clears virtual fields when switching to In-person", async () => {
    // Use a unique future date to avoid conflicts (40 days out)
    const eventDate = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Switch Event Virtual Fields Test",
        description: "Test",
        date: eventDate,
        time: "15:00",
        endTime: "16:00",
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
        zoomLink: "https://zoom.us/j/abc",
        meetingId: "m",
        passcode: "p",
        suppressNotifications: true, // Suppress to avoid notification overhead
      })
      .expect(201);

    const id = createRes.body.data.event.id;
    const updateRes = await request(app)
      .put(`/api/events/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        format: "In-person",
        location: "Hall",
      })
      .expect(200);

    expect(updateRes.body.data.event.zoomLink).toBeUndefined();
    expect(updateRes.body.data.event.meetingId).toBeUndefined();
    expect(updateRes.body.data.event.passcode).toBeUndefined();

    const fromDb = (await Event.findById(id).lean()) as any;
    expect(fromDb?.zoomLink).toBeUndefined();
    expect(fromDb?.meetingId).toBeUndefined();
    expect(fromDb?.passcode).toBeUndefined();

    // Clean up
    await Event.findByIdAndDelete(id);
  });
});
