import { describe, it, beforeEach, expect, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import Registration from "../../../src/models/Registration";
import GuestRegistration from "../../../src/models/GuestRegistration";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";
import { UnifiedMessageController } from "../../../src/controllers/unifiedMessageController";

/**
 * Integration test to verify the suppressNotifications flag on event creation.
 *
 * Strategy:
 *  - Create two verified users (organizer + participant) so that unsuppressed path would send at least one eventCreated email.
 *  - First create event with suppressNotifications=true and assert no system message or email methods invoked.
 *  - Then create second event without suppression and assert system message and email methods invoked.
 */

// Helper to register + verify + login
async function registerAndLogin(opts: {
  username: string;
  email: string;
  role?: string;
}) {
  const password = "TestPass123!";
  const regRes = await request(app).post("/api/auth/register").send({
    username: opts.username,
    email: opts.email,
    password,
    confirmPassword: password,
    firstName: "T",
    lastName: "U",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
  });
  if (regRes.status !== 201) {
    throw new Error(`Registration failed for ${opts.email}: ${regRes.status}`);
  }
  await User.findOneAndUpdate(
    { email: opts.email },
    { isVerified: true, ...(opts.role ? { role: opts.role } : {}) }
  );
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: opts.email, password })
    .expect(200);
  return { token: loginRes.body.data.accessToken as string };
}

// Spies (declared outer scope for type narrowing)
// Use loose any types here to avoid Vitest generic signature incompatibility noise;
// we only assert on call counts.
let systemMsgSpy: any;
let eventCreatedEmailSpy: any;
let coOrganizerEmailSpy: any;
let eventUpdatedEmailBulkSpy: any;

describe("Event creation notification suppression", () => {
  // Extend hook timeout (default 10s was occasionally exceeded by collection wipes on slow CI)
  beforeEach(async () => {
    const start = Date.now();
    // Ensure test database connection (buffering timeouts were occurring before first real op)
    if (mongoose.connection.readyState !== 1) {
      const uri =
        process.env.MONGODB_TEST_URI ||
        process.env.MONGODB_URI ||
        "mongodb://localhost:27017/atcloud-signup-test";
      // eslint-disable-next-line no-console
      console.log(`[suppression-test] connecting to MongoDB: ${uri}`);
      await mongoose.connect(
        uri as string,
        {
          // Keep options minimal to avoid deprecation noise; adjust if needed
          autoIndex: false,
        } as any
      );
    }
    // Parallelize deletions to reduce total time
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);
    const afterDeletes = Date.now();
    vi.restoreAllMocks();
    systemMsgSpy = vi
      .spyOn(UnifiedMessageController, "createTargetedSystemMessage")
      .mockResolvedValue({
        _id: { toString: () => "mock-id" },
      } as any);
    eventCreatedEmailSpy = vi
      .spyOn(EmailService, "sendEventCreatedEmail")
      .mockResolvedValue(true as any);
    coOrganizerEmailSpy = vi
      .spyOn(EmailService, "sendCoOrganizerAssignedEmail")
      .mockResolvedValue(true as any);
    eventUpdatedEmailBulkSpy = vi
      .spyOn(EmailService, "sendEventNotificationEmailBulk")
      .mockResolvedValue([true] as any);
    const end = Date.now();
    // Lightweight timing log to aid future diagnostics (will appear in test stdout)
    // eslint-disable-next-line no-console
    console.log(
      `[suppression-test] beforeEach timings: deletes=$${
        afterDeletes - start
      }ms total=$${end - start}ms`
    );
  }, 30000);

  it("skips system messages and emails when suppressNotifications=true, but sends them when false", async () => {
    // Arrange users
    const organizer = await registerAndLogin({
      username: "org_1",
      email: "org1@example.com",
      role: "Leader",
    });
    // Additional participant to ensure at least one potential eventCreatedEmail recipient (emails exclude creator)
    // Use a longer username to satisfy username length validation and omit role for default participant role assignment
    await registerAndLogin({
      username: "participant_1",
      email: "participant1@example.com",
    });

    const suppressedPayload = {
      title: "Suppressed Event",
      description: "Suppressed event description",
      agenda: "1. Intro and overview\n2. Content deep dive section",
      type: "Effective Communication Workshop",
      date: "2099-12-31",
      endDate: "2099-12-31",
      time: "10:00",
      endTime: "11:00",
      location: "Loc",
      organizer: "Org",
      format: "In-person",
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          description: "d",
          maxParticipants: 1,
        },
      ],
      suppressNotifications: true,
    };

    const suppressedRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${organizer.token}`)
      .send(suppressedPayload);

    if (suppressedRes.status !== 201) {
      // Dump validation errors for debugging then fail explicitly
      // eslint-disable-next-line no-console
      console.error("Suppressed event creation failed", {
        status: suppressedRes.status,
        body: suppressedRes.body,
        payload: suppressedPayload,
      });
    }
    expect(suppressedRes.status).toBe(201);

    expect(suppressedRes.body.success).toBe(true);

    expect(systemMsgSpy).toHaveBeenCalledTimes(0);
    expect(eventCreatedEmailSpy).toHaveBeenCalledTimes(0);
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(0);

    const unsuppressedPayload = {
      title: "Normal Event",
      description: "Normal event description",
      agenda: "1. Intro and overview\n2. Content deep dive section",
      type: "Effective Communication Workshop",
      date: "2099-11-30",
      endDate: "2099-11-30",
      time: "09:00",
      endTime: "10:00",
      location: "Loc",
      organizer: "Org",
      format: "In-person",
      roles: [
        {
          id: "role-1",
          name: "Zoom Host",
          description: "d",
          maxParticipants: 1,
        },
      ],
    };

    const unsuppressedRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${organizer.token}`)
      .send(unsuppressedPayload);

    if (unsuppressedRes.status !== 201) {
      // eslint-disable-next-line no-console
      console.error("Unsuppressed event creation failed", {
        status: unsuppressedRes.status,
        body: unsuppressedRes.body,
        payload: unsuppressedPayload,
      });
    }
    expect(unsuppressedRes.status).toBe(201);

    expect(unsuppressedRes.body.success).toBe(true);

    expect(systemMsgSpy).toHaveBeenCalledTimes(1);
    expect(eventCreatedEmailSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(0);
  });

  it("co-organizer assignment notifications: suppressed on edit vs sent when unsuppressed", async () => {
    // Arrange users
    const organizer = await registerAndLogin({
      username: "org_3",
      email: "org3@example.com",
      role: "Leader",
    });
    await registerAndLogin({
      username: "coorg_1",
      email: "coorg1@example.com",
      role: "Leader",
    });
    await registerAndLogin({
      username: "coorg_2",
      email: "coorg2@example.com",
      role: "Leader",
    });

    const co1 = await User.findOne({ email: "coorg1@example.com" }).lean();
    const co2 = await User.findOne({ email: "coorg2@example.com" }).lean();
    expect((co1 as any)?._id).toBeTruthy();
    expect((co2 as any)?._id).toBeTruthy();

    // Create base event (suppressed to avoid create-time notifications)
    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${organizer.token}`)
      .send({
        title: "CoOrg Notify Event",
        description: "desc",
        agenda: "1. Intro and safety\n2. Content",
        type: "Effective Communication Workshop",
        date: "2099-12-01",
        endDate: "2099-12-01",
        time: "07:00",
        endTime: "08:00",
        location: "Loc",
        organizer: "Org",
        format: "In-person",
        roles: [
          { id: "r1", name: "Zoom Host", description: "d", maxParticipants: 1 },
        ],
        suppressNotifications: true,
      });
    expect(createRes.status).toBe(201);

    const event = await Event.findOne({ title: "CoOrg Notify Event" }).lean();
    expect((event as any)?._id).toBeTruthy();

    // Clear previous spy counts to isolate edit notifications
    systemMsgSpy.mockClear();
    coOrganizerEmailSpy.mockClear();
    eventUpdatedEmailBulkSpy.mockClear();

    // First update with suppression: add coorg1 as co-organizer
    const suppressedUpdate = await request(app)
      .put(`/api/events/${(event as any)._id}`)
      .set("Authorization", `Bearer ${organizer.token}`)
      .send({
        organizerDetails: [
          {
            userId: (co1 as any)._id,
            name: "Co One",
            role: "Co-Organizer",
            gender: "male",
          },
        ],
        suppressNotifications: true,
      });
    expect(suppressedUpdate.status).toBe(200);
    expect(suppressedUpdate.body.success).toBe(true);

    // No co-organizer notifications when suppressed
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(0);
    expect(systemMsgSpy).toHaveBeenCalledTimes(0);
    expect(eventUpdatedEmailBulkSpy).toHaveBeenCalledTimes(0);

    // Second update without suppression: add coorg2 (new) alongside existing coorg1
    const unsuppressedUpdate = await request(app)
      .put(`/api/events/${(event as any)._id}`)
      .set("Authorization", `Bearer ${organizer.token}`)
      .send({
        organizerDetails: [
          {
            userId: (co1 as any)._id,
            name: "Co One",
            role: "Co-Organizer",
            gender: "male",
          },
          {
            userId: (co2 as any)._id,
            name: "Co Two",
            role: "Co-Organizer",
            gender: "female",
          },
        ],
      });

    if (unsuppressedUpdate.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("Unsuppressed co-organizer update failed", {
        status: unsuppressedUpdate.status,
        body: unsuppressedUpdate.body,
      });
    }
    expect(unsuppressedUpdate.status).toBe(200);
    expect(unsuppressedUpdate.body.success).toBe(true);

    // Expect notifications for the newly added co-organizer and that update emails path ran
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(1);
    expect(systemMsgSpy).toHaveBeenCalledTimes(1);
    // Participants/guests bulk email may be invoked even with empty recipient lists
    expect(eventUpdatedEmailBulkSpy.mock.calls.length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("skips update notifications when suppressNotifications=true on edit, but sends them when false", async () => {
    // Arrange users
    const organizer = await registerAndLogin({
      username: "org_2",
      email: "org2@example.com",
      role: "Leader",
    });
    const participant = await registerAndLogin({
      username: "participant_2",
      email: "participant2@example.com",
    });

    // Create an event with suppression to avoid create-time notifications
    const createPayload = {
      title: "Update Suppression Event",
      description: "Original description",
      agenda: "1. Welcome and setup\n2. Main content section",
      type: "Effective Communication Workshop",
      date: "2099-10-31",
      endDate: "2099-10-31",
      time: "08:00",
      endTime: "09:00",
      location: "Loc",
      organizer: "Org",
      format: "In-person",
      roles: [
        {
          id: "r-host",
          name: "Zoom Host",
          description: "d",
          maxParticipants: 1,
        },
        {
          id: "r-ga",
          name: "Group A Participants",
          description: "group",
          maxParticipants: 3,
        },
      ],
      suppressNotifications: true,
    };

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${organizer.token}`)
      .send(createPayload);

    if (createRes.status !== 201) {
      // eslint-disable-next-line no-console
      console.error("Initial (suppressed) create failed", {
        status: createRes.status,
        body: createRes.body,
      });
    }
    expect(createRes.status).toBe(201);

    // Fetch the created event and find a participant-capable role to sign up
    const createdEvent = await Event.findOne({
      title: createPayload.title,
    }).lean();
    expect(createdEvent).toBeTruthy();
    const roleForSignup = (createdEvent as any).roles.find(
      (r: any) => r.name === "Group A Participants"
    );
    expect(roleForSignup?.id).toBeTruthy();

    // Sign up the participant to ensure update notifications have at least one recipient
    const signupRes = await request(app)
      .post(`/api/events/${(createdEvent as any)._id}/signup`)
      .set("Authorization", `Bearer ${participant.token}`)
      .send({ roleId: roleForSignup.id });
    expect(signupRes.status).toBe(200);

    // Reset counts before update assertions
    systemMsgSpy.mockClear();
    eventUpdatedEmailBulkSpy.mockClear();
    coOrganizerEmailSpy.mockClear();

    // First update with suppression: expect no system messages or update emails
    const suppressedUpdate = await request(app)
      .put(`/api/events/${(createdEvent as any)._id}`)
      .set("Authorization", `Bearer ${organizer.token}`)
      .send({
        title: "Update Suppression Event v2",
        suppressNotifications: true,
      });
    expect(suppressedUpdate.status).toBe(200);
    expect(suppressedUpdate.body.success).toBe(true);

    expect(systemMsgSpy).toHaveBeenCalledTimes(0);
    expect(eventUpdatedEmailBulkSpy).toHaveBeenCalledTimes(0);
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(0);

    // Second update without suppression: expect participant system message and at least one update email batch call
    const unsuppressedUpdate = await request(app)
      .put(`/api/events/${(createdEvent as any)._id}`)
      .set("Authorization", `Bearer ${organizer.token}`)
      .send({ description: "Edited description" });

    if (unsuppressedUpdate.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("Unsuppressed update failed", {
        status: unsuppressedUpdate.status,
        body: unsuppressedUpdate.body,
      });
    }
    expect(unsuppressedUpdate.status).toBe(200);
    expect(unsuppressedUpdate.body.success).toBe(true);

    expect(systemMsgSpy).toHaveBeenCalledTimes(1);
    expect(eventUpdatedEmailBulkSpy.mock.calls.length).toBeGreaterThanOrEqual(
      1
    );
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(0);
  });

  it("role agenda edit is silent when suppressNotifications=true", async () => {
    // Arrange users
    const organizer = await registerAndLogin({
      username: "org_agenda",
      email: "org-agenda@example.com",
      role: "Leader",
    });
    const participant = await registerAndLogin({
      username: "p_agenda",
      email: "p-agenda@example.com",
    });

    // Create an event (suppressed to avoid create-time notifications)
    const createPayload = {
      title: "Agenda Edit Silent Event",
      description: "Original description",
      agenda: "Event-level agenda and outline for the session",
      type: "Effective Communication Workshop",
      date: "2099-09-30",
      endDate: "2099-09-30",
      time: "10:00",
      endTime: "11:00",
      location: "Loc",
      organizer: "Org",
      format: "In-person",
      roles: [
        {
          id: "role-edit",
          name: "Group A Participants",
          description: "group",
          maxParticipants: 3,
        },
      ],
      suppressNotifications: true,
    } as const;

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${organizer.token}`)
      .send(createPayload);
    if (createRes.status !== 201) {
      // eslint-disable-next-line no-console
      console.error("Initial (suppressed) create failed", {
        status: createRes.status,
        body: createRes.body,
      });
    }
    expect(createRes.status).toBe(201);

    // Fetch created event and pick role
    const createdEvent = await Event.findOne({
      title: createPayload.title,
    }).lean();
    expect(createdEvent).toBeTruthy();
    // Backend generates UUIDs for role IDs on create, so we cannot rely on the client-provided id.
    // Instead, locate the role by its canonical name used in the payload.
    const roleForAgenda = (createdEvent as any).roles.find(
      (r: any) => r.name === "Group A Participants"
    );
    expect(roleForAgenda?.id).toBeTruthy();

    // Sign up a participant to ensure there would be recipients if notifications were sent
    const signupRes = await request(app)
      .post(`/api/events/${(createdEvent as any)._id}/signup`)
      .set("Authorization", `Bearer ${participant.token}`)
      .send({ roleId: roleForAgenda.id });
    expect(signupRes.status).toBe(200);

    // Reset spy counts to isolate this update
    systemMsgSpy.mockClear();
    eventUpdatedEmailBulkSpy.mockClear();
    coOrganizerEmailSpy.mockClear();

    // Prepare roles payload identical to current roles, except agenda for the target role
    const updatedRoles = (createdEvent as any).roles.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      maxParticipants: r.maxParticipants,
      startTime: r.startTime,
      endTime: r.endTime,
      agenda:
        r.id === roleForAgenda.id
          ? "Facilitation checklist and flow"
          : r.agenda,
    }));

    // Perform a suppressed update only changing the role agenda
    const suppressedUpdate = await request(app)
      .put(`/api/events/${(createdEvent as any)._id}`)
      .set("Authorization", `Bearer ${organizer.token}`)
      .send({
        roles: updatedRoles,
        suppressNotifications: true,
      });
    expect(suppressedUpdate.status).toBe(200);
    expect(suppressedUpdate.body.success).toBe(true);

    // Assert no emails or system messages were sent
    expect(systemMsgSpy).toHaveBeenCalledTimes(0);
    expect(eventUpdatedEmailBulkSpy).toHaveBeenCalledTimes(0);
    expect(coOrganizerEmailSpy).toHaveBeenCalledTimes(0);

    // Optional: verify agenda persisted
    const refreshed = await Event.findById((createdEvent as any)._id).lean();
    const roleAfter = (refreshed as any)?.roles?.find(
      (r: any) => r.id === roleForAgenda.id
    );
    expect(roleAfter?.agenda).toBe("Facilitation checklist and flow");
  });
});
