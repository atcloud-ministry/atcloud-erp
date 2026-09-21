/*
 * Lightweight performance smoke script.
 * Measures basic latency (ms) for:
 *  - Public event slug fetch (first = cold, second = warm cached list if applicable)
 *  - Short link redirect (first vs subsequent)
 * Not a rigorous benchmark—just early detection of gross regressions.
 * Run with: npx ts-node --transpile-only backend/scripts/perf-smoke.ts
 */
import request from "supertest";
import app from "../src/app";
import User from "../src/models/User";
import Event from "../src/models/Event";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await Promise.all([User.deleteMany({}), Event.deleteMany({})]);
  const admin = {
    username: "perfadmin",
    email: "perfadmin@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "Perf",
    lastName: "Admin",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
    registrationNoticeVersion: "registration-privacy-v1",
  } as const;
  await request(app).post("/api/auth/register").send(admin);
  await User.findOneAndUpdate({ email: admin.email }, { isVerified: true });
  const login = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: admin.email, password: admin.password });
  const token = login.body.data.accessToken;

  const create = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: "Perf Event",
      type: "Webinar",
      date: "2025-12-12",
      endDate: "2025-12-12",
      time: "08:00",
      endTime: "09:00",
      location: "Online",
      format: "Online",
      organizer: "Org",
      roles: [
        {
          name: "Attendee",
          description: "Desc",
          maxParticipants: 10,
          openToPublic: true,
        },
      ],
      purpose: "Purpose long enough for validation.",
      timeZone: "America/Los_Angeles",
      zoomLink: "https://example.com/zoom/perf",
      suppressNotifications: true,
    });
  const eventId = create.body.data.event.id;
  await Event.findByIdAndUpdate(eventId, {
    $set: { "roles.0.openToPublic": true },
  });
  const publish = await request(app)
    .post(`/api/events/${eventId}/publish`)
    .set("Authorization", `Bearer ${token}`)
    .send();
  const slug = publish.body.data.slug;

  const shortRes = await request(app)
    .post(`/api/events/${eventId}/shortlink`)
    .set("Authorization", `Bearer ${token}`)
    .send();
  const shortKey = shortRes.body.data.key;

  // Warm up small delay
  await sleep(50);

  function timed(label: string, fn: () => Promise<any>) {
    return (async () => {
      const t0 = performance.now();
      const res = await fn();
      const t1 = performance.now();
      console.log(`${label}: ${(t1 - t0).toFixed(1)} ms status=${res.status}`);
      return res;
    })();
  }

  // Public slug endpoint (detail)
  await timed("public slug cold", () =>
    request(app).get(`/api/public/events/${slug}`)
  );
  await timed("public slug warm", () =>
    request(app).get(`/api/public/events/${slug}`)
  );

  // Listing endpoint (involves cache layer)
  await timed("public list cold", () =>
    request(app).get(`/api/public/events`).query({ page: 1, limit: 5 })
  );
  await timed("public list warm", () =>
    request(app).get(`/api/public/events`).query({ page: 1, limit: 5 })
  );

  // Short link redirect
  await timed("short redirect cold", () =>
    request(app).get(`/s/${shortKey}`).redirects(0)
  );
  await timed("short redirect warm", () =>
    request(app).get(`/s/${shortKey}`).redirects(0)
  );

  console.log("Perf smoke complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
