import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

describe("Events API - YouTube URL for Completed Events", () => {
  let adminToken: string;
  let participantToken: string;
  let completedEventId: string;
  let upcomingEventId: string;
  let adminUserId: string;

  beforeEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});

    // Create admin user
    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "adminyoutube",
      email: "admin-youtube@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "YouTube",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;

    await request(app).post("/api/auth/register").send(adminData);
    const admin = await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" },
      { new: true },
    );
    adminUserId = admin!._id.toString();

    const adminLoginResponse = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password });
    adminToken = adminLoginResponse.body.data.accessToken;

    // Create participant user (lowest permission level)
    const participantData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "participantyoutube",
      email: "participant-youtube@example.com",
      password: "ParticipantPass123!",
      confirmPassword: "ParticipantPass123!",
      firstName: "Participant",
      lastName: "YouTube",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
      registrationNoticeVersion: "registration-privacy-v1",
    } as const;

    await request(app).post("/api/auth/register").send(participantData);
    await User.findOneAndUpdate(
      { email: participantData.email },
      { isVerified: true, role: "Participant" },
    );

    const participantLoginResponse = await request(app)
      .post("/api/auth/login")
      .send({
        emailOrUsername: participantData.email,
        password: participantData.password,
      });
    participantToken = participantLoginResponse.body.data.accessToken;

    // Create a completed event
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 7);
    const yyyy = pastDate.getFullYear();
    const mm = String(pastDate.getMonth() + 1).padStart(2, "0");
    const dd = String(pastDate.getDate()).padStart(2, "0");
    const pastDateStr = `${yyyy}-${mm}-${dd}`;

    const completedEvent = await Event.create({
      title: "Completed YouTube Test Event",
      type: "Effective Communication Workshop",
      date: pastDateStr,
      endDate: pastDateStr,
      time: "10:00",
      endTime: "12:00",
      location: "HQ Main",
      organizer: "Admin YouTube (Administrator)",
      format: "In-person",
      agenda:
        "This is an agenda long enough to satisfy validation (>= 20 characters).",
      status: "completed",
      createdBy: adminUserId,
      roles: [
        {
          id: "r1",
          name: "Attendee",
          description: "Event attendee",
          maxParticipants: 10,
          currentSignups: [],
        },
      ],
    });
    completedEventId = completedEvent._id.toString();

    // Create an upcoming event
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const fYyyy = futureDate.getFullYear();
    const fMm = String(futureDate.getMonth() + 1).padStart(2, "0");
    const fDd = String(futureDate.getDate()).padStart(2, "0");
    const futureDateStr = `${fYyyy}-${fMm}-${fDd}`;

    const upcomingEvent = await Event.create({
      title: "Upcoming YouTube Test Event",
      type: "Effective Communication Workshop",
      date: futureDateStr,
      endDate: futureDateStr,
      time: "10:00",
      endTime: "12:00",
      location: "HQ Main",
      organizer: "Admin YouTube (Administrator)",
      format: "In-person",
      agenda:
        "This is an agenda long enough to satisfy validation (>= 20 characters).",
      status: "upcoming",
      createdBy: adminUserId,
      roles: [
        {
          id: "r1",
          name: "Attendee",
          description: "Event attendee",
          maxParticipants: 10,
          currentSignups: [],
        },
      ],
    });
    upcomingEventId = upcomingEvent._id.toString();
  });

  afterEach(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
  });

  describe("PATCH /api/events/:id/youtube-url", () => {
    it("allows admin to add YouTube URL to completed event", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl })
        .expect(200);

      expect(resp.body.success).toBe(true);
      expect(resp.body.data.event.youtubeUrl).toBe(youtubeUrl);

      // Verify in database
      const event = await Event.findById(completedEventId);
      expect(event?.youtubeUrl).toBe(youtubeUrl);
    });

    it("allows admin to update existing YouTube URL", async () => {
      // First, set an initial URL
      await Event.findByIdAndUpdate(completedEventId, {
        youtubeUrl: "https://www.youtube.com/watch?v=old_video",
      });

      const newUrl = "https://www.youtube.com/watch?v=new_video_123";

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl: newUrl })
        .expect(200);

      expect(resp.body.success).toBe(true);
      expect(resp.body.data.event.youtubeUrl).toBe(newUrl);
    });

    it("allows admin to remove YouTube URL by sending null", async () => {
      // First, set a URL
      await Event.findByIdAndUpdate(completedEventId, {
        youtubeUrl: "https://www.youtube.com/watch?v=to_remove",
      });

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl: null })
        .expect(200);

      expect(resp.body.success).toBe(true);
      expect(resp.body.data.event.youtubeUrl).toBeUndefined();

      // Verify in database
      const event = await Event.findById(completedEventId);
      expect(event?.youtubeUrl).toBeUndefined();
    });

    it("allows admin to remove YouTube URL by sending empty string", async () => {
      await Event.findByIdAndUpdate(completedEventId, {
        youtubeUrl: "https://www.youtube.com/watch?v=to_remove",
      });

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl: "" })
        .expect(200);

      expect(resp.body.success).toBe(true);
      expect(resp.body.data.event.youtubeUrl).toBeUndefined();
    });

    it("accepts youtu.be short URL format", async () => {
      const youtubeUrl = "https://youtu.be/dQw4w9WgXcQ";

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl })
        .expect(200);

      expect(resp.body.success).toBe(true);
      expect(resp.body.data.event.youtubeUrl).toBe(youtubeUrl);
    });

    it("rejects non-YouTube URLs", async () => {
      const invalidUrl = "https://vimeo.com/123456789";

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl: invalidUrl })
        .expect(400);

      expect(resp.body.success).toBe(false);
      expect(resp.body.message).toContain("valid YouTube URL");
    });

    it("rejects adding YouTube URL to non-completed events", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      const resp = await request(app)
        .patch(`/api/events/${upcomingEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl })
        .expect(400);

      expect(resp.body.success).toBe(false);
      expect(resp.body.message).toContain("completed events");
    });

    it("rejects request from non-admin, non-organizer user", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      const resp = await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${participantToken}`)
        .send({ youtubeUrl })
        .expect(403);

      expect(resp.body.success).toBe(false);
      expect(resp.body.message).toContain("permission");
    });

    it("requires authentication", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .send({ youtubeUrl })
        .expect(401);
    });

    it("returns 404 for non-existent event", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const fakeId = "000000000000000000000000";

      const resp = await request(app)
        .patch(`/api/events/${fakeId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl })
        .expect(404);

      expect(resp.body.success).toBe(false);
    });

    it("returns 400 for invalid event ID format", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      const resp = await request(app)
        .patch("/api/events/invalid-id/youtube-url")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl })
        .expect(400);

      expect(resp.body.success).toBe(false);
    });
  });

  describe("YouTube URL storage in event model", () => {
    it("stores youtubeUrl in event document and returns it in GET", async () => {
      const youtubeUrl = "https://www.youtube.com/watch?v=stored_url";

      await request(app)
        .patch(`/api/events/${completedEventId}/youtube-url`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ youtubeUrl })
        .expect(200);

      // Verify via GET event endpoint
      const getResp = await request(app)
        .get(`/api/events/${completedEventId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(getResp.body.data.event.youtubeUrl).toBe(youtubeUrl);
    });
  });
});
