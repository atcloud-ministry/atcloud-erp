import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";

/**
 * Regression test: Organizer should be able to assign a Participant user
 * to Webinar roles that are explicitly open to Participants (Attendee + Breakout Room Leads).
 */
describe("Webinar participant assignment (regression)", () => {
  let adminToken: string;
  let adminId: string;
  let participantId: string;
  let eventId: string;

  const uniq = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const adminEmail = `wp.admin.${uniq}@example.com`;
  const adminUsername = `wpa_${uniq.slice(0, 8)}`;
  const participantEmail = `wp.part.${uniq}@example.com`;
  const participantUsername = `wpp_${uniq.slice(0, 8)}`;

  beforeAll(async () => {
    // Create admin
    const regAdmin = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        firstName: "Admin",
        lastName: "User",
        email: adminEmail,
        username: adminUsername,
        password: "AdminPass123!",
        confirmPassword: "AdminPass123!",
        gender: "male",
        isAtCloudLeader: false,
        acceptTerms: true,
      })
      .expect(201);
    adminId = regAdmin.body.data.user.id;
    await User.findByIdAndUpdate(adminId, {
      isVerified: true,
      role: "Administrator",
    });
    const loginAdmin = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminEmail, password: "AdminPass123!" });
    adminToken = loginAdmin.body.data.accessToken as string;

    // Create participant
    const regPart = await request(app)
      .post("/api/auth/register")
      .send({
        ...TEST_REGISTRATION_PROFILE,
        firstName: "Pat",
        lastName: "Icipant",
        email: participantEmail,
        username: participantUsername,
        password: "PartPass123!",
        confirmPassword: "PartPass123!",
        gender: "female",
        isAtCloudLeader: false,
        acceptTerms: true,
      })
      .expect(201);
    participantId = regPart.body.data.user.id;
    await User.findByIdAndUpdate(participantId, {
      isVerified: true,
      role: "Participant",
    });
  });

  afterAll(async () => {
    await User.deleteMany({
      _id: { $in: [adminId, participantId].filter(Boolean) },
    } as any);
  });

  it("allows organizer to assign participant to Attendee + Breakout Room Lead Webinar roles", async () => {
    // Create a Webinar event with Attendee + one Breakout role
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Webinar Assignment Test",
        description: "Desc",
        date: new Date(Date.now() + 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "19:00",
        endTime: "20:00",
        type: "Webinar",
        format: "Online",
        location: "Zoom",
        agenda: "This is a valid agenda with sufficient length for validation.",
        organizer: "Org",
        purpose: "Purpose text that is sufficiently long.",
        roles: [
          {
            id: "r1",
            name: "Attendee",
            maxParticipants: 50,
            description: "General",
          },
          {
            id: "r2",
            name: "Breakout Room Leads for E Circle",
            maxParticipants: 5,
            description: "Lead",
          },
        ],
      })
      .expect(201);
    eventId = createRes.body.data.event.id;

    const attendeeRoleId = createRes.body.data.event.roles[0].id as string;
    const breakoutRoleId = createRes.body.data.event.roles[1].id as string;

    // Assign participant to Attendee
    const assignAttendee = await request(app)
      .post(`/api/events/${eventId}/manage/assign-user`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: participantId, roleId: attendeeRoleId })
      .expect(200);
    expect(assignAttendee.body.success).toBe(true);

    // Assign participant to Breakout Room Leads role
    const assignBreakout = await request(app)
      .post(`/api/events/${eventId}/manage/assign-user`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: participantId, roleId: breakoutRoleId })
      .expect(200);
    expect(assignBreakout.body.success).toBe(true);
  });
});
