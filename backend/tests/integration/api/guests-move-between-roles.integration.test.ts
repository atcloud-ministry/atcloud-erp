import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import GuestRegistration from "../../../src/models/GuestRegistration";
import Registration from "../../../src/models/Registration";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

describe("Guest move between roles triggers email", () => {
  let adminToken: string;
  let eventId: string;
  let fromRoleId: string;
  let toRoleId: string;

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
        title: "Guest Move Email Test Event",
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
        // Use two valid roles from the workshop template so server-side validation passes
        roles: [
          {
            name: "Group A Participants",
            maxParticipants: 5,
            description: "Participants in Group A",
          },
          {
            name: "Group B Participants",
            maxParticipants: 5,
            description: "Participants in Group B",
          },
        ],
      })
      .expect(201);
    const created = eventRes.body.data.event;
    eventId = created.id || created._id;
    fromRoleId = created.roles[0].id;
    toRoleId = created.roles[1].id;
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
      roleId: fromRoleId,
      fullName: "Guest Moved",
      gender: "female",
      email: "guest.move@example.com",
      phone: "+1 555 222 4444",
      notes: "",
      ...overrides,
    };
  }

  it("sends moved email when admin moves a guest between roles", async () => {
    const movedSpy = vi
      .spyOn(EmailService, "sendEventRoleMovedEmail")
      .mockResolvedValue(true);

    // Register guest in Role A
    const regRes = await request(app)
      .post(`/api/events/${eventId}/guest-signup`)
      .send(guestPayload())
      .expect(201);

    const regId = regRes.body?.data?.registrationId;
    expect(regId).toBeTruthy();

    // Admin moves to Role B
    await request(app)
      .post(`/api/events/${eventId}/manage/move-guest`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        guestRegistrationId: regId,
        fromRoleId,
        toRoleId,
      })
      .expect(200);

    expect(movedSpy).toHaveBeenCalled();
    const [to, data] = movedSpy.mock.calls.at(-1)!;
    expect(to).toBe("guest.move@example.com");
    expect((data as any)?.event?.title).toBe("Guest Move Email Test Event");
    expect((data as any)?.fromRoleName).toBe("Group A Participants");
    expect((data as any)?.toRoleName).toBe("Group B Participants");

    movedSpy.mockRestore();
  });
});
