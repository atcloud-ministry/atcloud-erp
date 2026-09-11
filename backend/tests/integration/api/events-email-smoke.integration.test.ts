import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import { describe, it, expect } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";

// Minimal happy-path smoke test to quickly detect regressions in broadcast email endpoint
// Uses existing global integration DB setup.

async function createAdminAndLogin() {
  const password = "TestPass123!";
  await request(app).post("/api/auth/register").send({
    ...TEST_REGISTRATION_PROFILE,
    username: "smokeadmin",
    email: "smokeadmin@example.com",
    password,
    confirmPassword: password,
    firstName: "S",
    lastName: "A",
    gender: "male",
    isAtCloudLeader: false,
    acceptTerms: true,
  });
  await User.findOneAndUpdate(
    { email: "smokeadmin@example.com" },
    { isVerified: true, role: "Administrator" }
  );
  const login = await request(app)
    .post("/api/auth/login")
    .send({ emailOrUsername: "smokeadmin@example.com", password })
    .expect(200);
  return login.body.data.accessToken as string;
}

describe("SMOKE: POST /api/events/:id/email", () => {
  it("succeeds with 0 recipients when no attendees exist", async () => {
    // Ensure clean slate (lightweight) - no need to purge all collections here beyond events/users we touch
    await User.deleteMany({ email: /smokeadmin/ });

    const token = await createAdminAndLogin();

    const event = await Event.create({
      title: "Smoke",
      type: "Webinar",
      date: "2099-01-01",
      endDate: "2099-01-01",
      time: "09:00",
      endTime: "10:00",
      location: "Loc",
      organizer: "Org",
      organizerDetails: [
        {
          name: "Smoke Admin",
          role: "Organizer",
          email: "smokeadmin@example.com",
          phone: "1234567890",
          gender: "male",
        },
      ],
      createdBy: (await User.findOne({ email: "smokeadmin@example.com" }))!._id,
      purpose: "p",
      format: "In-person",
      roles: [
        { id: "role-1", name: "Role1", description: "d", maxParticipants: 5 },
      ],
    });

    const res = await request(app)
      .post(`/api/events/${event.id}/email`)
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Smoke", bodyHtml: "<p>Hi</p>" })
      .expect(200);

    expect(res.body).toMatchObject({ success: true, recipientCount: 0 });
  });
});
