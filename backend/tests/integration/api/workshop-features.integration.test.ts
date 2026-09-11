import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

describe("Workshop features - topics and signup restrictions", () => {
  let adminToken: string;
  let adminId: string;
  let userToken: string;
  let userId: string;
  let leaderToken: string;
  let leaderId: string;
  let eventId: string;
  let roleIds: {
    groupALeader: string;
    groupAParticipants: string;
    zoomHost: string;
  };

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    // Create Administrator
    const adminRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "adm1",
      email: "adm1@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Adm",
      lastName: "One",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    adminId = adminRes.body.data.user.id;
    await User.findOneAndUpdate(
      { email: "adm1@example.com" },
      { role: "Administrator", isVerified: true }
    );
    adminToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "adm1@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Create Participant user
    const userRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "user1",
      email: "user1@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "User",
      lastName: "One",
      role: "Participant",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    userId = userRes.body.data.user.id;
    await User.findOneAndUpdate(
      { email: "user1@example.com" },
      { isVerified: true }
    );
    userToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "user1@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Create another user who will be Group A Leader later
    const leaderRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "lead1",
      email: "lead1@example.com",
      password: "Pass123!@#",
      confirmPassword: "Pass123!@#",
      firstName: "Lead",
      lastName: "One",
      role: "Participant",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    leaderId = leaderRes.body.data.user.id;
    await User.findOneAndUpdate(
      { email: "lead1@example.com" },
      { isVerified: true }
    );
    leaderToken = (
      await request(app)
        .post("/api/auth/login")
        .send({ emailOrUsername: "lead1@example.com", password: "Pass123!@#" })
    ).body.data.accessToken;

    // Create an Effective Communication Workshop event
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Workshop WS",
        description: "desc",
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        time: "09:00",
        endTime: "11:00",
        location: "loc",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Purpose long enough for validation",
        agenda: "This agenda line is longer than twenty chars.",
        organizer: "org",
        roles: [
          {
            id: "a-leader",
            name: "Group A Leader",
            maxParticipants: 1,
            description: "lead",
          },
          {
            id: "a-part",
            name: "Group A Participants",
            maxParticipants: 3,
            description: "members",
          },
          {
            id: "zoom-host",
            name: "Zoom Host",
            maxParticipants: 1,
            description: "host",
          },
        ],
      })
      .expect(201);
    const createdEvent = createRes.body.data.event;
    eventId = createdEvent.id;
    // Map server-assigned role IDs by name
    const createdRoles: Array<{ id: string; name: string }> =
      createdEvent.roles.map((r: any) => ({ id: r.id, name: r.name }));
    const getRoleIdByName = (name: string) =>
      createdRoles.find((r) => r.name === name)?.id as string;
    roleIds = {
      groupALeader: getRoleIdByName("Group A Leader"),
      groupAParticipants: getRoleIdByName("Group A Participants"),
      zoomHost: getRoleIdByName("Zoom Host"),
    };
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  it("Participant can sign up for any workshop role (restrictions removed)", async () => {
    // Previously disallowed role (Zoom Host) now allowed
    const zoomHost = await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId: roleIds.zoomHost })
      .expect(200);
    expect(zoomHost.body.success).toBe(true);

    // Group role still allowed
    const groupAPart = await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ roleId: roleIds.groupAParticipants })
      .expect(200);
    expect(groupAPart.body.success).toBe(true);
  });

  it("Authorized users can update workshop group topic", async () => {
    // First, make leader a Group A Leader by signup
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${leaderToken}`)
      .send({ roleId: roleIds.groupALeader })
      .expect(200);

    // 1) Administrator updates topic
    const res1 = await request(app)
      .post(`/api/events/${eventId}/workshop/groups/A/topic`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ topic: "Alpha Topic" })
      .expect(200);
    expect(res1.body.data.event.workshopGroupTopics.A).toBe("Alpha Topic");

    // 2) Group A Leader updates topic
    const res2 = await request(app)
      .post(`/api/events/${eventId}/workshop/groups/A/topic`)
      .set("Authorization", `Bearer ${leaderToken}`)
      .send({ topic: "Alpha Topic 2" })
      .expect(200);
    expect(res2.body.data.event.workshopGroupTopics.A).toBe("Alpha Topic 2");

    // 3) Unauthorized participant cannot update
    await request(app)
      .post(`/api/events/${eventId}/workshop/groups/B/topic`)
      .set("Authorization", `Bearer ${userToken}`)
      .send({ topic: "Beta" })
      .expect(403);

    // 4) Invalid group
    await request(app)
      .post(`/api/events/${eventId}/workshop/groups/Z/topic`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ topic: "Zeta" })
      .expect(400);
  });

  it("Trims topic and enforces max length validation", async () => {
    // Make leader a Group A Leader by signup
    await request(app)
      .post(`/api/events/${eventId}/signup`)
      .set("Authorization", `Bearer ${leaderToken}`)
      .send({ roleId: roleIds.groupALeader })
      .expect(200);

    // Trimming: leading/trailing spaces are trimmed
    const resTrim = await request(app)
      .post(`/api/events/${eventId}/workshop/groups/A/topic`)
      .set("Authorization", `Bearer ${leaderToken}`)
      .send({ topic: "   Topic With Spaces   " })
      .expect(200);
    expect(resTrim.body.data.event.workshopGroupTopics.A).toBe(
      "Topic With Spaces"
    );

    // Max length: >200 chars should fail validation
    const longTopic = "A".repeat(201);
    const resLong = await request(app)
      .post(`/api/events/${eventId}/workshop/groups/A/topic`)
      .set("Authorization", `Bearer ${leaderToken}`)
      .send({ topic: longTopic })
      .expect(400);
    expect(resLong.body.success).toBe(false);
    expect(resLong.body.message).toMatch(/Invalid topic|Validation/i);
  });
});
