import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, beforeAll, afterAll, expect } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

async function createAdmin() {
  const admin = {
    ...TEST_REGISTRATION_PROFILE,
    username: "listadmin",
    email: "listadmin@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "List",
    lastName: "Admin",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
  } as const;
  await request(app).post("/api/auth/register").send(admin);
  // Force elevate to Administrator + verified; registration path may not honor provided role field
  await User.findOneAndUpdate(
    { email: admin.email },
    { isVerified: true, role: "Administrator" }
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: admin.email, password: admin.password });
  return login.body.data.accessToken as string;
}

async function createPublished(
  token: string,
  title: string,
  type = "Webinar",
  date = "2099-01-01"
) {
  const create = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title,
      type,
      date,
      endDate: date,
      time: "10:00",
      endTime: "11:00",
      location: "Online",
      format: "Online",
      organizer: "Org",
      roles: [{ name: "Attendee", description: "Desc", maxParticipants: 5 }],
      purpose:
        "This is a long enough description to satisfy the publish validation requirement for listing tests.",
      zoomLink: "https://example.com/zoom/list",
      meetingId: "LIST123",
      passcode: "list",
      timeZone: "America/Los_Angeles",
      suppressNotifications: true,
    });

  // Handle both response structures: data.event or just data
  const eventId = create.body.data?.event?.id || create.body.data?.id;
  if (!eventId) {
    throw new Error(
      `Failed to create event. Status: ${create.status}, Body: ${JSON.stringify(
        create.body
      )}`
    );
  }

  await Event.findByIdAndUpdate(eventId, {
    $set: { "roles.0.openToPublic": true },
  });
  const pub = await request(app)
    .post(`/api/events/${eventId}/publish`)
    .set("Authorization", `Bearer ${token}`)
    .send();
  return { eventId, slug: pub.body.data.slug };
}

describe("Public events listing", () => {
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
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);
  });

  it("returns paginated list and supports ETag 304", async () => {
    const token = await createAdmin();
    await createPublished(token, "Event A");
    await createPublished(token, "Event B");

    const first = await request(app).get("/api/public/events");
    expect(first.status).toBe(200);
    expect(first.body.data.items.length).toBeGreaterThanOrEqual(2);
    const etag = first.headers["etag"]; // Weak ETag
    expect(etag).toBeTruthy();

    const second = await request(app)
      .get("/api/public/events")
      .set("If-None-Match", etag);
    expect(second.status).toBe(304);
  });

  it("applies type filter and pagination", async () => {
    const token = await createAdmin();
    await createPublished(token, "Webinar 1", "Webinar", "2099-11-02");
    await createPublished(token, "Conference 1", "Conference", "2099-11-03");

    const webinarOnly = await request(app).get(
      "/api/public/events?type=Webinar&page=1&pageSize=1"
    );
    expect(webinarOnly.status).toBe(200);
    expect(webinarOnly.body.data.items.length).toBe(1);
    expect(webinarOnly.body.data.total).toBeGreaterThanOrEqual(1);
  });

  it("invalidates cache after publishing new event", async () => {
    const token = await createAdmin();
    await createPublished(token, "Early Event");
    const list1 = await request(app).get("/api/public/events");
    const total1 = list1.body.data.total;

    await createPublished(token, "Later Event");
    // New listing should reflect new total (due to version bump invalidation)
    const list2 = await request(app).get("/api/public/events");
    const total2 = list2.body.data.total;
    expect(total2).toBeGreaterThan(total1);
  });

  it("filters out completed events from public listing", async () => {
    const token = await createAdmin();

    // Create a future event (should appear)
    const futureEvent = await createPublished(
      token,
      "Future Event",
      "Webinar",
      "2099-12-01"
    );

    // Create another event with future date, then mark it as completed (should NOT appear)
    const pastEvent = await createPublished(
      token,
      "Past Event",
      "Webinar",
      "2099-11-15"
    );
    // Manually mark the event as completed to simulate a past event
    await Event.findByIdAndUpdate(pastEvent.eventId, { status: "completed" });

    const list = await request(app).get("/api/public/events");
    expect(list.status).toBe(200);

    const titles = list.body.data.items.map(
      (item: { title: string }) => item.title
    );
    expect(titles).toContain("Future Event");
    expect(titles).not.toContain("Past Event");
  });
});
