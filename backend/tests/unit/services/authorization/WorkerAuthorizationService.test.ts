import { describe, expect, it, vi } from "vitest";
import {
  WorkerAuthorizationError,
  WorkerAuthorizationService,
  WORKER_CAPABILITIES,
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_CAPABILITIES,
  WORKER_SERVICE_KEYS,
  type WorkerCapabilityFor,
  type WorkerRunContext,
  type WorkerServiceKey,
} from "../../../../src/services/authorization/WorkerAuthorizationService";
import { AUTHORIZATION_ACTIONS } from "../../../../src/services/authorization/types";

vi.mock("../../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

const allowedDecision = {
  allowed: true,
  reasonCode: "allowed",
  concealExistence: false,
} as const;

const workerGrants = [
  [
    WORKER_SERVICE_KEYS.EVENT_REMINDER,
    [WORKER_CAPABILITIES.EVENT_REMINDER_SEND],
  ],
  [
    WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
    [WORKER_CAPABILITIES.ALUMNI_OUTCOME_AUTO_CONFIRM],
  ],
  [
    WORKER_SERVICE_KEYS.ALUMNI_RETENTION,
    [WORKER_CAPABILITIES.ALUMNI_RETENTION_PURGE],
  ],
  [
    WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX,
    [
      WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_DELIVER,
      WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_RECONCILE,
    ],
  ],
  [
    WORKER_SERVICE_KEYS.PROGRAM_MEMBERSHIP_RECONCILER,
    [WORKER_CAPABILITIES.PROGRAM_MEMBERSHIP_RECONCILE],
  ],
] as const;

describe("WorkerAuthorizationService", () => {
  it.each(workerGrants)(
    "creates a fixed worker context and allows %s its registered capabilities",
    async (serviceKey, capabilities) => {
      const service = new WorkerAuthorizationService();
      const runContext = service.createRunContext(
        serviceKey,
        WORKER_RUN_TRIGGERS.SCHEDULED,
      );

      expect(runContext).toMatchObject({
        source: "worker",
        trigger: WORKER_RUN_TRIGGERS.SCHEDULED,
        principal: {
          kind: "service",
          serviceKey,
          capabilities,
        },
      });
      expect(runContext.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(runContext.principal.runId).toBe(runContext.runId);
      expect(Object.isFrozen(runContext)).toBe(true);
      expect(Object.isFrozen(runContext.principal)).toBe(true);
      expect(Object.isFrozen(runContext.principal.capabilities)).toBe(true);

      for (const capability of capabilities) {
        await expect(
          service.assertCapability(runContext, capability),
        ).resolves.toBeUndefined();
      }
    },
  );

  it("carries trigger and optional initiating user in the run context", () => {
    const service = new WorkerAuthorizationService();

    const runContext = service.createRunContext(
      WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX,
      WORKER_RUN_TRIGGERS.MANUAL,
      "  user-123  ",
    );

    expect(runContext.trigger).toBe(WORKER_RUN_TRIGGERS.MANUAL);
    expect(runContext.initiatedByUserId).toBe("user-123");
    expect(runContext.principal.initiatedByUserId).toBe("user-123");
  });

  it("rejects an empty or oversized initiating user identifier", () => {
    const service = new WorkerAuthorizationService();

    expect(() =>
      service.createRunContext(
        WORKER_SERVICE_KEYS.EVENT_REMINDER,
        WORKER_RUN_TRIGGERS.MANUAL,
        "   ",
      ),
    ).toThrow("initiatedByUserId");
    expect(() =>
      service.createRunContext(
        WORKER_SERVICE_KEYS.EVENT_REMINDER,
        WORKER_RUN_TRIGGERS.MANUAL,
        "x".repeat(257),
      ),
    ).toThrow("initiatedByUserId");
  });

  it("throws before constructing a context for an unknown service", () => {
    const service = new WorkerAuthorizationService();

    expect(() =>
      service.createRunContext(
        "unknown-worker" as WorkerServiceKey,
        WORKER_RUN_TRIGGERS.SCHEDULED,
      ),
    ).toThrow("Unknown worker service: unknown-worker");
  });

  it("denies an unknown service even when a forged context declares capabilities", async () => {
    const service = new WorkerAuthorizationService();
    const validContext = service.createRunContext(
      WORKER_SERVICE_KEYS.EVENT_REMINDER,
      WORKER_RUN_TRIGGERS.SCHEDULED,
    );
    const forgedContext = {
      ...validContext,
      principal: {
        ...validContext.principal,
        serviceKey: "unknown-worker",
        capabilities: [WORKER_CAPABILITIES.EVENT_REMINDER_SEND],
      },
    } as unknown as WorkerRunContext<typeof WORKER_SERVICE_KEYS.EVENT_REMINDER>;

    const decision = await service.authorizeCapability(
      forgedContext,
      WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
    );

    expect(decision).toEqual({
      allowed: false,
      reasonCode: "invalid_context",
      concealExistence: true,
    });
  });

  it("denies forged or tampered contexts before consulting the core policy", async () => {
    const authorize = vi.fn().mockResolvedValue(allowedDecision);
    const service = new WorkerAuthorizationService({ authorize });
    const validContext = service.createRunContext(
      WORKER_SERVICE_KEYS.EVENT_REMINDER,
      WORKER_RUN_TRIGGERS.SCHEDULED,
      "user-123",
    );

    const tamperedContexts = [
      { ...validContext, source: "http" },
      { ...validContext, runId: "different-run" },
      { ...validContext, trigger: "unknown-trigger" },
      {
        ...validContext,
        principal: {
          ...validContext.principal,
          serviceKey: WORKER_SERVICE_KEYS.ALUMNI_OUTCOME,
          capabilities: [WORKER_CAPABILITIES.ALUMNI_OUTCOME_AUTO_CONFIRM],
        },
      },
      {
        ...validContext,
        principal: {
          ...validContext.principal,
          capabilities: [
            WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
            WORKER_CAPABILITIES.ALUMNI_OUTCOME_AUTO_CONFIRM,
          ],
        },
      },
      {
        ...validContext,
        principal: {
          ...validContext.principal,
          runId: "different-run",
        },
      },
      { ...validContext, initiatedByUserId: "different-user" },
    ];

    for (const tamperedContext of tamperedContexts) {
      await expect(
        service.authorizeCapability(
          tamperedContext as unknown as WorkerRunContext<
            typeof WORKER_SERVICE_KEYS.EVENT_REMINDER
          >,
          WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
        ),
      ).resolves.toEqual({
        allowed: false,
        reasonCode: "invalid_context",
        concealExistence: true,
      });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it("does not accept a context issued by another service instance", async () => {
    const issuer = new WorkerAuthorizationService();
    const verifier = new WorkerAuthorizationService({
      authorize: vi.fn().mockResolvedValue(allowedDecision),
    });
    const context = issuer.createRunContext(
      WORKER_SERVICE_KEYS.EVENT_REMINDER,
      WORKER_RUN_TRIGGERS.SCHEDULED,
    );

    await expect(
      verifier.assertCapability(
        context,
        WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
      ),
    ).rejects.toMatchObject({
      name: "WorkerAuthorizationError",
      decision: { reasonCode: "invalid_context" },
    });
  });

  it("denies known and unknown capabilities that are not in the fixed service grant", async () => {
    const service = new WorkerAuthorizationService();
    const runContext = service.createRunContext(
      WORKER_SERVICE_KEYS.EVENT_REMINDER,
      WORKER_RUN_TRIGGERS.SCHEDULED,
    );
    const mismatchedCapability =
      WORKER_CAPABILITIES.ALUMNI_OUTCOME_AUTO_CONFIRM as WorkerCapabilityFor<
        typeof WORKER_SERVICE_KEYS.EVENT_REMINDER
      >;
    const unknownCapability =
      "worker.unknown" as WorkerCapabilityFor<
        typeof WORKER_SERVICE_KEYS.EVENT_REMINDER
      >;

    await expect(
      service.assertCapability(runContext, mismatchedCapability),
    ).rejects.toMatchObject({
      name: "WorkerAuthorizationError",
      decision: {
        allowed: false,
        reasonCode: "worker_capability_denied",
      },
    });
    await expect(
      service.assertCapability(runContext, unknownCapability),
    ).rejects.toBeInstanceOf(WorkerAuthorizationError);
  });

  it("builds the core WORKER_EXECUTE request from fixed grants and protected context", async () => {
    const authorize = vi.fn().mockResolvedValue(allowedDecision);
    const service = new WorkerAuthorizationService({ authorize });
    const runContext = service.createRunContext(
      WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX,
      WORKER_RUN_TRIGGERS.RECOVERY,
      "admin-456",
    );

    const decision = await service.authorizeCapability(
      runContext,
      WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_DELIVER,
      {
        resource: { type: "notification_outbox", id: "outbox-789" },
        context: {
          capability: "caller-supplied-capability",
          runId: "caller-supplied-run-id",
          trigger: "caller-supplied-trigger",
          batchSize: 25,
        },
      },
    );

    expect(decision).toBe(allowedDecision);
    expect(authorize).toHaveBeenCalledWith({
      source: "worker",
      principal: {
        kind: "service",
        serviceKey: WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX,
        capabilities:
          WORKER_SERVICE_CAPABILITIES[
            WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX
          ],
        runId: runContext.runId,
        initiatedByUserId: "admin-456",
      },
      action: AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
      resource: { type: "notification_outbox", id: "outbox-789" },
      context: {
        capability: WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_DELIVER,
        runId: runContext.runId,
        trigger: WORKER_RUN_TRIGGERS.RECOVERY,
        initiatedByUserId: "admin-456",
        batchSize: 25,
      },
    });
  });

  it("throws the core fail-closed decision from assertCapability", async () => {
    const deniedDecision = {
      allowed: false,
      reasonCode: "authorization_error",
      concealExistence: true,
    } as const;
    const authorize = vi.fn().mockResolvedValue(deniedDecision);
    const service = new WorkerAuthorizationService({ authorize });
    const runContext = service.createRunContext(
      WORKER_SERVICE_KEYS.PROGRAM_MEMBERSHIP_RECONCILER,
      WORKER_RUN_TRIGGERS.RECOVERY,
    );

    await expect(
      service.assertCapability(
        runContext,
        WORKER_CAPABILITIES.PROGRAM_MEMBERSHIP_RECONCILE,
      ),
    ).rejects.toMatchObject({
      name: "WorkerAuthorizationError",
      decision: deniedDecision,
    });
  });
});
