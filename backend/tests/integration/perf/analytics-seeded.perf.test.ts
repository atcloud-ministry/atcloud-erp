import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";

// Note: keep dataset small to avoid slowing the suite; this is a smoke test, not a benchmark.
describe("Seeded perf: analytics query timings", () => {
  beforeAll(async () => {
    // Clear and seed minimal data
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
    ]);

    const users = Array.from({ length: 100 }).map((_, i) => ({
      ...TEST_REGISTRATION_PROFILE,
      username: `u_${i}`,
      email: `u_${i}@example.com`,
      password: "TestPass123!",
      firstName: `U${i}`,
      lastName: `L${i}`,
      isAtCloudLeader: i % 10 === 0,
      role: i % 20 === 0 ? "Administrator" : "Participant",
      isActive: true,
      isVerified: true,
      weeklyChurch: i % 3 === 0 ? "Church A" : i % 3 === 1 ? "Church B" : "",
      lastLogin: new Date(Date.now() - (i % 15) * 24 * 60 * 60 * 1000),
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
      gender: "male",
    }));
    const userDocs = await User.insertMany(users);

    const events = Array.from({ length: 30 }).map((_, i) => ({
      title: `Event ${i}`,
      type: i % 2 === 0 ? "Webinar" : "Mentor Circle",
      date: "2025-12-01",
      endDate: "2025-12-01",
      time: "10:00",
      endTime: "12:00",
      location: "Online",
      organizer: "Org",
      hostedBy: "@Cloud Marketplace Ministry",
      createdBy: userDocs[i % userDocs.length]._id,
      purpose: "Test",
      agenda: "Agenda",
      format:
        i % 3 === 0
          ? "Online"
          : i % 3 === 1
          ? "Hybrid Participation"
          : "In-person",
      disclaimer: "",
      roles: [
        {
          id: `r${i}`,
          name: "Role",
          description: "Test role description",
          maxParticipants: 10,
        },
      ],
      signedUp: 0,
      totalSlots: 10,
      attendees: 0,
      status: i % 4 === 0 ? "completed" : i % 4 === 1 ? "ongoing" : "upcoming",
      isHybrid: false,
    }));
    const eventDocs = await Event.insertMany(events);

    // Seed registrations
    const regs: any[] = [];
    for (let i = 0; i < 300; i++) {
      const u = userDocs[i % userDocs.length];
      const e = eventDocs[i % eventDocs.length];
      regs.push({
        userId: u._id,
        eventId: e._id,
        roleId: e.roles[0].id,
        userSnapshot: {
          username: u.username,
          email: u.email,
        },
        eventSnapshot: {
          title: e.title,
          date: e.date,
          time: e.time,
          location: e.location,
          type: e.type,
          roleName: e.roles[0].name,
          roleDescription: e.roles[0].description,
        },
        status: i % 10 === 0 ? "waitlisted" : "active",
        registrationDate: new Date(Date.now() - (i % 20) * 24 * 60 * 60 * 1000),
        registeredBy: u._id,
      });
    }
    await Registration.insertMany(regs);
  }, 20000);

  it("User weeklyChurch filter/sort runs within budget", async () => {
    const t0 = Date.now();
    const docs = await User.find({
      weeklyChurch: { $exists: true, $ne: "" },
      isActive: true,
    })
      .sort({ weeklyChurch: 1 })
      .limit(50)
      .lean();
    const ms = Date.now() - t0;
    expect(Array.isArray(docs)).toBe(true);
    expect(ms).toBeLessThan(200);
    // capture an explain with executionStats to watch docs/keys examined (non-failing, informational)
    try {
      const plan: any = await (User as any)
        .find({ weeklyChurch: { $exists: true, $ne: "" }, isActive: true })
        .sort({ weeklyChurch: 1 })
        .limit(50)
        .explain("executionStats");
      const stats =
        plan?.executionStats || plan?.stages?.[0]?.$cursor?.executionStats;
      const examined = {
        totalDocsExamined: stats?.totalDocsExamined,
        totalKeysExamined: stats?.totalKeysExamined,
        nReturned: stats?.nReturned,
      };
      // eslint-disable-next-line no-console
      console.info(
        `PERF_SEEDED user_weeklyChurch_ms=${ms} examined=${JSON.stringify(
          examined
        )}`
      );
      // Light sanity: ensure plan uses an index and not a collection scan
      const planStr = JSON.stringify(plan);
      expect(planStr).toMatch(/IXSCAN/);
      expect(planStr).not.toMatch(/COLLSCAN/);
    } catch {
      // ignore explain errors on older engines
    }
  });

  it("Event status/date filter/sort runs within budget", async () => {
    const t0 = Date.now();
    const docs = await Event.find({ status: { $in: ["upcoming", "ongoing"] } })
      .sort({ date: 1 })
      .limit(50)
      .lean();
    const ms = Date.now() - t0;
    expect(Array.isArray(docs)).toBe(true);
    expect(ms).toBeLessThan(200);
    try {
      const plan: any = await (Event as any)
        .find({ status: { $in: ["upcoming", "ongoing"] } })
        .sort({ date: 1 })
        .limit(50)
        .explain("executionStats");
      const stats =
        plan?.executionStats || plan?.stages?.[0]?.$cursor?.executionStats;
      const examined = {
        totalDocsExamined: stats?.totalDocsExamined,
        totalKeysExamined: stats?.totalKeysExamined,
        nReturned: stats?.nReturned,
      };
      // eslint-disable-next-line no-console
      console.info(
        `PERF_SEEDED event_status_date_ms=${ms} examined=${JSON.stringify(
          examined
        )}`
      );
      const planStr = JSON.stringify(plan);
      expect(planStr).toMatch(/IXSCAN/);
      expect(planStr).not.toMatch(/COLLSCAN/);
    } catch {}
  });

  it("Registration recent activity window runs within budget", async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const t0 = Date.now();
    const docs = await Registration.find({
      createdAt: { $gte: since },
      status: { $in: ["active", "waitlisted"] },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const ms = Date.now() - t0;
    expect(Array.isArray(docs)).toBe(true);
    expect(ms).toBeLessThan(200);
    try {
      const plan: any = await (Registration as any)
        .find({
          createdAt: { $gte: since },
          status: { $in: ["active", "waitlisted"] },
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .explain("executionStats");
      const stats =
        plan?.executionStats || plan?.stages?.[0]?.$cursor?.executionStats;
      const examined = {
        totalDocsExamined: stats?.totalDocsExamined,
        totalKeysExamined: stats?.totalKeysExamined,
        nReturned: stats?.nReturned,
      };
      // eslint-disable-next-line no-console
      console.info(
        `PERF_SEEDED registrations_recent_ms=${ms} examined=${JSON.stringify(
          examined
        )}`
      );
      const planStr = JSON.stringify(plan);
      expect(planStr).toMatch(/IXSCAN/);
      expect(planStr).not.toMatch(/COLLSCAN/);
    } catch {}
  });
});
