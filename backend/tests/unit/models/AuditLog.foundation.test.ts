import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import AuditLog from "../../../src/models/AuditLog";

describe("AuditLog versioned foundation", () => {
  const userId = new mongoose.Types.ObjectId();

  it("keeps legacy records valid and defaults them to version 1", () => {
    const legacy = new AuditLog({
      action: "EventPublished",
      actorId: userId,
      eventId: new mongoose.Types.ObjectId(),
      metadata: { publicSlug: "legacy-event" },
    });

    expect(legacy.validateSync()).toBeUndefined();
    expect(legacy.version).toBe(1);
    expect(legacy.actorType).toBeNull();
    expect(legacy.source).toBeNull();
  });

  it("allows a version 2 user actor without embedding an email", () => {
    const current = new AuditLog({
      version: 2,
      action: "authorization.denied",
      actorType: "user",
      actorKey: userId.toString(),
      actor: { id: userId, role: "Participant" },
      source: "http",
      correlationId: "request-123",
      outcome: "denied",
      reasonCode: "not_a_member",
      targetModel: "Conversation",
      targetId: "conversation-123",
    });

    expect(current.validateSync()).toBeUndefined();
    expect(current.actor?.email).toBeUndefined();
  });

  it("supports worker and system actor identity fields", () => {
    for (const actorType of ["worker", "system"] as const) {
      const current = new AuditLog({
        version: 2,
        action: "alumni-help.transition",
        actorType,
        actorKey:
          actorType === "worker" ? "outcome-auto-confirm" : "policy-engine",
        source: actorType,
        outcome: "success",
      });
      expect(current.validateSync()).toBeUndefined();
    }
  });

  it("declares actor/time and target/time compound indexes", () => {
    const indexes = AuditLog.schema.indexes().map(([fields]) => fields);

    expect(indexes).toContainEqual({
      actorType: 1,
      actorKey: 1,
      createdAt: -1,
    });
    expect(indexes).toContainEqual({
      targetModel: 1,
      targetId: 1,
      createdAt: -1,
    });
  });
});
