import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Mentor Circle – Attendee eligibility (Participant & Guest)

 * Ensures a Participant user and a Guest can sign up for the "Attendee" role
 * on Mentor Circle events.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import { ensureIntegrationDB } from "../setup/connect";

// Happy-path tests verifying newly allowed eligibility
// (No need to test unrelated failure modes here; those are covered elsewhere.)
describe("Mentor Circle – Attendee eligibility (Participant & Guest)", () => {
  let userToken: string;
  let userId: string;
  let eventId: string;
  let attendeeRoleId: string;

  beforeAll(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
    await GuestRegistration.deleteMany({});

    // Register & verify Participant user
    const userRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "mc_mentees_user",
      email: "mc_mentees_user@example.com",
      password: "StrongPass123!",
      confirmPassword: "StrongPass123!",
      firstName: "MC",
      lastName: "User",
      role: "Participant",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    });
    userId = userRes.body.data.user.id;
    await User.findByIdAndUpdate(userId, { isVerified: true });

    const loginRes = await request(app).post("/api/auth/login").send({
      emailOrUsername: "mc_mentees_user@example.com",
      password: "StrongPass123!",
    });
    userToken = loginRes.body.data.accessToken;

    // Create Mentor Circle event with Attendee role
    attendeeRoleId = "role-attendee";
    const event = await Event.create({
      title: "Mentor Circle – Attendee Eligibility",
      description: "Ensure Participant & Guest can sign up as Attendee",
      date: new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0],
      time: "10:00",
      endTime: "11:00",
      location: "HQ",
      type: "Mentor Circle",
      format: "In-person",
      purpose: "Eligibility test",
      organizer: "QA",
      createdBy: userId,
      roles: [
        {
          id: attendeeRoleId,
          name: "Attendee",
          maxParticipants: 30,
          description: "No special role",
        },
      ],
      status: "upcoming",
    } as any);
    eventId = (event as any)._id.toString();
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    await Registration.deleteMany({});
    await GuestRegistration.deleteMany({});
    // Don't always close globally shared connection; only if this test bootstrapped it and no other tests are running
    if (
      mongoose.connection.readyState === 1 &&
      process.env.VITEST_SCOPE !== "integration"
    ) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  it("allows Participant to sign up for Mentor Circle Attendee", async () => {
    const res = await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        roleId: attendeeRoleId,
      })
      .expect(200);

    expect(res.body?.success).toBe(true);
    const eventRes = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);
    const attendeeRole = eventRes.body?.data?.event?.roles?.find(
      (r: any) => r.id === attendeeRoleId
    );
    expect(attendeeRole).toBeTruthy();
    expect(
      attendeeRole.registrations?.some((r: any) => r.userId === userId)
    ).toBe(true);
  });

  it("allows Guest to sign up for Mentor Circle Attendee", async () => {
    const guestRes = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send({
        roleId: attendeeRoleId,
        fullName: "Guest User",
        gender: "female",
        email: "guest.attendee@example.com",
        phone: "1234567890",
      });

    expect([200, 201]).toContain(guestRes.status);
    expect(guestRes.body?.success).toBe(true);

    // Fetch event as authenticated user to inspect merged guests
    const eventRes = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${userToken}`)
      .expect(200);

    const attendeeRole = eventRes.body?.data?.event?.roles?.find(
      (r: any) => r.id === attendeeRoleId
    );
    expect(attendeeRole).toBeTruthy();

    // Verify guest registration persisted directly via GuestRegistration model
    const guestRecord = await GuestRegistration.findOne({
      eventId,
      roleId: attendeeRoleId,
      email: "guest.attendee@example.com",
    });
    expect(guestRecord).toBeTruthy();
  });
});
