import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";

/**
 * This suite verifies guests can register once per event (no global block across events).
 */
describe("Guests per-event registration policy", () => {
  let adminToken: string;
  let eventAId: string;
  let eventBId: string;
  let roleAId: string;
  let roleBId: string;

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "admin",
      email: "admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };

    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = loginRes.body.data.accessToken;

    async function createEvent(
      title: string,
      startTime: string = "10:00",
      endTime: string = "12:00"
    ) {
      const res = await request(app)
        .post("/api/events")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          title,
          description: "Event",
          date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          time: startTime,
          endTime: endTime,
          location: "Test Location",
          type: "Effective Communication Workshop",
          format: "In-person",
          purpose:
            "This event is used to validate the single-event access policy during integration tests.",
          agenda:
            "1. Setup test admin and events\n2. Register guest on Event A\n3. Assert second signup blocked on Event B\n4. Cancel first and retry",
          organizer: "Test Organizer",
          maxParticipants: 50,
          category: "general",
          roles: [
            {
              name: "Zoom Host",
              maxParticipants: 3,
              description: "Hosts the Zoom session and oversees logistics",
            },
          ],
        })
        .expect(201);
      const evt = res.body.data.event;
      const id = evt.id || evt._id;
      const roleId = (evt.roles || [])[0]?.id;
      return { id, roleId };
    }

    const a = await createEvent("Event A", "10:00", "12:00");
    // Create Event B at a non-overlapping time window to avoid 409 conflict
    const b = await createEvent("Event B", "13:00", "15:00");
    eventAId = a.id;
    eventBId = b.id;
    roleAId = a.roleId!;
    roleBId = b.roleId!;
  });

  afterEach(async () => {
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  const guest = {
    fullName: "Single Event Guest",
    gender: "female",
    email: "single@example.com",
    phone: "+1 (555) 123-4567",
  };

  it("allows active guest registrations for the same email across different events", async () => {
    // First event signup (should succeed)
    await request(app)
      .post(`/api/events/${eventAId}/guest-signup`)
      .send({ ...guest, roleId: roleAId })
      .expect(201);

    // Second event signup with same email on a different event (should also succeed)
    await request(app)
      .post(`/api/events/${eventBId}/guest-signup`)
      .send({ ...guest, roleId: roleBId })
      .expect(201);
  });
});
