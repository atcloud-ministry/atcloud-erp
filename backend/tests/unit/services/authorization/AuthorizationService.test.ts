import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/models", () => ({
  Event: { findById: vi.fn() },
  Program: { findById: vi.fn() },
  Purchase: { findOne: vi.fn() },
}));

vi.mock("../../../../src/utils/event/eventPermissions", () => ({
  isAffiliatedProgramEditor: vi.fn(),
}));

vi.mock("../../../../src/services/AnnualMembershipAccessService", () => ({
  hasAnnualMembershipAccessToPrograms: vi.fn(),
}));

import { Event, Program, Purchase } from "../../../../src/models";
import {
  AuthorizationService,
  createUserAuthorizationPrincipal,
} from "../../../../src/services/authorization/AuthorizationService";
import { AUTHORIZATION_ACTIONS } from "../../../../src/services/authorization/types";
import { isAffiliatedProgramEditor } from "../../../../src/utils/event/eventPermissions";
import { PERMISSIONS } from "../../../../src/utils/roleUtils";
import { hasAnnualMembershipAccessToPrograms } from "../../../../src/services/AnnualMembershipAccessService";

const selected = (value: unknown) => ({
  select: vi.fn().mockResolvedValue(value),
});

const user = (
  role: "Participant" | "Leader" | "Administrator" = "Participant",
) => ({
  kind: "user" as const,
  userId: new mongoose.Types.ObjectId().toString(),
  role,
  isActive: true,
  isVerified: true,
});

describe("AuthorizationService", () => {
  const service = new AuthorizationService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAffiliatedProgramEditor).mockResolvedValue(false);
    vi.mocked(hasAnnualMembershipAccessToPrograms).mockResolvedValue(false);
  });

  it("denies unregistered actions and conceals the resource", async () => {
    await expect(
      service.authorize({
        source: "http",
        principal: user(),
        action: "conversation.unregistered_action",
        resource: { type: "conversation", id: "secret" },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "policy_not_found",
      concealExistence: true,
    });
  });

  it("rejects inactive and unverified user principals before policy work", async () => {
    const base = user();
    await expect(
      service.authorize({
        source: "http",
        principal: { ...base, isActive: false },
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.VIEW_USER_PROFILES },
      }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "principal_inactive" });

    await expect(
      service.authorize({
        source: "socket",
        principal: { ...base, isVerified: false },
        action: AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME,
        resource: { type: "event", id: new mongoose.Types.ObjectId().toString() },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "principal_unverified",
    });
    expect(Event.findById).not.toHaveBeenCalled();
  });

  it("rejects forged transport and principal fields before policy work", async () => {
    await expect(
      service.authorize({
        source: "browser" as any,
        principal: user(),
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.VIEW_USER_PROFILES },
      }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "invalid_context" });

    await expect(
      service.authorize({
        source: "http",
        principal: { ...user(), userId: "" },
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.VIEW_USER_PROFILES },
      }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "invalid_context" });

    await expect(
      service.authorize({
        source: "http",
        principal: { ...user(), role: "Owner" as any },
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.VIEW_USER_PROFILES },
      }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: "invalid_context" });
  });

  it.each([
    ["a null request", null],
    [
      "a non-string user id",
      {
        source: "http",
        principal: { ...user(), userId: 42 },
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
      },
    ],
    [
      "a non-string service key",
      {
        source: "worker",
        principal: { kind: "service", serviceKey: 42, capabilities: [] },
        action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
      },
    ],
    [
      "an unknown principal kind",
      {
        source: "http",
        principal: { kind: "anonymous" },
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
      },
    ],
  ])("fails closed for %s without rejecting", async (_label, request) => {
    await expect(
      service.authorize(request as any),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "invalid_context",
      concealExistence: true,
    });
  });

  it("uses the same role permission policy for HTTP callers", async () => {
    await expect(
      service.authorize({
        source: "http",
        principal: user("Leader"),
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.CREATE_EVENT },
      }),
    ).resolves.toMatchObject({ allowed: true, reasonCode: "allowed" });

    await expect(
      service.authorize({
        source: "http",
        principal: user("Participant"),
        action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
        context: { permission: PERMISSIONS.CREATE_EVENT },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "insufficient_permission",
    });
  });

  it("authorizes an event organizer and denies unrelated users", async () => {
    const eventId = new mongoose.Types.ObjectId().toString();
    const principal = user();
    const event = { _id: eventId, createdBy: principal.userId };
    vi.mocked(Event.findById).mockReturnValue(selected(event) as never);

    await expect(
      service.authorize({
        source: "http",
        principal,
        action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
        resource: { type: "event", id: eventId },
      }),
    ).resolves.toMatchObject({ allowed: true });

    vi.mocked(Event.findById).mockReturnValue(
      selected({ ...event, createdBy: new mongoose.Types.ObjectId() }) as never,
    );

    await expect(
      service.authorize({
        source: "http",
        principal: user(),
        action: AUTHORIZATION_ACTIONS.EVENT_MANAGE,
        resource: { type: "event", id: eventId },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "not_resource_member",
    });
  });

  it("fails closed when a resource lookup fails", async () => {
    const query = selected(null);
    query.select.mockRejectedValueOnce(new Error("database unavailable"));
    vi.mocked(Event.findById).mockReturnValue(query as never);

    await expect(
      service.authorize({
        source: "socket",
        principal: user(),
        action: AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME,
        resource: { type: "event", id: new mongoose.Types.ObjectId().toString() },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "authorization_error",
      concealExistence: true,
    });
  });

  it("conceals paid event subscriptions from users without access", async () => {
    const eventId = new mongoose.Types.ObjectId().toString();
    vi.mocked(Event.findById).mockReturnValue(
      selected({
        _id: eventId,
        pricing: { isFree: false },
        createdBy: new mongoose.Types.ObjectId(),
        organizerDetails: [],
        programLabels: [],
      }) as never,
    );
    vi.mocked(Purchase.findOne).mockReturnValue(selected(null) as never);

    await expect(
      service.authorize({
        source: "socket",
        principal: user(),
        action: AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME,
        resource: { type: "event", id: eventId },
      }),
    ).resolves.toEqual({
      allowed: false,
      reasonCode: "not_resource_member",
      concealExistence: true,
    });
    expect(isAffiliatedProgramEditor).toHaveBeenCalled();
  });

  it("allows a paid event subscription with a completed event purchase", async () => {
    const eventId = new mongoose.Types.ObjectId().toString();
    vi.mocked(Event.findById).mockReturnValue(
      selected({
        _id: eventId,
        pricing: { isFree: false },
        createdBy: new mongoose.Types.ObjectId(),
        organizerDetails: [],
        programLabels: [],
      }) as never,
    );
    vi.mocked(Purchase.findOne).mockReturnValue(
      selected({ _id: new mongoose.Types.ObjectId() }) as never,
    );

    await expect(
      service.authorize({
        source: "socket",
        principal: user(),
        action: AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME,
        resource: { type: "event", id: eventId },
      }),
    ).resolves.toMatchObject({ allowed: true, reasonCode: "allowed" });
  });

  it.each(["program mentor", "admin-enrolled class rep"])(
    "allows a paid linked-event subscription for a %s",
    async () => {
      const eventId = new mongoose.Types.ObjectId().toString();
      const programId = new mongoose.Types.ObjectId();
      const principal = user("Leader");
      const event = {
        _id: eventId,
        pricing: { isFree: false },
        createdBy: new mongoose.Types.ObjectId(),
        organizerDetails: [],
        programLabels: [programId],
      };
      vi.mocked(Event.findById).mockReturnValue(selected(event) as never);
      vi.mocked(isAffiliatedProgramEditor).mockResolvedValue(true);

      await expect(
        service.authorize({
          source: "socket",
          principal,
          action: AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME,
          resource: { type: "event", id: eventId },
        }),
      ).resolves.toMatchObject({ allowed: true, reasonCode: "allowed" });
      expect(isAffiliatedProgramEditor).toHaveBeenCalledWith(
        event,
        principal.userId,
        principal.role,
      );
    },
  );

  it("recognizes current Program class-rep purchase access", async () => {
    const principal = user();
    const programId = new mongoose.Types.ObjectId().toString();
    vi.mocked(Program.findById).mockReturnValue(
      selected({
        _id: programId,
        createdBy: new mongoose.Types.ObjectId(),
        mentors: [],
        adminEnrollments: { classReps: [] },
      }) as never,
    );
    vi.mocked(Purchase.findOne).mockReturnValue(selected({ _id: "purchase" }) as never);

    await expect(
      service.authorize({
        source: "http",
        principal,
        action: AUTHORIZATION_ACTIONS.PROGRAM_MANAGE,
        resource: { type: "program", id: programId },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("requires worker source and an explicitly granted capability", async () => {
    const principal = {
      kind: "service" as const,
      serviceKey: "event-reminder-scheduler",
      capabilities: ["event-reminder.dispatch"],
      runId: "run-1",
    };

    await expect(
      service.authorize({
        source: "worker",
        principal,
        action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
        context: { capability: "event-reminder.dispatch" },
      }),
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      service.authorize({
        source: "worker",
        principal,
        action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
        context: { capability: "alumni-outcome.confirm" },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "worker_capability_denied",
    });

    await expect(
      service.authorize({
        source: "http",
        principal,
        action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
        context: { capability: "event-reminder.dispatch" },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "principal_source_mismatch",
    });
  });

  it("builds an immutable, minimal user principal", () => {
    const principal = createUserAuthorizationPrincipal({
      _id: "user-1",
      role: "Participant",
      isActive: true,
      isVerified: true,
      email: "private@example.com",
    });

    expect(principal).toEqual({
      kind: "user",
      userId: "user-1",
      role: "Participant",
      isActive: true,
      isVerified: true,
    });
    expect(Object.isFrozen(principal)).toBe(true);
  });
});
