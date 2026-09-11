import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";

// Ensure detailed validation info if needed
process.env.TEST_VALIDATION_LOG = "1";

async function bootstrapAdminAndEvent() {
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
  } as const;

  await request(app).post("/api/auth/register").send(adminData);
  await User.findOneAndUpdate(
    { email: adminData.email },
    { isVerified: true, role: "Administrator" }
  );
  const loginRes = await request(app).post("/api/auth/login").send({
    emailOrUsername: adminData.email,
    password: adminData.password,
  });
  const adminToken = loginRes.body.data.accessToken as string;

  const eventRes = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      title: "Guest Phone Clear Test",
      description: "Event for guest phone clearing",
      date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0],
      time: "15:00",
      endTime: "16:00",
      location: "Test Location",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "",
      agenda:
        "Intro, main content, discussion, Q&A, and closing remarks for testing.",
      organizer: "Tester",
      maxParticipants: 50,
      category: "general",
      roles: [
        {
          name: "Zoom Host",
          maxParticipants: 2,
          description: "Guest attendee",
        },
      ],
    })
    .expect(201);

  const createdEvent = eventRes.body.data.event;
  const eventId = createdEvent.id || createdEvent._id;
  const roleId = (createdEvent.roles || []).find(
    (r: any) => r.name === "Zoom Host"
  )?.id as string;
  expect(roleId).toBeTruthy();
  return { adminToken, eventId, roleId };
}

describe("Guests API - clearing phone on update", () => {
  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  it("allows admin update to clear phone using empty string", async () => {
    const { adminToken, eventId, roleId } = await bootstrapAdminAndEvent();

    // Create guest with a phone
    const signupRes = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId,
        fullName: "John Doe",
        gender: "male",
        email: "john.doe@example.com",
        phone: "+1 555 888 9999",
      })
      .expect(201);

    const registrationId = signupRes.body?.data?.registrationId as string;
    expect(registrationId).toBeTruthy();

    // Admin clears the phone by sending empty string
    await request(app)
      .put(`/api/events/${eventId}/manage/guests/${registrationId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ phone: "" })
      .expect(200);

    const doc = await GuestRegistration.findById(registrationId).lean();
    expect(doc).toBeTruthy();
    expect(doc?.phone === undefined || doc?.phone === "").toBe(true);
  });

  it("allows token-based update to clear phone using empty string", async () => {
    const { eventId, roleId } = await bootstrapAdminAndEvent();

    // Create guest with a phone to get manage token
    const signupRes = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId,
        fullName: "Jane Doe",
        gender: "female",
        email: "jane.clear@example.com",
        phone: "+1 555 222 3333",
      })
      .expect(201);

    const manageToken = signupRes.body?.data?.manageToken as string;
    const registrationId = signupRes.body?.data?.registrationId as string;
    expect(manageToken).toBeTruthy();
    expect(registrationId).toBeTruthy();

    // Token-based update to clear phone
    await request(app)
      .put(`/api/guest/manage/${manageToken}`)
      .send({ phone: "" })
      .expect(200);

    const doc = await GuestRegistration.findById(registrationId).lean();
    expect(doc).toBeTruthy();
    expect(doc?.phone === undefined || doc?.phone === "").toBe(true);
  });
});
