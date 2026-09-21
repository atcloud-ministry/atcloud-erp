import { describe, expect, it, vi } from "vitest";
import {
  WORKER_CAPABILITIES,
  WORKER_RUN_TRIGGERS,
  WORKER_SERVICE_KEYS,
  WorkerAuthorizationService,
} from "../../../../src/services/authorization/WorkerAuthorizationService";
import type { ClaimedNotificationOutbox } from "../../../../src/services/reliability/NotificationOutboxService";
import { NotificationOutboxWorkerAuthorization } from "../../../../src/services/reliability/NotificationOutboxWorkerAuthorization";

const event = {
  eventId: "11111111-1111-4111-8111-111111111111",
  topic: "system_message.created",
  payloadVersion: 1,
} as ClaimedNotificationOutbox;

describe("NotificationOutboxWorkerAuthorization", () => {
  it("starts a protected run at reconciliation and scopes delivery by eventId", async () => {
    const authorization = new WorkerAuthorizationService();
    const createRunContext = vi.spyOn(authorization, "createRunContext");
    const assertCapability = vi.spyOn(authorization, "assertCapability");
    const adapter = new NotificationOutboxWorkerAuthorization({
      authorization,
      trigger: WORKER_RUN_TRIGGERS.RECOVERY,
      initiatedByUserId: "admin-1",
    });

    await adapter.assertCanReconcile();
    await adapter.assertCanDeliver(event);

    expect(createRunContext).toHaveBeenCalledWith(
      WORKER_SERVICE_KEYS.NOTIFICATION_OUTBOX,
      WORKER_RUN_TRIGGERS.RECOVERY,
      "admin-1",
    );
    const runContext = createRunContext.mock.results[0].value;
    expect(assertCapability).toHaveBeenNthCalledWith(
      1,
      runContext,
      WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_RECONCILE,
      {
        resource: { type: "notification_outbox", id: "reconciliation" },
      },
    );
    expect(assertCapability).toHaveBeenNthCalledWith(
      2,
      runContext,
      WORKER_CAPABILITIES.NOTIFICATION_OUTBOX_DELIVER,
      {
        resource: { type: "notification_outbox", id: event.eventId },
        context: {
          topic: event.topic,
          payloadVersion: event.payloadVersion,
        },
      },
    );
  });

  it("fails closed when delivery is attempted before run authorization", async () => {
    const adapter = new NotificationOutboxWorkerAuthorization({
      authorization: new WorkerAuthorizationService(),
    });

    await expect(adapter.assertCanDeliver(event)).rejects.toThrow(
      "requires an active run",
    );
  });

  it("replaces the protected context at the beginning of every run", async () => {
    const authorization = new WorkerAuthorizationService();
    const assertCapability = vi.spyOn(authorization, "assertCapability");
    const adapter = new NotificationOutboxWorkerAuthorization({ authorization });

    await adapter.assertCanReconcile();
    await adapter.assertCanDeliver(event);
    const firstContext = assertCapability.mock.calls[1][0];
    await adapter.assertCanReconcile();
    await adapter.assertCanDeliver(event);
    const secondContext = assertCapability.mock.calls[3][0];

    expect(firstContext.runId).not.toBe(secondContext.runId);
  });

  it("does not publish a run context after its authorization is aborted", async () => {
    let finishAuthorization: (() => void) | undefined;
    const authorization = {
      createRunContext: vi.fn(() => ({ runId: "run-1" })),
      assertCapability: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishAuthorization = resolve;
          }),
      ),
    };
    const adapter = new NotificationOutboxWorkerAuthorization({
      authorization: authorization as never,
    });
    const controller = new AbortController();
    const checking = adapter.assertCanReconcile(controller.signal);
    controller.abort(new Error("authorization timeout"));
    finishAuthorization?.();

    await expect(checking).rejects.toThrow("authorization timeout");
    await expect(adapter.assertCanDeliver(event)).rejects.toThrow(
      "requires an active run",
    );
  });
});
