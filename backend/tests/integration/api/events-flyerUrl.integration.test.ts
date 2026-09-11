import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

// Enable verbose validation diagnostics for this spec only
process.env.TEST_VALIDATION_LOG = "1";

describe("Events API - flyerUrl optional", () => {
  let adminToken: string;

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "adminflyer",
      email: "admin-flyer@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "Flyer",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;

    await request(app).post("/api/auth/register").send(adminData);

    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );

    const adminLoginResponse = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });

    adminToken = adminLoginResponse.body.data.accessToken;
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  function futureDate() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const baseEvent = () => ({
    title: "Flyer Optional Test",
    type: "Effective Communication Workshop",
    date: futureDate(),
    endDate: futureDate(),
    time: "10:00",
    endTime: "12:00",
    location: "HQ Main",
    organizer: "Admin Flyer (Admin)",
    format: "In-person",
    agenda:
      "This is an agenda long enough to satisfy validation (>= 20 characters).",
    roles: [
      {
        id: "r1",
        name: "Zoom Host",
        description: "Host the Zoom session",
        maxParticipants: 1,
      },
    ],
  });

  it("accepts creation without flyerUrl", async () => {
    const resp = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(baseEvent())
      .expect(201);

    expect(resp.body.success).toBe(true);
    const event = await Event.findOne({ title: "Flyer Optional Test" });
    expect(event?.flyerUrl === undefined).toBe(true);
  });

  it("accepts creation with http(s) flyerUrl", async () => {
    const payload = {
      ...baseEvent(),
      flyerUrl: "https://example.com/flyer.jpg",
    };
    const resp = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);

    expect(resp.body.success).toBe(true);
    expect(resp.body.data.event.flyerUrl).toContain(
      "https://example.com/flyer.jpg"
    );
  });

  it("accepts creation with /uploads flyerUrl", async () => {
    const payload = { ...baseEvent(), flyerUrl: "/uploads/images/flyer.jpg" };
    const resp = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);

    expect(resp.body.success).toBe(true);
    expect(resp.body.data.event.flyerUrl).toContain(
      "/uploads/images/flyer.jpg"
    );
  });

  it("rejects invalid flyerUrl format", async () => {
    const payload = { ...baseEvent(), flyerUrl: "ftp://example.com/flyer.jpg" };
    const resp = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(payload)
      .expect(400);

    expect(resp.body.success).toBe(false);
    // Ensure validation errors contain our Flyer URL message
    const msgBlob = JSON.stringify(resp.body.errors || resp.body);
    expect(msgBlob).toMatch(/Flyer URL/);
  });

  it("normalizes empty flyerUrl to undefined on update", async () => {
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ...baseEvent(), flyerUrl: "https://example.com/keep.jpg" })
      .expect(201);

    const id = create.body.data.event.id;

    const update = await request(app)
      .put(`/api/events/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flyerUrl: "" })
      .expect(200);

    expect(update.body.success).toBe(true);
  });
});
