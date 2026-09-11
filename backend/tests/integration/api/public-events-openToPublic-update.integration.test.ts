import { TEST_REGISTRATION_PROFILE } from "../../test-utils/registrationProfileFixture";
import request from "supertest";
import { describe, it, beforeEach, expect } from "vitest";
import app from "../../../src/app";
import User from "../../../src/models/User";
import Event from "../../../src/models/Event";
import { buildValidEventPayload } from "../../test-utils/eventTestHelpers";

/**
 * Regression tests for openToPublic role flag update behavior.
 * - Preserves existing flag when omitted
 * - Allows toggling flag from false -> true via update
 */

describe("Public Events API - openToPublic role update behavior", () => {
  let adminToken: string;
  let eventId: string;
  let roleId: string;

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Event.deleteMany({})]);

    const adminData = {
      ...TEST_REGISTRATION_PROFILE,
      username: "roleupdateadmin",
      email: "roleupdateadmin@example.com",
      password: "AdminPass123!",
      confirmPassword: "AdminPass123!",
      firstName: "RoleUpdate",
      lastName: "Admin",
      role: "Administrator",
      gender: "male",
      isAtCloudLeader: false,
      acceptTerms: true,
    } as const;
    await request(app).post("/api/auth/register").send(adminData).expect(201);
    await User.findOneAndUpdate(
      { email: adminData.email },
      { isVerified: true, role: "Administrator" }
    );
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ emailOrUsername: adminData.email, password: adminData.password })
      .expect(200);
    adminToken = loginRes.body.data.accessToken;

    // Create event with role openToPublic false by omission
    const eventPayload = buildValidEventPayload({
      title: "Flag Update Event",
      roles: [
        {
          name: "Participant",
          description: "Desc",
          maxParticipants: 5,
          // openToPublic omitted => false default
        },
      ],
      purpose: "Testing openToPublic role flag behavior.",
    });

    const createRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(eventPayload)
      .expect(201);
    let ev = createRes.body.data.event;
    eventId = ev.id || ev._id;
    roleId = ev.roles[0].id || ev.roles[0]._id;
    expect(ev.roles[0].openToPublic).toBe(false);

    // Prime baseline: set openToPublic true
    const primeRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Desc",
            maxParticipants: 5,
            openToPublic: true,
          },
        ],
        suppressNotifications: true,
      })
      .expect(200);
    ev = primeRes.body.data.event;
    expect(ev.roles[0].openToPublic).toBe(true);
  }, 30000);

  it("preserves openToPublic when omitted from update payload", async () => {
    const updateRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Desc",
            maxParticipants: 5,
          }, // omit openToPublic
        ],
        suppressNotifications: true,
        purpose: "Testing openToPublic role flag behavior.",
      });
    expect(updateRes.status).toBe(200);
    const updatedRole = updateRes.body.data.event.roles.find(
      (r: any) => (r.id || r._id) === roleId
    );
    expect(updatedRole.openToPublic).toBe(true); // should remain true
  });

  it("can toggle openToPublic false -> true via update", async () => {
    // First set it false explicitly
    let toggleRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Desc",
            maxParticipants: 5,
            openToPublic: false,
          },
        ],
        suppressNotifications: true,
        purpose: "Testing openToPublic role flag behavior.",
      });
    expect(toggleRes.status).toBe(200);
    let toggledRole = toggleRes.body.data.event.roles[0];
    expect(toggledRole.openToPublic).toBe(false);

    // Now omit flag -> should stay false
    toggleRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Desc",
            maxParticipants: 5,
          },
        ],
        suppressNotifications: true,
        purpose: "Testing openToPublic role flag behavior.",
      });
    expect(toggleRes.status).toBe(200);
    toggledRole = toggleRes.body.data.event.roles[0];
    expect(toggledRole.openToPublic).toBe(false);

    // Finally set true explicitly
    toggleRes = await request(app)
      .put(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        roles: [
          {
            id: roleId,
            name: "Participant",
            description: "Desc",
            maxParticipants: 5,
            openToPublic: true,
          },
        ],
        suppressNotifications: true,
        purpose: "Testing openToPublic role flag behavior.",
      });
    expect(toggleRes.status).toBe(200);
    toggledRole = toggleRes.body.data.event.roles[0];
    expect(toggledRole.openToPublic).toBe(true);
  });
});
