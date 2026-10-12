import request from "supertest";
import app from "../../../src/app";
import { describe, it, expect, beforeAll } from "vitest";
import { createRoleAssignmentRejectionToken } from "../../../src/utils/roleAssignmentRejectionToken";
import Registration from "../../../src/models/Registration";
import Event from "../../../src/models/Event";
import User from "../../../src/models/User";
import { RejectionMetricsService } from "../../../src/services/RejectionMetricsService";

// Ensure rate limiter active in test
process.env.TEST_ENABLE_REJECTION_RATE_LIMIT = "true";

describe("Role assignment rejection rate limiting", () => {
  let eventId: string;
  let userId: string;
  let assignmentId: string;
  beforeAll(async () => {
    RejectionMetricsService.reset();
    // create user & event & registration
    const user = await User.create({
      firstName: "Rate",
      lastName: "Tester",
      email: `ratelimit-${Date.now()}@example.com`,
      password: "testPass8", // must meet >=8 chars requirement
      username: `rl_${Date.now()}`,
    } as any);
    userId = String(user._id);
    const event = await Event.create({
      title: "RL Event",
      date: "2030-01-01",
      time: "10:00",
      endTime: "11:00",
      timeZone: "America/Los_Angeles", // valid IANA zone per schema expectations
      format: "Online",
      type: "Webinar", // valid enum value
      organizer: "Automation Bot",
      phone: "1234567890", // organizer phone required in embedded organizer schema
      roles: [
        {
          id: "helper-role",
          name: "Helper",
          description: "General assistance",
          maxParticipants: 5,
        },
      ],
      createdBy: user._id,
    } as any);
    eventId = String(event._id);
    const reg = await Registration.create({
      userId: user._id,
      eventId: event._id,
      roleId: "helper-role", // match the role id in event.roles
      userSnapshot: {
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
      eventSnapshot: {
        title: event.title,
        date: event.date,
        time: event.time,
        location: "Virtual", // event.format is Online so virtual location placeholder
        type: event.type,
        roleName: "Helper",
        roleDescription: "General assistance",
      },
      registeredBy: user._id,
    } as any);
    assignmentId = String(reg._id);
  }, 30000);

  it("enforces rate limit after threshold", async () => {
    const token = createRoleAssignmentRejectionToken({
      assignmentId,
      assigneeId: userId,
    });
    // Hit validate endpoint until limit triggers (limit small enough for test config)
    let limited = false;
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get(
        `/api/role-assignments/reject/validate?token=${token}`
      );
      if (res.status === 429) {
        limited = true;
        expect(res.body.code).toBe("ASSIGNMENT_REJECTION_RATE_LIMIT");
        break;
      } else {
        // Provide clearer diagnostics if an unexpected status appears
        if (![200, 429].includes(res.status)) {
          // Throw with iteration context
          throw new Error(
            `Unexpected status ${
              res.status
            } at iteration ${i}. Body: ${JSON.stringify(res.body)}`
          );
        }
      }
    }
    expect(limited).toBe(true);
    const metrics = RejectionMetricsService.getAll();
    expect(metrics.rate_limited).toBeGreaterThanOrEqual(1);
  });
});
