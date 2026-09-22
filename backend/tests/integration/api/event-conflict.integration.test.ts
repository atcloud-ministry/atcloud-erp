import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Program from "../../../src/models/Program";
import { ROLES } from "../../../src/utils/roleUtils";
import { ensureIntegrationDB } from "../setup/connect";

import mongoose from "mongoose";

describe("EventConflictController - GET /api/events/check-conflict", () => {
  let originalTimeZone: string | undefined;

  beforeAll(() => {
    // Requests without timeZone use the process-local timezone. These fixtures
    // describe Pacific wall-clock times, including on UTC CI runners.
    originalTimeZone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
  });

  afterAll(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  beforeEach(async () => {
    await ensureIntegrationDB();
    await User.deleteMany({});
    await Event.deleteMany({});
    await Program.deleteMany({});
  });

  const createTestEvent = async (options: any = {}) => {
    const creator = await User.create({
      name: "Creator",
      username: `creator${Date.now()}`,
      email: `creator${Date.now()}@test.com`,
      password: "Password123",
      role: ROLES.PARTICIPANT,
      isActive: true,
      isVerified: true,
    });

    return await Event.create({
      title: options.title || "Test Event",
      type: "Conference",
      date: options.date || "2025-06-01",
      endDate: options.endDate || options.date || "2025-06-01",
      time: options.time || "10:00",
      endTime: options.endTime || "12:00",
      location: "Test Location",
      organizer: "Test Organizer",
      format: "In-person",
      timeZone: options.timeZone || "America/Los_Angeles",
      createdBy: creator._id,
      programLabels: options.programLabels || [],
      roles: [
        {
          id: "participant-role-1",
          name: "Participant",
          description: "Event participant",
          maxParticipants: 100,
          signups: [],
        },
      ],
      isPaid: false,
      published: true,
      status: options.status || "upcoming",
    });
  };

  // ========== Public Access ==========
  describe("Public Access", () => {
    it("should allow access without authentication", async () => {
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=10:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  // ========== Success Cases ==========
  describe("Success Cases", () => {
    it("should detect no conflict when no events exist", async () => {
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=10:00&endDate=2025-06-01&endTime=12:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(false);
      expect(response.body.data.conflicts).toEqual([]);
    });

    it("should detect conflict with overlapping event", async () => {
      await createTestEvent({
        title: "Existing Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(true);
      expect(response.body.data.conflicts).toHaveLength(1);
      expect(response.body.data.conflicts[0].title).toBe("Existing Event");
    });

    it("should detect no conflict with non-overlapping events", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=13:00&endDate=2025-06-01&endTime=15:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(false);
      expect(response.body.data.conflicts).toEqual([]);
    });

    it("should exclude specific event by ID", async () => {
      const existingEvent = await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        `/api/events/check-conflict?startDate=2025-06-01&startTime=10:00&endDate=2025-06-01&endTime=12:00&excludeId=${existingEvent._id}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(false);
      expect(response.body.data.conflicts).toEqual([]);
    });

    it("should use end defaults when not provided", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      // Only startDate and startTime provided
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=10:30",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Should still detect conflict (point-in-time check with +1 minute)
      expect(response.body.data.conflict).toBe(true);
    });

    it("should handle point mode correctly", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=10:30&mode=point",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(true);
    });

    it("should respect timezone differences", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        timeZone: "America/New_York",
      });

      // 10 AM Pacific = 1 PM Eastern (no conflict)
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=10:00&endDate=2025-06-01&endTime=12:00&timeZone=America/Los_Angeles",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(false);
    });

    it("should detect multiple conflicts", async () => {
      await createTestEvent({
        title: "Event 1",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      await createTestEvent({
        title: "Event 2",
        date: "2025-06-01",
        time: "11:00",
        endTime: "13:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:30&endDate=2025-06-01&endTime=12:30",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(true);
      expect(response.body.data.conflicts).toHaveLength(2);
    });

    it("should ignore cancelled events", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        status: "cancelled",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(false);
      expect(response.body.data.conflicts).toEqual([]);
    });

    it("should handle multi-day events", async () => {
      await createTestEvent({
        date: "2025-06-01",
        endDate: "2025-06-03",
        time: "10:00",
        endTime: "17:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-02&startTime=14:00&endDate=2025-06-02&endTime=16:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(true);
    });
  });

  // ========== Edge Cases ==========
  describe("Edge Cases", () => {
    it("should return 400 when startDate is missing", async () => {
      const response = await request(app).get(
        "/api/events/check-conflict?startTime=10:00",
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "startDate and startTime are required",
      );
    });

    it("should return 400 when startTime is missing", async () => {
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01",
      );

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe(
        "startDate and startTime are required",
      );
    });

    it("should handle invalid excludeId gracefully", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&excludeId=invalid-id",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Invalid excludeId should be ignored, conflict still detected
      expect(response.body.data.conflict).toBe(true);
    });

    it("should handle same-day events (endDate defaults to date)", async () => {
      // Create event where endDate is same as date (single-day event)
      await createTestEvent({
        date: "2025-06-01",
        endDate: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(true);
    });

    it("should handle events spanning midnight", async () => {
      await createTestEvent({
        date: "2025-06-01",
        time: "22:00",
        endDate: "2025-06-02",
        endTime: "02:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=23:00&endDate=2025-06-02&endTime=01:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.conflict).toBe(true);
    });
  });

  // ========== Response Format ==========
  describe("Response Format", () => {
    it("should have correct success response structure", async () => {
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=10:00",
      );

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("success");
      expect(response.body).toHaveProperty("data");
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty("conflict");
      expect(response.body.data).toHaveProperty("conflicts");
      expect(typeof response.body.data.conflict).toBe("boolean");
      expect(Array.isArray(response.body.data.conflicts)).toBe(true);
    });

    it("should have correct error response structure", async () => {
      const response = await request(app).get(
        "/api/events/check-conflict?startTime=10:00",
      );

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("success");
      expect(response.body).toHaveProperty("message");
      expect(response.body.success).toBe(false);
      expect(typeof response.body.message).toBe("string");
    });

    it("should include event id and title in conflicts", async () => {
      const event = await createTestEvent({
        title: "Conflicting Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflicts).toHaveLength(1);
      expect(response.body.data.conflicts[0]).toHaveProperty("id");
      expect(response.body.data.conflicts[0]).toHaveProperty("title");
      expect(response.body.data.conflicts[0].id).toBe(event._id.toString());
      expect(response.body.data.conflicts[0].title).toBe("Conflicting Event");
    });

    it("should include program affiliation details in conflicts", async () => {
      const creator = await User.create({
        name: "Program Creator",
        username: `pc${Date.now().toString().slice(-10)}`,
        email: `programcreator${Date.now()}@test.com`,
        password: "Password123",
        role: ROLES.PARTICIPANT,
        isActive: true,
        isVerified: true,
      });
      const program = await Program.create({
        title: "Leadership Growth Program",
        programType: "Webinar",
        isFree: true,
        fullPriceTicket: 0,
        createdBy: creator._id,
      });

      await createTestEvent({
        title: "Program Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [program._id],
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflicts[0].programs).toEqual([
        { id: program._id.toString(), title: "Leadership Growth Program" },
      ]);
    });
  });

  // ========== Global Conflict Detection with Program Metadata ==========
  describe("Global Conflict Detection with Program Metadata", () => {
    const programA = new mongoose.Types.ObjectId();
    const programB = new mongoose.Types.ObjectId();
    const programC = new mongoose.Types.ObjectId();

    it("should detect overlap when events belong to different programs", async () => {
      await createTestEvent({
        title: "Program A Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [programA],
      });

      const response = await request(app).get(
        `/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&programLabels=${programB}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
      expect(response.body.data.conflicts).toHaveLength(1);
    });

    it("should detect overlap when events share a program", async () => {
      await createTestEvent({
        title: "Program A Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [programA],
      });

      const response = await request(app).get(
        `/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&programLabels=${programA}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
      expect(response.body.data.conflicts).toHaveLength(1);
    });

    it("should detect overlap when events share at least one program among multiple", async () => {
      await createTestEvent({
        title: "Multi-Program Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [programA, programB],
      });

      // New event shares programB
      const response = await request(app).get(
        `/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&programLabels=${programB}&programLabels=${programC}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
    });

    it("should detect overlap when existing event has no programs", async () => {
      await createTestEvent({
        title: "No-Program Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [],
      });

      const response = await request(app).get(
        `/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&programLabels=${programA}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
      expect(response.body.data.conflicts[0].programs).toEqual([]);
    });

    it("should detect overlap when new event has no programs", async () => {
      await createTestEvent({
        title: "Program A Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [programA],
      });

      // Send empty programLabels
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&programLabels=",
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
    });

    it("should detect overlap when neither event has programs and programLabels param is sent", async () => {
      await createTestEvent({
        title: "No-Program Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [],
      });

      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00&programLabels=",
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
    });

    it("should fall back to global conflict when programLabels param is not sent", async () => {
      await createTestEvent({
        title: "Some Event",
        date: "2025-06-01",
        time: "10:00",
        endTime: "12:00",
        programLabels: [programA],
      });

      // No programLabels param at all → legacy behavior, global conflict
      const response = await request(app).get(
        "/api/events/check-conflict?startDate=2025-06-01&startTime=11:00&endDate=2025-06-01&endTime=13:00",
      );

      expect(response.status).toBe(200);
      expect(response.body.data.conflict).toBe(true);
    });
  });
});
