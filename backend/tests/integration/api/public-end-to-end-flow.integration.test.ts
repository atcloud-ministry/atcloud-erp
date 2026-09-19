import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import AuditLog from "../../../src/models/AuditLog";

// Helper to fetch raw metrics lines
async function fetchMetrics() {
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  return res.text.split("\n");
}

function getCounterValue(
  lines: string[],
  metric: string,
  labelFilter?: (l: string) => boolean
): number {
  const candidates = lines.filter((l) => l.startsWith(metric));
  if (!candidates.length) return 0;
  if (!labelFilter) {
    // pick simple no-label line first
    const plain = candidates.find((c) => c.startsWith(metric + " "));
    if (plain) {
      const parts = plain.split(/\s+/);
      return Number(parts[1]) || 0;
    }
  }
  const line = candidates.find(labelFilter!);
  if (!line) return 0;
  const parts = line.split(/\s+/);
  return Number(parts[parts.length - 1]) || 0;
}

/**
 * End-to-end public lifecycle flow
 * Steps:
 * 1. Register + verify admin user
 * 2. Create draft event with open public role requirements satisfied
 * 3. Publish event (captures slug)
 * 4. Create short link for event
 * 5. Redirect via short link (302) -> ensures redirect counter increments
 * 6. Public registration (guest) -> ensures attempt counter increments & audit log
 * 7. Assert metrics deltas & audit logs existence
 */

describe("Public end-to-end publish→redirect→register flow", () => {
  let token: string;
  let eventId: string;
  let slug: string;
  let shortKey: string;

  let openedLocal = false;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test"
      );
      openedLocal = true;
    }
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      AuditLog.deleteMany({}),
    ]);

    const admin = {
      ...TEST_REGISTRATION_PROFILE,
      username: "flowadmin",
      email: "flowadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Flow",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;

    await request(app).post("/api/auth/register").send(admin);
    // Force elevate to Administrator + verified (registration may ignore provided role field)
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

  it("runs the full chain and asserts metrics + audit logs", async () => {
    const metricsBefore = await fetchMetrics();
    const attemptsBefore = getCounterValue(
      metricsBefore,
      "registration_attempts_total"
    );
    const redirectsBefore = getCounterValue(
      metricsBefore,
      "short_link_redirect_total",
      (l) => l.includes('status="active"')
    );
    const createdShortBefore = getCounterValue(
      metricsBefore,
      "short_link_created_total"
    );

    // 2. Create event with future date to ensure short link doesn't expire
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7); // 7 days from now
    const futureDateStr = futureDate.toISOString().split("T")[0]; // YYYY-MM-DD

    const create = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "E2E Flow Event",
        type: "Webinar",
        date: futureDateStr,
        endDate: futureDateStr,
        time: "09:00",
        endTime: "10:00",
        location: "Online",
        format: "Online",
        organizer: "Org",
        roles: [{ name: "Attendee", description: "Desc", maxParticipants: 3 }],
        purpose:
          "This purpose description is long enough to satisfy publish validation length threshold.",
        timeZone: "America/Los_Angeles",
        zoomLink: "https://example.com/zoom/e2e",
        meetingId: "987-654-321",
        passcode: "e2epass",
        suppressNotifications: true,
      });
    expect(create.status).toBe(201);
    eventId = create.body.data.event.id;

    // Make role public
    await Event.findByIdAndUpdate(eventId, {
      $set: { "roles.0.openToPublic": true },
    });

    // 3. Publish
    const publish = await request(app)
      .post(`/api/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(publish.status).toBe(200);
    slug = publish.body.data.slug;
    expect(slug).toBeTruthy();

    // 4. Create short link (assuming endpoint exists)
    const shortRes = await request(app)
      .post(`/api/events/${eventId}/shortlink`)
      .set("Authorization", `Bearer ${token}`)
      .send();
    expect(shortRes.status).toBeGreaterThanOrEqual(200);
    expect(shortRes.status).toBeLessThan(300);
    shortKey = shortRes.body.data.key;
    expect(shortKey).toBeTruthy();

    // 5. Redirect via short link
    const redirect = await request(app).get(`/s/${shortKey}`).redirects(0);
    expect(redirect.status).toBe(302);
    const loc = redirect.headers["location"];
    expect(loc).toContain(`/#/p/${slug}`);

    // 6. Public registration
    const eventDoc: any = await Event.findById(eventId).lean();
    const roleId = eventDoc.roles[0].id;
    const reg = await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: { name: "Guest User", email: "guest.flow@example.com" },
        consent: { termsAccepted: true },
      });
    expect(reg.status).toBe(200);

    // 7. Metrics after
    const metricsAfter = await fetchMetrics();
    const attemptsAfter = getCounterValue(
      metricsAfter,
      "registration_attempts_total"
    );
    const redirectsAfter = getCounterValue(
      metricsAfter,
      "short_link_redirect_total",
      (l) => l.includes('status="active"')
    );
    const createdShortAfter = getCounterValue(
      metricsAfter,
      "short_link_created_total"
    );

    expect(attemptsAfter).toBeGreaterThanOrEqual(attemptsBefore + 1);
    expect(redirectsAfter).toBeGreaterThanOrEqual(redirectsBefore + 1);
    // short link created may increment by at least 1
    expect(createdShortAfter).toBeGreaterThanOrEqual(createdShortBefore + 1);

    // 8. Audit logs
    const publishLog = await AuditLog.findOne({
      action: /EventPublished/i,
      "metadata.eventId": eventId,
    });
    expect(publishLog).not.toBeNull();
    const regLog = await AuditLog.findOne({
      action: /PublicRegistrationCreated/i,
      "metadata.eventId": eventId,
    });
    expect(regLog).not.toBeNull();
  });
});
