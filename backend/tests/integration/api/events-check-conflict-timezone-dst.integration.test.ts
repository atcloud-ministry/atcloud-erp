import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

/**
 * /events/check-conflict Time Zone + DST Integration Tests
 *
 * Covers:
 * - Cross-time-zone conflict detection (existing event vs. client zone)
 * - DST spring forward (nonexistent local time)
 * - DST fall back (repeated local hour)
 */

// Helper utilities to make tests resilient to the current date
const ymd = (d: Date) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

// US DST rules used by America/Los_Angeles:
// - Spring forward: second Sunday in March
// - Fall back: first Sunday in November
const secondSundayOfMarch = (year: number) => {
  const march1 = new Date(Date.UTC(year, 2, 1));
  const day = march1.getUTCDay(); // 0 = Sun
  const firstSundayDate = 1 + ((7 - day) % 7);
  const secondSundayDate = firstSundayDate + 7;
  return new Date(Date.UTC(year, 2, secondSundayDate));
};

const firstSundayOfNovember = (year: number) => {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const day = nov1.getUTCDay();
  const firstSundayDate = 1 + ((7 - day) % 7);
  return new Date(Date.UTC(year, 10, firstSundayDate));
};

const nextSpringForwardDate = () => {
  const now = new Date();
  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  let y = now.getUTCFullYear();
  let d = secondSundayOfMarch(y);
  if (d < todayUTC) d = secondSundayOfMarch(++y);
  return d;
};

const nextFallBackDate = () => {
  const now = new Date();
  const todayUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  let y = now.getUTCFullYear();
  let d = firstSundayOfNovember(y);
  if (d < todayUTC) d = firstSundayOfNovember(++y);
  return d;
};

describe("GET /api/events/check-conflict (time zones + DST)", () => {
  let adminToken: string;

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    // Create admin user
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "tzadmin",
      email: "tzadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "TZ",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as any;

    await request(app).post("/api/auth/register").send(adminData);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = loginRes.body.data.accessToken;
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  it("detects conflict across different time zones (NY event, LA client)", async () => {
    const futureBaseDate = ymd(daysFromNow(60));
    // Existing event: New York time, 2025-05-10 10:00 - 11:00 ET
    const eventNY = {
      title: "Cross TZ Event NY",
      description: "NY event",
      date: futureBaseDate,
      time: "10:00",
      endTime: "11:00",
      endDate: futureBaseDate,
      timeZone: "America/New_York",
      location: "NYC",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "This is a valid purpose for the NY event.",
      agenda: "This agenda contains sufficient details for testing.",
      organizer: "Organizer Team",
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          maxParticipants: 1,
          description: "host",
        },
      ],
    } as any;

    await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(eventNY)
      .expect(201);

    // Client in Los Angeles checks 07:30 on same date (07:30 PT == 10:30 ET) -> conflict
    const conflictRes = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: futureBaseDate,
        startTime: "07:30",
        mode: "point",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(conflictRes.body).toMatchObject({
      success: true,
      data: { conflict: true },
    });

    // 06:59 PT (09:59 ET) -> no conflict
    const noConflictRes = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: futureBaseDate,
        startTime: "06:59",
        mode: "point",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(noConflictRes.body).toMatchObject({
      success: true,
      data: { conflict: false },
    });
  });

  it("handles DST spring-forward nonexistent local time (LA 02:30) as overlapping when appropriate", async () => {
    const springForward = ymd(nextSpringForwardDate());
    // Existing event in Los Angeles during spring forward day:
    // 2025-03-09 03:00 - 04:00 PT
    const eventLA = {
      title: "LA Spring Forward",
      description: "LA DST start",
      date: springForward,
      time: "03:00",
      endTime: "04:00",
      endDate: springForward,
      timeZone: "America/Los_Angeles",
      location: "Los Angeles",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "This is a valid purpose for the LA spring-forward event.",
      agenda:
        "A detailed agenda that satisfies the minimum length requirement.",
      organizer: "Organizer Team",
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          maxParticipants: 1,
          description: "host",
        },
      ],
    } as any;

    await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(eventLA)
      .expect(201);

    // 02:30 PT does not exist on spring-forward day. Our backend maps wall-clock via timeZone; we
    // expect it to resolve within the event window (effectively ~03:30), thus conflict = true.
    const res = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: springForward,
        startTime: "02:30",
        mode: "point",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(res.body).toMatchObject({ success: true, data: { conflict: true } });
  });

  it("handles DST fall-back repeated hour (LA) correctly", async () => {
    const fallBack = ymd(nextFallBackDate());
    // Event spanning the repeated hour: 00:30 - 02:30 PT on 2025-11-02
    const eventLA = {
      title: "LA Fall Back",
      description: "LA DST end",
      date: fallBack,
      time: "00:30",
      endTime: "02:30",
      endDate: fallBack,
      timeZone: "America/Los_Angeles",
      location: "Los Angeles",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "This is a valid purpose for the LA fall-back event.",
      agenda: "A sufficiently long agenda text to pass validation checks.",
      organizer: "Organizer Team",
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          maxParticipants: 1,
          description: "host",
        },
      ],
    } as any;

    await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(eventLA)
      .expect(201);

    // 01:15 PT should fall within the event regardless of which 01:15 instance (DST or standard)
    const conflict = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: fallBack,
        startTime: "01:15",
        mode: "point",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(conflict.body).toMatchObject({
      success: true,
      data: { conflict: true },
    });

    // After event window
    const after = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: fallBack,
        startTime: "02:45",
        mode: "point",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(after.body).toMatchObject({
      success: true,
      data: { conflict: false },
    });
  });

  it("supports range mode and cross-zone comparisons", async () => {
    const futureBaseDate = ymd(daysFromNow(60));
    // Existing event: New York, 2025-05-10 10:00 - 11:00
    const eventNY = {
      title: "Cross TZ Range NY",
      description: "NY event",
      date: futureBaseDate,
      time: "10:00",
      endTime: "11:00",
      endDate: futureBaseDate,
      timeZone: "America/New_York",
      location: "NYC",
      type: "Effective Communication Workshop",
      format: "In-person",
      purpose: "This is a valid purpose for the NY range event.",
      agenda: "This is a sufficiently detailed agenda for the NY range event.",
      organizer: "Organizer Team",
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          maxParticipants: 1,
          description: "host",
        },
      ],
    } as any;

    await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(eventNY)
      .expect(201);

    // Candidate range in LA overlapping midway (07:45 - 08:15 PT == 10:45 - 11:15 ET) -> conflict
    const overlap = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: futureBaseDate,
        startTime: "07:45",
        endDate: futureBaseDate,
        endTime: "08:15",
        mode: "range",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(overlap.body).toMatchObject({
      success: true,
      data: { conflict: true },
    });

    // Non-overlapping range (05:30 - 06:30 PT == 08:30 - 09:30 ET) -> no conflict
    const clear = await request(app)
      .get("/api/events/check-conflict")
      .query({
        startDate: futureBaseDate,
        startTime: "05:30",
        endDate: futureBaseDate,
        endTime: "06:30",
        mode: "range",
        timeZone: "America/Los_Angeles",
      })
      .expect(200);
    expect(clear.body).toMatchObject({
      success: true,
      data: { conflict: false },
    });
  });
});
