import { describe, expect, it, vi } from "vitest";
import type { ClientSession } from "mongoose";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import {
  ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC,
  AlumniHelpExternalNotificationDeliveryHandler,
  enqueueAlumniHelpExternalNotification,
  parseAlumniHelpExternalNotificationPayload,
} from "../../../../src/services/alumni/AlumniHelpExternalNotification";
import type { ClaimedNotificationOutbox } from "../../../../src/services/reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
  RetryableNotificationOutboxDeliveryError,
} from "../../../../src/services/reliability/NotificationOutboxWorker";

const REQUESTER = "507f1f77bcf86cd799439011";
const PROVIDER = "507f1f77bcf86cd799439012";
const REQUEST = "507f1f77bcf86cd799439013";
const TIMELINE = "507f1f77bcf86cd799439014";
const EVENT = Object.freeze({
  eventId: "0f7dc682-51a3-4b72-bfac-319a9cc3e5f5",
  topic: ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC,
  payloadVersion: 1,
  payload: {
    workflowEventId: "550e8400-e29b-41d4-a716-446655440001",
    recipientUserId: PROVIDER,
    requestId: REQUEST,
    requestRevision: 7,
    timelineEventId: TIMELINE,
    eventType: "outcome_submit",
    occurredAt: "2033-09-13T12:00:00.000Z",
  },
} as ClaimedNotificationOutbox);

function context() {
  return {
    signal: new AbortController().signal,
    renewLease: vi.fn(),
  };
}

function setup(overrides: {
  readable?: boolean;
  request?: object | null;
  recipient?: object | null;
  route?: "push" | "email" | "skipped" | "retry";
} = {}) {
  const router = {
    deliverHelp: vi.fn().mockResolvedValue({
      route: overrides.route ?? "push",
      push: {
        route: overrides.route === "retry" ? "transient_failure" : "delivered",
        attempted: 1,
        succeeded: overrides.route === "retry" ? 0 : 1,
        permanentFailures: 0,
        transientFailures: overrides.route === "retry" ? 1 : 0,
      },
    }),
  };
  const handler = new AlumniHelpExternalNotificationDeliveryHandler({
    releaseAvailable: () => true,
    runtimeReader: {
      getOperationalRuntimeConfig: vi.fn().mockResolvedValue(
        createRuntimeConfigDTO(overrides.readable === false ? "off" : "on", 1),
      ),
    },
    loadRequest: vi.fn().mockResolvedValue(
      overrides.request === undefined
        ? {
            id: REQUEST,
            requesterId: REQUESTER,
            providerId: PROVIDER,
            revision: 7,
          }
        : overrides.request,
    ),
    loadRecipient: vi.fn().mockResolvedValue(
      overrides.recipient === undefined
        ? { id: PROVIDER, isActive: true, isVerified: true }
        : overrides.recipient,
    ),
    hasWorkflowMessage: vi.fn().mockResolvedValue(true),
    router,
  });
  return { handler, router };
}

describe("AlumniHelpExternalNotification", () => {
  it("enqueues a strict recipient-scoped durable event without help details", async () => {
    const enqueueInTransaction = vi.fn().mockResolvedValue({ eventId: EVENT.eventId });
    const session = { inTransaction: () => true } as unknown as ClientSession;
    await enqueueAlumniHelpExternalNotification(
      {
        ...EVENT.payload,
        session,
      },
      { enqueueInTransaction } as never,
    );
    expect(enqueueInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: ALUMNI_HELP_EXTERNAL_NOTIFICATION_TOPIC,
        dedupeKey: `alumni-help-external:${TIMELINE}:${PROVIDER}`,
        payload: EVENT.payload,
        session,
      }),
    );
    const serialized = JSON.stringify(enqueueInTransaction.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("note");
    expect(serialized).not.toContain("outcomeCode");
    expect(serialized).not.toContain("message");
  });

  it("rejects extra payload properties instead of accepting private details", () => {
    expect(() =>
      parseAlumniHelpExternalNotificationPayload({
        ...EVENT.payload,
        note: "private outcome detail",
      }),
    ).toThrow(PermanentNotificationOutboxDeliveryError);
  });

  it("routes only after the current retained request and recipient authorize it", async () => {
    const { handler, router } = setup();
    await expect(handler.deliver(EVENT, context())).resolves.toBeUndefined();
    expect(router.deliverHelp).toHaveBeenCalledWith({
      eventId: EVENT.eventId,
      requestId: REQUEST,
      requestRevision: 7,
      recipientUserId: PROVIDER,
      signal: expect.any(AbortSignal),
    });
  });

  it("retries until the workflow System Message exists before computing badge", async () => {
    const handler = new AlumniHelpExternalNotificationDeliveryHandler({
      releaseAvailable: () => true,
      runtimeReader: {
        getOperationalRuntimeConfig: vi
          .fn()
          .mockResolvedValue(createRuntimeConfigDTO("on", 1)),
      },
      loadRequest: vi.fn().mockResolvedValue({
        id: REQUEST,
        requesterId: REQUESTER,
        providerId: PROVIDER,
        revision: 7,
      }),
      loadRecipient: vi.fn().mockResolvedValue({
        id: PROVIDER,
        isActive: true,
        isVerified: true,
      }),
      hasWorkflowMessage: vi.fn().mockResolvedValue(false),
      router: { deliverHelp: vi.fn() },
    });
    await expect(handler.deliver(EVENT, context())).rejects.toMatchObject({
      code: "ALUMNI_HELP_WORKFLOW_MESSAGE_PENDING",
    });
  });

  it("permanently drops stale, deleted, inactive, or non-participant recipients", async () => {
    const stale = setup({ request: null }).handler;
    await expect(stale.assertCanDeliver(EVENT, context())).rejects.toBeInstanceOf(
      PermanentNotificationOutboxDeliveryError,
    );

    const inactive = setup({
      recipient: { id: PROVIDER, isActive: false, isVerified: true },
    }).handler;
    await expect(inactive.deliver(EVENT, context())).rejects.toBeInstanceOf(
      PermanentNotificationOutboxDeliveryError,
    );

    const outsider = setup({
      request: {
        id: REQUEST,
        requesterId: REQUESTER,
        providerId: "507f1f77bcf86cd799439099",
        revision: 7,
      },
    }).handler;
    await expect(outsider.deliver(EVENT, context())).rejects.toBeInstanceOf(
      PermanentNotificationOutboxDeliveryError,
    );
  });

  it("defers while unreadable and retries transient Push or SMTP delivery", async () => {
    const unreadable = setup({ readable: false }).handler;
    await expect(unreadable.canClaim(context().signal)).resolves.toBe(false);
    await expect(
      unreadable.assertCanDeliver(EVENT, context()),
    ).rejects.toBeInstanceOf(DeferredNotificationOutboxDeliveryError);

    const transient = setup({ route: "retry" }).handler;
    await expect(transient.deliver(EVENT, context())).rejects.toBeInstanceOf(
      RetryableNotificationOutboxDeliveryError,
    );

    const smtpRouter = setup();
    smtpRouter.router.deliverHelp.mockRejectedValueOnce(
      new Error("smtp://private-provider-detail"),
    );
    await expect(
      smtpRouter.handler.deliver(EVENT, context()),
    ).rejects.toMatchObject({
      code: "ALUMNI_HELP_EXTERNAL_DELIVERY_FAILED",
      message: "ALUMNI_HELP_EXTERNAL_DELIVERY_FAILED",
    });
  });

  it("does not convert worker cancellation into an external delivery retry", async () => {
    const abort = new AbortController();
    const stopReason = new Error("worker stopping");
    const { handler, router } = setup();
    router.deliverHelp.mockImplementationOnce(async () => {
      abort.abort(stopReason);
      throw stopReason;
    });
    await expect(
      handler.deliver(EVENT, { signal: abort.signal, renewLease: vi.fn() }),
    ).rejects.toBe(stopReason);
  });
});
