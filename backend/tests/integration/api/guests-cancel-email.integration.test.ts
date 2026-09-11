import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import GuestRegistration from "../../../src/models/GuestRegistration";
import Registration from "../../../src/models/Registration";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

describe("Guest removal triggers email", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Event.deleteMany({}),
      Registration.deleteMany({}),
      GuestRegistration.deleteMany({}),
    ]);

    const admin = {
      ...TEST_REGISTRATION_PROFILE,
      username: "admin",
      email: "admin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "Admin",
      lastName: "User",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    };

    await request(app).post("/api/auth/register").send(admin);
    await User.findOneAndUpdate(
      { email: admin.email },
      { isVerified: true, role: "Administrator" }
    );
    const login = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: admin.email, password: admin.password });
    adminToken = login.body.data.accessToken;

    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        title: "Guest Removal Email Test Event",
        description: "Desc",
        date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        time: "10:00",
        endTime: "12:00",
        location: "Loc",
        type: "Effective Communication Workshop",
        format: "In-person",
        purpose: "Test purpose",
        agenda:
          "Introduction, session content, interactive discussion, Q&A, and closing.",
        organizer: "Test Organizer",
        maxParticipants: 20,
        category: "general",
        // Use valid role names from the "Effective Communication Workshop" template
        roles: [
          {
            name: "Group A Participants",
            maxParticipants: 5,
            description: "Participants in Group A",
          },
        ],
      })
      .expect(201);
    const created = eventRes.body.data.event;
    eventId = created.id || created._id;
    roleId = created.roles[0].id;
  });

  afterEach(async () => {
    await Promise.all([
      GuestRegistration.deleteMany({}),
      Registration.deleteMany({}),
      Event.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  function guestPayload(overrides: Partial<Record<string, any>> = {}) {
    return {
      roleId,
      fullName: "Guest Removee",
      gender: "female",
      email: "guest.remove@example.com",
      phone: "+1 555 222 3333",
      notes: "",
      ...overrides,
    };
  }

  it("sends removal email when admin cancels a guest registration", async () => {
    const removedSpy = vi
      .spyOn(EmailService, "sendEventRoleRemovedEmail")
      .mockResolvedValue(true);

    // Register guest
    const regRes = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(guestPayload())
      .expect(201);

    const regId = regRes.body?.data?.registrationId;
    expect(regId).toBeTruthy();

    // Admin cancels
    await request(app)
      .delete(`/api/guest-registrations/${regId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "No longer needed" })
      .expect(200);

    expect(removedSpy).toHaveBeenCalled();
    const [to, data] = removedSpy.mock.calls.at(-1)!;
    expect(to).toBe("guest.remove@example.com");
    expect((data as any)?.event?.title).toBe("Guest Removal Email Test Event");
    expect((data as any)?.roleName).toBe("Group A Participants");

    removedSpy.mockRestore();
  });
});
