import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import {
  futureDateString,
  publishFieldsForFormat,
} from "../../test-utils/eventTestHelpers";
import { assertMissingFields422 } from "../../test-utils/assertions";

describe("Publish necessary fields enforcement", () => {
  let token: string;
  let openedLocal = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test"
      );
      openedLocal = true;
    }
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);

    const admin = {
      ...TEST_REGISTRATION_PROFILE,
      username: "pubadmin",
      email: "pubadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Pub",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;

    await request(app).post("/api/auth/register").send(admin);
    await User.findOneAndUpdate(
      { email: admin.email },
      { isVerified: true, role: "Administrator" }
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: admin.email, password: admin.password });
    token = login.body.data.accessToken;
  });

  afterAll(async () => {
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  it("fails with 422 for Online missing virtual fields", async () => {
    const eventDate = futureDateString();
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Online Missing Virtual",
        type: "Webinar",
        date: eventDate,
        endDate: eventDate,
        time: "09:00",
        endTime: "10:00",
        // Use helper then strip necessary fields to simulate omission
        ...publishFieldsForFormat("Online", "missing"),
        zoomLink: undefined,
        meetingId: undefined,
        passcode: undefined,
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose description for validation without strict failing.",
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    const publish = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    assertMissingFields422(publish, ["zoomLink", "meetingId", "passcode"], {
      format: "Online",
    });
  });

  it("succeeds for Online when all virtual fields present", async () => {
    const eventDate = futureDateString();
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Online Complete",
        type: "Webinar",
        date: eventDate,
        endDate: eventDate,
        time: "09:00",
        endTime: "10:00",
        ...publishFieldsForFormat("Online", "complete"),
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Long enough purpose description for validation without strict failing.",
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    const publish = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(publish.status).toBe(200);
    expect(publish.body.success).toBe(true);
    expect(publish.body.data.slug).toBeTruthy();
  });

  it("fails with 422 for In-person missing location", async () => {
    const eventDate = futureDateString();
    // Create with a valid location first (creation likely enforces non-empty)
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "In Person Missing Location",
        type: "Webinar",
        date: eventDate,
        endDate: eventDate,
        time: "09:00",
        endTime: "10:00",
        ...publishFieldsForFormat("In-person", "inperson"),
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Purpose long enough to satisfy length requirement in strict mode as well.",
        timeZone: "America/Los_Angeles",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    // Clear location to simulate draft losing necessary field before publish
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true, location: "" },
    });
    const publish = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(publish.status).toBe(422);
    expect(publish.body.missing).toEqual(["location"]);
  });

  it("fails with 422 for Hybrid missing subset of necessary fields", async () => {
    const eventDate = futureDateString(31);
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Hybrid Partial",
        type: "Conference",
        date: eventDate,
        endDate: eventDate,
        time: "09:00",
        endTime: "10:00",
        ...publishFieldsForFormat("Hybrid Participation", "hybrid"),
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
        purpose:
          "Purpose long enough to satisfy length requirement in strict mode as well.",
        timeZone: "America/Los_Angeles",
        // Provide only some virtual fields
        zoomLink: "https://example.com/zoom/partial", // keep one valid
        meetingId: " ", // blank triggers missing
        passcode: undefined, // undefined triggers missing
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    const publish = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(publish.status).toBe(422);
    expect(publish.body.missing.sort()).toEqual(
      ["meetingId", "passcode"].sort()
    );
  });
});
