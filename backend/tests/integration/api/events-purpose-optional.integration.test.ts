import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

// Enable verbose validation diagnostics for this spec only
process.env.TEST_VALIDATION_LOG = "1";

describe("Events API - Purpose optional", () => {
  let adminToken: string;
  let adminId: string;

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "adminpurpose", // must be lowercase per validation rules
      email: "admin-purpose@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "Purpose",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;

    const adminResponse = await request(app)
      .post("/api/auth/register")
      .send(adminData);

    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );

    const adminLoginResponse = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });

    adminToken = adminLoginResponse.body.data.accessToken;
    adminId = adminResponse.body.data.user.id;
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  it("allows creating an event without purpose", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyy = tomorrow.getFullYear();
    const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const dd = String(tomorrow.getDate()).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;

    const response = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Purpose Optional Test",
        type: "Effective Communication Workshop",
        date,
        endDate: date,
        time: "10:00",
        endTime: "12:00",
        location: "Headquarters",
        organizer: "Admin Purpose (Admin)",
        format: "In-person",
        agenda:
          "Intro, main content, discussion, Q&A, and closing remarks for testing.",
        roles: [
          {
            id: "r1",
            name: "Zoom Host", // valid for Effective Communication Workshop
            description: "Host the Zoom session",
            maxParticipants: 1, // template allows 1 (<= 3x allowed)
          },
        ],
      })
      .expect(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.event.createdBy.id).toBe(adminId);
    // Purpose omitted - backend returns empty string or undefined depending on builder
    const created = await Event.findOne({ title: "Purpose Optional Test" });
    expect(created).toBeTruthy();
    // Schema now allows undefined purpose
  });

  it("allows updating an event to clear purpose", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyy = tomorrow.getFullYear();
    const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const dd = String(tomorrow.getDate()).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;

    // First create with a purpose
    const createResp = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Purpose Clear Test",
        type: "Effective Communication Workshop",
        date,
        endDate: date,
        time: "09:00",
        endTime: "10:00",
        location: "Headquarters",
        organizer: "Admin Purpose (Admin)",
        format: "In-person",
        agenda:
          "Intro, main content, discussion, Q&A, and closing remarks for testing.",
        purpose: "Initial purpose",
        roles: [
          {
            id: "r1",
            name: "Zoom Host", // valid for Effective Communication Workshop
            description: "Host the Zoom session",
            maxParticipants: 1,
          },
        ],
      })
      .expect(201);

    const eventId = createResp.body.data.event.id;

    // Update to clear the purpose
    await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ purpose: "" })
      .expect(200);
  });
});
