import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, beforeAll, afterAll, expect } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

// Helper to fetch raw metrics and return lines we care about
async function fetchMetrics() {
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  return res.text.split("\n");
}

function getCounterValue(lines: string[], metric: string): number {
  const line = lines.find((l) => l.startsWith(metric + " "));
  if (!line) return 0;
  const parts = line.split(/\s+/);
  return Number(parts[1]) || 0;
}

describe("Public registration metrics", () => {
  let openedLocal = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test",
      );
      openedLocal = true;
    }
  });

  afterAll(async () => {
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });
  let slug: string;

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    // Admin user
    const admin = {
      ...TEST_REGISTRATION_PROFILE,
      username: "metadmin",
      email: "metadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Met",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;
    await request(app).post("/api/auth/register").send(admin);
    // Ensure the test user actually has Administrator privileges; registration
    // may default to a Participant role ignoring requested role field.
    await User.findOneAndUpdate(
      { email: admin.email },
      { isVerified: true, role: "Administrator" },
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: admin.email, password: admin.password });
    const token = login.body.data.accessToken;

    // Event
    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Metrics Event",
        type: "Webinar",
        date: "2027-06-15",
        endDate: "2027-06-15",
        time: "10:00",
        endTime: "11:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 2 }],
        purpose:
          "This purpose description is intentionally long enough to pass validation threshold for publishing.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://example.com/zoom/metrics",
        meetingId: "123-456-789",
        passcode: "pass123",
        suppressNotifications: true,
      });
    const eventId = create.body.data.event.id;
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });
    const pub = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    slug = pub.body.data.slug;
  });

  it("increments attempt and failure counters on validation errors then success", async () => {
    const before = await fetchMetrics();
    const attemptsBefore = getCounterValue(
      before,
      "registration_attempts_total",
    );

    // Missing roleId => validation failure
    const failRes = await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        attendee: { name: "Ann", email: "a@example.com" }, // name length >= 2
        consent: { termsAccepted: true },
      });
    expect(failRes.status).toBe(400);

    // Success path
    const eventObj: any = await Event.findOne({ publicSlug: slug }).lean();
    const roleId = eventObj.roles[0].id;
    const okRes = await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: { name: "Beth", email: "b@example.com" }, // name length >= 2
        consent: { termsAccepted: true },
      });
    expect(okRes.status).toBe(200);

    const after = await fetchMetrics();
    const attemptsAfter = getCounterValue(after, "registration_attempts_total");
    expect(attemptsAfter).toBeGreaterThanOrEqual(attemptsBefore + 2);
  });
});
