import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

// Helper to register/login a user
async function registerAndLogin(opts: {
  username: string;
  email: string;
  password?: string;
  role?: string;
}) {
  const password = opts.password || "TestPass123!";
  const regRes = await request(app).post("/api/auth/register").send({
    ...TEST_REGISTRATION_PROFILE,
    username: opts.username,
    email: opts.email,
    password,
    confirmPassword: password,
    firstName: "T",
    lastName: "U",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
  });
  if (regRes.status !== 201) {
    throw new Error(
      `Registration failed: ${regRes.status} ${JSON.stringify(regRes.body)}`
    );
  }

  // verify and set role if provided
  await User.findOneAndUpdate(
    { email: opts.email },
    { isVerified: true, ...(opts.role ? { role: opts.role } : {}) }
  );

  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: opts.email, password })
    .expect(200);

  return {
    token: loginRes.body.data.accessToken as string,
  };
}

describe("POST /api/events/:id/email", () => {
  // Collections cleanup before each test (connection handled by global integration setup)
  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
    await GuestRegistration.deleteMany({});
    vi.restoreAllMocks();
  });

  it("requires authentication", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post(`/api/events/${fakeId}/email`)
      .send({ subject: "s", bodyHtml: "<b>Hi</b>" })
      .expect(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects unauthorized user (not admin/creator/organizer)", async () => {
    // Organizer creates event doc directly (creator different from caller)
    const organizer = await registerAndLogin({
      username: "org1",
      email: "org1@example.com",
      role: "Leader",
    });
    const organizerUser = await User.findOne({ email: "org1@example.com" });

    const event = await Event.create({
      title: "E",
      type: "Effective Communication Workshop",
      date: "2099-12-31",
      endDate: "2099-12-31",
      time: "10:00",
      endTime: "11:00",
      location: "Loc",
      organizer: "Org",
      organizerDetails: [
        {
          userId: organizerUser!._id,
          name: "Org Person",
          role: "Organizer",
          email: "org1@example.com",
          phone: "1234567890",
          gender: "male",
        },
      ],
      createdBy: organizerUser!._id,
      purpose: "p",
      format: "In-person",
      roles: [
        { id: "role-1", name: "Role1", description: "d", maxParticipants: 10 },
      ],
    });

    // Random participant tries
    const user = await registerAndLogin({
      username: "user1",
      email: "u1@example.com",
      role: "Participant",
    });

    const res = await request(app)
      .post(`/api/events/${event.id}/email`)
      .set("Authorization", `Bearer ${user.token}`)
      .send({ subject: "s", bodyHtml: "<b>Hi</b>" })
      .expect(403);
    expect(res.body.success).toBe(false);
  });

  it("validates required fields and event existence", async () => {
    const admin = await registerAndLogin({
      username: "admin",
      email: "admin@example.com",
      role: "Administrator",
    });

    const fakeId = new mongoose.Types.ObjectId().toString();
    await request(app)
      .post(`/api/events/${fakeId}/email`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ subject: "s" })
      .expect(400);

    await request(app)
      .post(`/api/events/${fakeId}/email`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ subject: "s", bodyHtml: "<p>x</p>" })
      .expect(404);
  });

  it("sends to unique recipients across users and guests with reply-to to primary organizer", async () => {
    // Create organizer (Leader) who owns event
    const orgLogin = await registerAndLogin({
      username: "orgA",
      email: "orgA@example.com",
      role: "Leader",
    });
    const orgUser = await User.findOne({ email: "orgA@example.com" });

    // Create two users who will sign up
    const u1 = await registerAndLogin({
      username: "p001",
      email: "dup@example.com",
      role: "Participant",
    });
    const u2 = await registerAndLogin({
      username: "p002",
      email: "unique@example.com",
      role: "Participant",
    });

    // Event with a role; createdBy organizer, primary organizerDetails[0]
    const event = await Event.create({
      title: "Email Test",
      type: "Webinar",
      date: "2099-11-20",
      endDate: "2099-11-20",
      time: "09:00",
      endTime: "10:00",
      location: "Loc",
      organizer: "Org",
      organizerDetails: [
        {
          userId: orgUser!._id,
          name: "Primary Org",
          role: "Organizer",
          email: "orgA@example.com",
          phone: "1234567890",
          gender: "male",
        },
      ],
      createdBy: orgUser!._id,
      purpose: "p",
      format: "In-person",
      roles: [
        {
          id: "role-1",
          name: "Common Participant (Zoom)",
          description: "d",
          maxParticipants: 10,
        },
      ],
    });

    // Sign up both users via API to create Registration with snapshots
    await request(app)
      .post(`/api/events/${event.id}/signup`)
      .set("Authorization", `Bearer ${u1.token}`)
      .send({ roleId: "role-1" })
      .expect(200);
    await request(app)
      .post(`/api/events/${event.id}/signup`)
      .set("Authorization", `Bearer ${u2.token}`)
      .send({ roleId: "role-1" })
      .expect(200);

    // Add a guest with a different email (system forbids guest email matching an existing user account)
    await request(app)
      .post(`/api/events/${event.id}/guest-signup`)
      .send({
        roleId: "role-1",
        fullName: "Guest D",
        gender: "male",
        email: "guest.unique@example.com",
        phone: "1234567890",
      })
      .expect(201);

    // Spy on EmailService to ensure replyTo and count
    const spy = vi.spyOn(EmailService, "sendEmail").mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/events/${event.id}/email`)
      .set("Authorization", `Bearer ${orgLogin.token}`)
      .send({ subject: "Hello", bodyHtml: "<p>Message</p>" })
      .expect(200);

    expect(res.body).toMatchObject({
      success: true,
      recipientCount: 3,
      sent: 3,
    });

    // 3 unique recipients: dup@example.com, unique@example.com, guest.unique@example.com
    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) {
      const args = call[0] as any;
      // Backend may normalize email casing; compare case-insensitively
      const expectedReplyTo = "Primary Org <orgA@example.com>";
      expect((args.replyTo as string).toLowerCase()).toBe(
        expectedReplyTo.toLowerCase()
      );
      expect([
        "dup@example.com",
        "unique@example.com",
        "guest.unique@example.com",
      ]).toContain(args.to);
    }
  });

  it("respects include flags (users only)", async () => {
    const orgLogin = await registerAndLogin({
      username: "orgB",
      email: "orgB@example.com",
      role: "Leader",
    });
    const orgUser = await User.findOne({ email: "orgB@example.com" });
    const part = await registerAndLogin({
      username: "p003",
      email: "person@example.com",
      role: "Participant",
    });

    const event = await Event.create({
      title: "Email Test 2",
      type: "Webinar",
      date: "2099-11-21",
      endDate: "2099-11-21",
      time: "09:00",
      endTime: "10:00",
      location: "Loc",
      organizer: "Org",
      organizerDetails: [
        {
          userId: orgUser!._id,
          name: "Org B",
          role: "Organizer",
          email: "orgB@example.com",
          phone: "1234567890",
          gender: "male",
        },
      ],
      createdBy: orgUser!._id,
      purpose: "p",
      format: "In-person",
      roles: [
        {
          id: "role-1",
          name: "Common Participant (Zoom)",
          description: "d",
          maxParticipants: 10,
        },
      ],
    });

    await request(app)
      .post(`/api/events/${event.id}/signup`)
      .set("Authorization", `Bearer ${part.token}`)
      .send({ roleId: "role-1" })
      .expect(200);

    await request(app)
      .post(`/api/events/${event.id}/guest-signup`)
      .send({
        roleId: "role-1",
        fullName: "Guest X",
        gender: "male",
        email: "guest.only@example.com",
        phone: "1234567890",
      })
      .expect(201);

    const spy = vi.spyOn(EmailService, "sendEmail").mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/events/${event.id}/email`)
      .set("Authorization", `Bearer ${orgLogin.token}`)
      .send({
        subject: "Hello",
        bodyHtml: "<p>Message</p>",
        includeGuests: false,
        includeUsers: true,
      })
      .expect(200);

    expect(res.body).toMatchObject({
      success: true,
      recipientCount: 1,
      sent: 1,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ to: "person@example.com" });
  });

  it("returns success with 0 recipients when none found", async () => {
    const admin = await registerAndLogin({
      username: "admin2",
      email: "admin2@example.com",
      role: "Administrator",
    });

    const event = await Event.create({
      title: "Empty",
      type: "Effective Communication Workshop",
      date: "2099-10-10",
      endDate: "2099-10-10",
      time: "10:00",
      endTime: "11:00",
      location: "Loc",
      organizer: "Org",
      organizerDetails: [
        {
          name: "Admin Primary",
          role: "Organizer",
          email: "admin2@example.com",
          phone: "1234567890",
          gender: "male",
        },
      ],
      createdBy: (await User.findOne({ email: "admin2@example.com" }))!._id,
      purpose: "p",
      format: "In-person",
      roles: [
        { id: "role-1", name: "Role1", description: "d", maxParticipants: 10 },
      ],
    });

    const spy = vi.spyOn(EmailService, "sendEmail").mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/events/${event.id}/email`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ subject: "None", bodyHtml: "<p>Empty</p>" })
      .expect(200);

    expect(res.body).toMatchObject({
      success: true,
      recipientCount: 0,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 0 recipients when both include flags are false (explicit flags)", async () => {
    const admin = await registerAndLogin({
      username: "admin3",
      email: "admin3@example.com",
      role: "Administrator",
    });

    const event = await Event.create({
      title: "Flag Combo",
      type: "Webinar",
      date: "2099-09-09",
      endDate: "2099-09-09",
      time: "09:00",
      endTime: "10:00",
      location: "Loc",
      organizer: "Org",
      organizerDetails: [
        {
          name: "Admin Primary",
          role: "Organizer",
          email: "admin3@example.com",
          phone: "1234567890",
          gender: "male",
        },
      ],
      createdBy: (await User.findOne({ email: "admin3@example.com" }))!._id,
      purpose: "p",
      format: "In-person",
      roles: [
        { id: "role-1", name: "Role1", description: "d", maxParticipants: 10 },
      ],
    });

    // No registrations or guests added. Both include flags false => should short-circuit with 0 recipients.
    const spy = vi.spyOn(EmailService, "sendEmail").mockResolvedValue(true);
    const res = await request(app)
      .post(`/api/events/${event.id}/email`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        subject: "None",
        bodyHtml: "<p>None</p>",
        includeGuests: false,
        includeUsers: false,
      })
      .expect(200);

    expect(res.body).toMatchObject({
      success: true,
      recipientCount: 0,
      sent: 0,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
