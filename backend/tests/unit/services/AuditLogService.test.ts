import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  loggerError: vi.fn(),
  metricIncrement: vi.fn(),
}));

vi.mock("../../../src/models/AuditLog", () => ({
  default: { create: mocks.create },
}));

vi.mock("../../../src/services/LoggerService", () => ({
  createLogger: vi.fn(() => ({ error: mocks.loggerError })),
}));

vi.mock("../../../src/services/PrometheusMetricsService", () => ({
  auditLogWriteFailureCounter: { inc: mocks.metricIncrement },
}));

import {
  AUDIT_DETAIL_LIMITS,
  AuditLogService,
  sanitizeAuditDetails,
} from "../../../src/services/AuditLogService";

describe("AuditLogService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ _id: "audit-id" });
  });

  it("writes an explicit privacy-safe version 2 user audit record", async () => {
    const input = {
      action: "authorization.denied",
      actor: {
        type: "user" as const,
        id: "507f1f77bcf86cd799439011",
        role: "Participant",
      },
      source: "http" as const,
      outcome: "denied" as const,
      target: { model: "Conversation", id: "conversation-123" },
      correlationId: "request-123",
      reasonCode: "not_a_member",
      details: {
        message: "private chat body",
        messageId: "message-123",
        nested: {
          email: "person@example.com",
          ipAddress: "203.0.113.10",
          accessToken: "top-secret-token",
          safeSummary: "Contact person@example.com from 203.0.113.10",
          networkSummary: "IPv6 2001:db8::1",
          count: 3,
        },
      },
      hashes: {
        email: "a".repeat(64),
        ip: "B".repeat(64),
      },
      userAgent: "Agent person@example.com via 203.0.113.10",
      // Prove that runtime callers cannot smuggle legacy raw fields through a spread.
      email: "actor@example.com",
      ipAddress: "198.51.100.2",
    };

    await expect(AuditLogService.record(input)).resolves.toBe(true);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const payload = mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 2,
      action: "authorization.denied",
      actorType: "user",
      actorKey: "507f1f77bcf86cd799439011",
      actorId: "507f1f77bcf86cd799439011",
      actor: {
        id: "507f1f77bcf86cd799439011",
        role: "Participant",
      },
      source: "http",
      outcome: "denied",
      targetModel: "Conversation",
      targetId: "conversation-123",
      correlationId: "request-123",
      reasonCode: "not_a_member",
      emailHash: "a".repeat(64),
      ipHash: "b".repeat(64),
    });
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("ipAddress");
    expect(payload.actor).not.toHaveProperty("email");

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("private chat body");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("actor@example.com");
    expect(serialized).not.toContain("203.0.113.10");
    expect(serialized).not.toContain("2001:db8::1");
    expect(serialized).not.toContain("198.51.100.2");
    expect(serialized).not.toContain("top-secret-token");
    expect(payload.details).toMatchObject({
      messageId: "message-123",
      nested: { count: 3 },
    });
    expect(JSON.stringify(payload.details)).toContain("[REDACTED]");
  });

  it.each([
    { actor: { type: "worker" as const, key: "outcome-auto-confirm" } },
    { actor: { type: "system" as const, key: "authorization-engine" } },
  ])("supports $actor.type actors without user PII", async ({ actor }) => {
    await expect(
      AuditLogService.record({
        action: "alumni-help.transition",
        actor,
        source: actor.type === "worker" ? "worker" : "system",
        outcome: "success",
      }),
    ).resolves.toBe(true);

    const payload = mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 2,
      actorType: actor.type,
      actorKey: actor.key,
    });
    expect(payload).not.toHaveProperty("actor");
    expect(payload).not.toHaveProperty("actorId");
    expect(payload).not.toHaveProperty("email");
  });

  it("recursively bounds hostile, circular, and oversized details", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const details: Record<string, unknown> = {
      safe: "x".repeat(AUDIT_DETAIL_LIMITS.maxStringLength + 100),
      values: Array.from(
        { length: AUDIT_DETAIL_LIMITS.maxArrayItems + 5 },
        (_, index) => index,
      ),
      description: "free-form private prose",
      revokedProxy: revoked.proxy,
    };
    details.self = details;
    Object.defineProperty(details, "dangerousGetter", {
      enumerable: true,
      get: () => {
        throw new Error("getter should not run");
      },
    });

    const sanitized = sanitizeAuditDetails(details);
    const serialized = JSON.stringify(sanitized);

    expect(serialized.length).toBeLessThanOrEqual(
      AUDIT_DETAIL_LIMITS.maxSerializedLength,
    );
    expect(sanitized.safe).toContain("[TRUNCATED]");
    expect(sanitized.values).toHaveLength(
      AUDIT_DETAIL_LIMITS.maxArrayItems + 1,
    );
    expect(Object.values(sanitized)).toContain("[REDACTED]");
    expect(sanitized.self).toBe("[CIRCULAR]");
    expect(sanitized.dangerousGetter).toBe("[REDACTED]");
    expect(sanitized.revokedProxy).toBe("[UNSUPPORTED]");
  });

  it("never preserves sensitive text from object keys", () => {
    const sanitized = sanitizeAuditDetails({
      "2001:db8::1": "ipv6-value",
      "trace-203.0.113.10": "ipv4-value",
      "token-secret-value": "credential-value",
      safeId: "safe-value",
    });
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.safeId).toBe("safe-value");
    expect(serialized).not.toContain("2001:db8::1");
    expect(serialized).not.toContain("203.0.113.10");
    expect(serialized).not.toContain("token-secret-value");
    expect(serialized).not.toContain("ipv6-value");
    expect(serialized).not.toContain("credential-value");
    expect(serialized).toContain("_redacted_");
  });

  it("redacts contact and credential patterns even without word boundaries", () => {
    const sanitized = sanitizeAuditDetails({
      externalId: "traceperson@example.comsuffix",
      requestId: "prefixBearer top-secret-value",
      correlationCode: "trace203.0.113.10suffix",
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain("203.0.113.10");
    expect(serialized).toContain("[EMAIL_REDACTED]");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[IP_REDACTED]");
  });

  it("preserves safe timestamp strings while redacting exact IPv6 substrings", () => {
    const sanitized = sanitizeAuditDetails({
      occurredAt: "2026-09-08T17:42:49.000Z",
      timeCode: "17:42:49",
      externalId: "prefix2001:db8::1facesuffix",
    });

    expect(sanitized.occurredAt).toBe("2026-09-08T17:42:49.000Z");
    expect(sanitized.timeCode).toBe("17:42:49");
    expect(String(sanitized.externalId)).not.toContain("2001:db8::1");
    expect(String(sanitized.externalId)).toContain("[IP_REDACTED]");
  });

  it("uses intrinsic Date methods and counts the result in the string budget", () => {
    const date = new Date("2026-09-08T17:42:49.000Z");
    date.toISOString = () => "person@example.com";
    date.getTime = () => 0;

    const sanitized = sanitizeAuditDetails({ occurredAt: date });

    expect(sanitized.occurredAt).toBe("2026-09-08T17:42:49.000Z");
    expect(JSON.stringify(sanitized)).not.toContain("person@example.com");
  });

  it("persists a core denial when optional identifiers and hashes are hostile", async () => {
    const rawTargetId = "conversation-for-person@example.com";

    await expect(
      AuditLogService.record({
        action: "authorization.denied",
        actor: {
          type: "user",
          id: "507f1f77bcf86cd799439011",
          role: "Participant",
        },
        source: "http",
        outcome: "denied",
        target: { model: "Conversation", id: rawTargetId },
        correlationId: "request person@example.com",
        reasonCode: "private reason for person@example.com",
        hashes: {
          email: "person@example.com",
          ip: "203.0.113.10",
        },
      }),
    ).resolves.toBe(true);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const payload = mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 2,
      action: "authorization.denied",
      actorType: "user",
      actorKey: "507f1f77bcf86cd799439011",
      source: "http",
      outcome: "denied",
      targetModel: "Conversation",
    });
    expect(payload.targetId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payload).not.toHaveProperty("correlationId");
    expect(payload).not.toHaveProperty("reasonCode");
    expect(payload).not.toHaveProperty("emailHash");
    expect(payload).not.toHaveProperty("ipHash");
    expect(JSON.stringify(payload)).not.toContain("person@example.com");
    expect(JSON.stringify(payload)).not.toContain("203.0.113.10");
    expect(mocks.metricIncrement).not.toHaveBeenCalled();
  });

  it("omits an invalid optional target model without cancelling the record", async () => {
    await expect(
      AuditLogService.record({
        action: "authorization.denied",
        actor: { type: "system", key: "authorization-engine" },
        source: "system",
        outcome: "denied",
        target: {
          model: "person@example.com",
          id: "private-target@example.com",
        },
      }),
    ).resolves.toBe(true);

    const payload = mocks.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("targetModel");
    expect(payload).not.toHaveProperty("targetId");
    expect(JSON.stringify(payload)).not.toContain("example.com");
  });

  it("returns false, logs safely, and increments a bounded failure metric", async () => {
    mocks.create.mockRejectedValueOnce(
      new Error("database temporarily unavailable"),
    );

    const result = await AuditLogService.record({
      action: "conversation.access",
      actor: { type: "system", key: "policy-engine" },
      source: "system",
      outcome: "failure",
      details: { body: "must never reach failure telemetry" },
    });

    expect(result).toBe(false);
    expect(mocks.metricIncrement).toHaveBeenCalledWith({ source: "system" });
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][3]).toEqual({
      action: "conversation.access",
      source: "system",
    });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      "must never reach failure telemetry",
    );
  });

  it("fails closed on unsafe identifiers without persisting their raw value", async () => {
    const result = await AuditLogService.record({
      action: "conversation.access",
      actor: { type: "system", key: "operator@example.com" },
      source: "system",
      outcome: "failure",
    });

    expect(result).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.metricIncrement).toHaveBeenCalledWith({ source: "system" });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      "operator@example.com",
    );
  });
});
