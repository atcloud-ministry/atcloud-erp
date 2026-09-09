import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/AuditLogService", () => ({
  AuditLogService: { record: vi.fn().mockResolvedValue(true) },
}));

import { AuditLogService } from "../../../../src/services/AuditLogService";
import { recordAuthorizationDenial } from "../../../../src/services/authorization/AuthorizationAuditService";

describe("recordAuthorizationDenial", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a user denial with only structured authorization metadata", () => {
    recordAuthorizationDenial(
      {
        source: "socket",
        principal: {
          kind: "user",
          userId: "507f1f77bcf86cd799439011",
          role: "Participant",
          isActive: true,
          isVerified: true,
        },
        action: "event.subscribe_realtime",
        resource: { type: "event", id: "507f191e810c19729de860ea" },
      },
      {
        allowed: false,
        reasonCode: "not_resource_member",
        concealExistence: true,
      },
      "socket-run-1",
    );

    expect(AuditLogService.record).toHaveBeenCalledWith({
      action: "authorization.denied",
      actor: {
        type: "user",
        id: "507f1f77bcf86cd799439011",
        role: "Participant",
      },
      source: "socket",
      outcome: "denied",
      target: { model: "Event", id: "507f191e810c19729de860ea" },
      correlationId: "socket-run-1",
      reasonCode: "not_resource_member",
      details: {
        authorizationAction: "event.subscribe_realtime",
        resourceType: "event",
      },
    });
  });

  it("does not write allowed decisions", () => {
    recordAuthorizationDenial(
      {
        source: "worker",
        principal: {
          kind: "service",
          serviceKey: "event-reminder",
          capabilities: ["event.reminder.send"],
        },
        action: "worker.execute",
      },
      { allowed: true, reasonCode: "allowed", concealExistence: false },
    );

    expect(AuditLogService.record).not.toHaveBeenCalled();
  });
});
