import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
/**
 * Integration test: Auto-unpublish when all roles are changed to not openToPublic
 *
 * Purpose: Ensure that when a published event has all roles changed from
 * openToPublic:true to openToPublic:false, the event is automatically unpublished.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

describe("Auto-unpublish when all roles become non-public", () => {
  let adminToken: string;
  let adminId: string;
  let eventId: string;
  let openedLocal = false;

  beforeAll(async () => {
    // Ensure MongoDB connection
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(
        process.env.MONGODB_TEST_URI ||
          "mongodb://127.0.0.1:27017/atcloud-signup-test"
      );
      openedLocal = true;
    }

    await User.deleteMany({});
    await Event.deleteMany({});

    // Create admin user
    const adminRes = await request(app).post("/api/auth/register").send({
      ...TEST_REGISTRATION_PROFILE,
      username: "adminuser",
      email: "adminuser@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "female",
      isAtCloudLeader: false,
      acceptTerms: true,
    });
    adminId = adminRes.body.data.user.id;
    await User.findByIdAndUpdate(adminId, {
      isVerified: true,
      role: "Administrator",
    });

    const adminLogin = await request(app).post("/api/auth/login").send({
      emailOrUsername: "adminuser@example.com",
      password: "AdminPass123!",
    });
    adminToken = adminLogin.body.data.accessToken;

    // Create a published online event with one public role
    const event = await Event.create({
      title: "Public Role Auto-Unpublish Test Event",
      description: "Event to test auto-unpublish when roles become non-public",
      date: new Date(Date.now() + 86400000).toISOString().split("T")[0],
      time: "14:00",
      endTime: "16:00",
      location: "Test Location",
      type: "Effective Communication Workshop",
      format: "Online",
      zoomLink: "https://zoom.us/j/123456789",
      meetingId: "123 456 789",
      passcode: "testpass",
      purpose:
        "Testing auto-unpublish when all roles become non-public for published events",
      organizer: "QA Team",
      createdBy: new mongoose.Types.ObjectId(adminId),
      roles: [
        {
          id: "role-1",
          name: "Participants",
          maxParticipants: 20,
          description: "Main participants",
          openToPublic: true, // Initially open to public
        },
      ],
      status: "upcoming",
      timeZone: "Etc/UTC",
      publish: true, // Published
    } as any);
    eventId = (event as any)._id.toString();
  }, 30000);

  afterAll(async () => {
    await User.deleteMany({});
    await Event.deleteMany({});
    if (openedLocal && mongoose.connection.readyState !== 0) {
      // Shared integration harness owns connection lifecycle.
    }
  });

  it("should schedule unpublish with 48-hour grace period when all roles are changed to not openToPublic", async () => {
    // Verify event is initially published
    const initialEvent = await Event.findById(eventId);
    expect(initialEvent?.publish).toBe(true);
    expect(initialEvent?.roles.some((r: any) => r.openToPublic === true)).toBe(
      true
    );

    // Update the role to not be open to public
    const res = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: "role-1",
            name: "Participants",
            maxParticipants: 20,
            description: "Main participants",
            openToPublic: false, // Changed to not open to public
          },
        ],
      })
      .expect(200);

    // With 48-hour grace period, event stays published but has scheduled unpublish
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.publish).toBe(true);
    expect(res.body.data.event.unpublishScheduledAt).toBeTruthy();
    expect(res.body.data.event.unpublishWarningFields).toContain("roles");
    // Should NOT be unpublished yet
    expect(res.body.data.event.autoUnpublishedAt).toBeFalsy();
    expect(res.body.data.event.autoUnpublishedReason).toBeFalsy();
    expect(res.body.message).toContain("automatically unpublished in 48 hours");

    // Verify all roles are now not open to public
    const updatedEvent = await Event.findById(eventId);
    expect(
      updatedEvent?.roles.every((r: any) => r.openToPublic === false)
    ).toBe(true);
  });

  it("should remain published if at least one role stays openToPublic", async () => {
    // Re-publish the event with two roles (one public, one private)
    // Also clear grace period fields from previous test
    await Event.findByIdAndUpdate(eventId, {
      publish: true,
      autoUnpublishedReason: null,
      autoUnpublishedAt: null,
      unpublishScheduledAt: null,
      unpublishWarningFields: undefined,
      roles: [
        {
          id: "role-1",
          name: "Participants",
          maxParticipants: 20,
          description: "Main participants",
          openToPublic: true, // Public
        },
        {
          id: "role-2",
          name: "Volunteers",
          maxParticipants: 5,
          description: "Event volunteers",
          openToPublic: false, // Private
        },
      ],
    });

    // Update only the private role (public role unchanged)
    const res = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: "role-1",
            name: "Participants",
            maxParticipants: 20,
            description: "Main participants",
            openToPublic: true, // Still public
          },
          {
            id: "role-2",
            name: "Volunteers",
            maxParticipants: 10, // Just changed capacity
            description: "Event volunteers",
            openToPublic: false, // Still private
          },
        ],
      })
      .expect(200);

    // Should remain published because role-1 is still public
    expect(res.body.success).toBe(true);
    expect(res.body.data.event.publish).toBe(true);
    expect(res.body.data.event.autoUnpublishedReason).toBeFalsy();
  });
});
