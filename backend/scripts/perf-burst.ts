/*
 * perf-burst.ts
 * Quick burst performance sampler (NOT a benchmark):
 *  - Creates one published event (public role) + short link
 *  - Warms cache
 *  - Issues N parallel short link resolve (JSON status) & redirect hits
 *  - Issues M sequential guest registrations (until capacity) to capture latency distribution
 * Outputs simple p50/p95 stats.
 * Run: npx ts-node --transpile-only backend/scripts/perf-burst.ts
 */
import request from "supertest";
import app from "../src/app";
import User from "../src/models/User";
import Event from "../src/models/Event";

interface Stat {
  label: string;
  samples: number[];
}
function stats(label: string, arr: number[]): Stat {
  return { label, samples: arr.sort((a, b) => a - b) };
}
function pct(samples: number[], p: number) {
  if (!samples.length) return 0;
  const idx = Math.floor((p / 100) * (samples.length - 1));
  return samples[idx];
}
function summarize(stat: Stat) {
  const { samples, label } = stat;
  const p50 = pct(samples, 50).toFixed(1);
  const p95 = pct(samples, 95).toFixed(1);
  const max = samples.length ? samples[samples.length - 1].toFixed(1) : "0";
  console.log(
    `${label}: n=${samples.length} p50=${p50}ms p95=${p95}ms max=${max}ms`
  );
}

async function main() {
  process.env.TEST_DISABLE_PUBLIC_RL = "true"; // disable rate limits for pure latency sampling
  await Promise.all([User.deleteMany({}), Event.deleteMany({})]);
  const admin = {
    username: "perfburst",
    email: "perfburst@example.com",
    password: "AdminPass123!",
    confirmPassword: "AdminPass123!",
    firstName: "Perf",
    lastName: "Burst",
    role: "Administrator",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
    registrationNoticeVersion: "registration-privacy-v1",
  };
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
      title: "Perf Burst",
      type: "Webinar",
      date: "2025-12-20",
      endDate: "2025-12-20",
      time: "14:00",
      endTime: "15:00",
      location: "Online",
      format: "Online",
      organizer: "Org",
      roles: [
        {
          name: "Attendee",
          description: "Burst role",
          maxParticipants: 25,
          openToPublic: true,
        },
      ],
      purpose: "Purpose long enough to satisfy validation rules for publish.",
      timeZone: "America/Los_Angeles",
      zoomLink: "https://example.com/zoom/burst",
      suppressNotifications: true,
    });
  const eventId = create.body.data.event.id;
  // Make role public if not persisted
  await Event.findByIdAndUpdate(eventId, {
    $set: { "roles.0.openToPublic": true },
  });
  const pub = await request(app)
    .post(`/api/events/${eventId}/publish`)
    .set("Authorization", `Bearer ${token}`)
    .send();
  const slug = pub.body.data.slug;
  const sl = await request(app)
    .post("/api/public/short-links")
    .set("Authorization", `Bearer ${token}`)
    .send({ eventId });
  const key = sl.body.data.key;

  // Warm single resolve and redirect
  await request(app).get(`/api/public/short-links/${key}`);
  await request(app).get(`/s/${key}`).redirects(0);

  const RESOLVE_PARALLEL = 40;
  const REDIRECT_PARALLEL = 40;
  const resolveTimings: number[] = [];
  const redirectTimings: number[] = [];

  // Parallel resolve
  await Promise.all(
    Array.from({ length: RESOLVE_PARALLEL }).map(async () => {
      const t0 = performance.now();
      const r = await request(app).get(`/api/public/short-links/${key}`);
      const t1 = performance.now();
      if (r.status === 200) resolveTimings.push(t1 - t0);
    })
  );

  // Parallel redirect (do not follow)
  await Promise.all(
    Array.from({ length: REDIRECT_PARALLEL }).map(async () => {
      const t0 = performance.now();
      const r = await request(app).get(`/s/${key}`).redirects(0);
      const t1 = performance.now();
      if (r.status === 302) redirectTimings.push(t1 - t0);
    })
  );

  // Sequential registrations (stop at capacity or 10 whichever first)
  const regTimings: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const eventDoc: any = await Event.findById(eventId).lean();
    const roleId = eventDoc.roles[0].id;
    const res = await request(app)
      .post(`/api/public/events/${slug}/register`)
      .send({
        roleId,
        attendee: { name: `Guest ${i}`, email: `guest${i}@example.com` },
        consent: { termsAccepted: true },
      });
    const t1 = performance.now();
    if (res.status === 200) regTimings.push(t1 - t0);
    else break;
  }

  console.log("=== Burst Summary ===");
  summarize(stats("resolve", resolveTimings));
  summarize(stats("redirect", redirectTimings));
  summarize(stats("register", regTimings));
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
