import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

/**
 * Ensures openToPublic on roles persists through create & update controller paths.
 * Also verifies that toggling openToPublic via update enables publish without direct model mutation.
 */

describe("Public Events API - openToPublic persistence", () => {
  let adminToken: string;
  let eventId: string;
  let openedLocal = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test"
      );
      openedLocal = true;
    }
  });

  afterAll(async () => {
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  beforeEach(async () => {
    console.log("[persistence-test] beforeEach start");
    await User.deleteMany({});
    await Event.deleteMany({});
    console.log("[persistence-test] collections cleared");

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "persistadmin",
      email: "persistadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Persist",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;

    const regRes = await request(app)
      .post("/api/auth/register")
      .send(adminData);
    console.log("[persistence-test] admin register status", regRes.status);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    console.log("[persistence-test] admin elevated");
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    console.log("[persistence-test] login status", loginRes.status);
    adminToken = loginRes.body.data.accessToken;
    console.log("[persistence-test] beforeEach complete");
  });

  it("persists openToPublic on create and update, enabling publish", async () => {
    // Dynamic future date to avoid failing when hardcoded date passes
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const futureDate = `${future.getFullYear()}-${String(
      future.getMonth() + 1
    ).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;

    // 1. Create event with one role explicitly openToPublic true and one false
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Persistence Event",
        type: "Webinar",
        date: futureDate,
        endDate: futureDate,
        time: "10:00",
        endTime: "11:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [
          {
            name: "Public Role",
            description: "Desc",
            maxParticipants: 10,
            openToPublic: true,
          },
          {
            name: "Hidden Role",
            description: "Desc",
            maxParticipants: 5,
            openToPublic: false,
          },
        ],
        purpose: "Testing persistence with sufficient length for publish.",
        zoomLink: "https://example.com/zoom/persist",
        meetingId: "XYZ123",
        passcode: "persist",
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });
    if (createRes.status !== 201) {
      // eslint-disable-next-line no-console
      console.log(
        "[persistence-test] create response body",
        JSON.stringify(createRes.body, null, 2)
      );
    }
    expect(createRes.status).toBe(201);
    const created = createRes.body?.data?.event;
    expect(created?.roles?.length).toBe(2);
    const publicRoleResp = created.roles.find(
      (r: any) => r.name === "Public Role"
    );
    const hiddenRoleResp = created.roles.find(
      (r: any) => r.name === "Hidden Role"
    );
    expect(publicRoleResp?.openToPublic).toBe(true);
    expect(hiddenRoleResp?.openToPublic).toBe(false);
    eventId = created.id || created._id;

    // 2. Fetch from DB to ensure persistence
    const persisted: any = await Event.findById(eventId).lean();
    const prDb = persisted.roles.find((r: any) => r.name === "Public Role");
    const hrDb = persisted.roles.find((r: any) => r.name === "Hidden Role");
    expect(prDb?.openToPublic).toBe(true);
    expect(hrDb?.openToPublic).toBe(false);

    // 3. Update: flip flags (public -> false, hidden -> true)
    const updateRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: prDb.id,
            name: "Public Role",
            description: "Desc",
            maxParticipants: 10,
            openToPublic: false,
          },
          {
            id: hrDb.id,
            name: "Hidden Role",
            description: "Desc",
            maxParticipants: 5,
            openToPublic: true,
          },
        ],
        suppressNotifications: true,
      });
    expect(updateRes.status).toBe(200);
    const updated = updateRes.body?.data?.event;
    const prUpdated = updated.roles.find((r: any) => r.name === "Public Role");
    const hrUpdated = updated.roles.find((r: any) => r.name === "Hidden Role");
    expect(prUpdated?.openToPublic).toBe(false);
    expect(hrUpdated?.openToPublic).toBe(true);

    // 4. Publish should now succeed
    const publishRes = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send();
    expect(publishRes.status).toBe(200);
    expect(publishRes.body?.data?.slug).toBeTruthy();
  });
});
