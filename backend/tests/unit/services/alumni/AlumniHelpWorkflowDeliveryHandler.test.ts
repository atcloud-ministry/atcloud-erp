import { describe, expect, it, vi } from "vitest";
import type { ClientSession } from "mongoose";
import { createRuntimeConfigDTO } from "../../../../src/contracts/runtimeConfig";
import Message, { type IMessage } from "../../../../src/models/Message";
import type { NotificationOutboxDeliveryContext } from "../../../../src/services/reliability/NotificationOutboxDeliveryRegistry";
import type {
  ClaimedNotificationOutbox,
  NotificationOutboxRecord,
} from "../../../../src/services/reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
} from "../../../../src/services/reliability/NotificationOutboxWorker";
import {
  ALUMNI_HELP_WORKFLOW_PAYLOAD_VERSION,
  ALUMNI_HELP_WORKFLOW_TOPIC,
  AlumniHelpWorkflowDeliveryHandler,
  buildRetainedWorkflowRequestFilter,
  enqueueAlumniHelpWorkflowNotifications,
  parseAlumniHelpWorkflowPayload,
} from "../../../../src/services/alumni/AlumniHelpWorkflowDeliveryHandler";
import { buildAlumniHelpActionRequiredFilter } from "../../../../src/services/alumni/AlumniHelpActionCountService";

const REQUEST_ID = "64f100000000000000000001";
const REQUESTER_ID = "64f100000000000000000002";
const PROVIDER_ID = "64f100000000000000000003";
const TIMELINE_EVENT_ID = "64f100000000000000000004";
const OUTCOME_ID = "64f100000000000000000005";
const CONVERSATION_ID = "64f100000000000000000006";
const DELIVERY_ID = "550e8400-e29b-41d4-a716-446655440000";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    recipientUserId: PROVIDER_ID,
    requestId: REQUEST_ID,
    requestRevision: 2,
    timelineEventId: TIMELINE_EVENT_ID,
    eventType: "create",
    occurredAt: "2026-09-12T12:00:00.000Z",
    presentation: "system_message",
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: DELIVERY_ID,
    payload: payload(overrides),
  } as ClaimedNotificationOutbox;
}

function context(): NotificationOutboxDeliveryContext {
  return {
    signal: new AbortController().signal,
    renewLease: vi.fn(),
  };
}

function message(): IMessage {
  return {
    _id: "64f100000000000000000099",
    title: "New alumni help request",
    content: "A community member sent you an alumni help request.",
    type: "update",
    priority: "medium",
    hideCreator: true,
    createdAt: new Date("2026-09-12T12:00:00.000Z"),
    metadata: {
      workflowDeliveryId: DELIVERY_ID,
      kind: "alumni_help_workflow",
      requestId: REQUEST_ID,
    },
  } as unknown as IMessage;
}

function setup(options: {
  mode?: "off" | "read_only" | "on";
  recipientActive?: boolean;
  recipientVerified?: boolean;
  recipientId?: string;
  recipientRole?: string;
} = {}) {
  const ensureMessage = vi.fn().mockResolvedValue(message());
  const socket = {
    emitSystemMessageUpdate: vi.fn(),
    emitUnreadCountUpdate: vi.fn(),
    emitAlumniHelpUpdate: vi.fn(),
  };
  const loadRequest = vi.fn().mockResolvedValue({
    id: REQUEST_ID,
    requesterId: REQUESTER_ID,
    providerId: PROVIDER_ID,
    conversationId: CONVERSATION_ID,
    revision: 4,
  });
  const loadRecipient = vi.fn().mockResolvedValue({
    id: options.recipientId ?? PROVIDER_ID,
    role: options.recipientRole ?? "Participant",
    isActive: options.recipientActive ?? true,
    isVerified: options.recipientVerified ?? true,
  });
  const handler = new AlumniHelpWorkflowDeliveryHandler({
    releaseAvailable: () => true,
    runtimeReader: {
      getOperationalRuntimeConfig: vi
        .fn()
        .mockResolvedValue(createRuntimeConfigDTO(options.mode ?? "on", 1)),
    },
    loadRequest,
    loadRecipient,
    ensureMessage,
    notificationCounts: {
      countsForUser: vi.fn().mockResolvedValue({
        helpActionRequiredCount: 3,
        helpNotificationCount: 5,
      }),
    },
    unreadCounts: {
      getUnreadCountsForUser: vi.fn().mockResolvedValue({
        bellNotifications: 7,
        systemMessages: 6,
        total: 7,
      }),
    },
    socket,
  });
  return { handler, ensureMessage, loadRequest, loadRecipient, socket };
}

describe("AlumniHelpWorkflowDeliveryHandler", () => {
  it("registers the explicit versioned topic", () => {
    expect(setup().handler.topic).toBe(ALUMNI_HELP_WORKFLOW_TOPIC);
    expect(setup().handler.payloadVersion).toBe(
      ALUMNI_HELP_WORKFLOW_PAYLOAD_VERSION,
    );
  });

  it.each(["on", "read_only"] as const)(
    "claims already-committed workflow delivery while runtime is %s",
    async (mode) => {
      await expect(
        setup({ mode }).handler.canClaim(context().signal),
      ).resolves.toBe(true);
    },
  );

  it("defers delivery while the network is not readable", async () => {
    const { handler, loadRequest } = setup({ mode: "off" });
    await expect(handler.canClaim(context().signal)).resolves.toBe(false);
    await expect(handler.assertCanDeliver(event(), context())).rejects.toBeInstanceOf(
      DeferredNotificationOutboxDeliveryError,
    );
    expect(loadRequest).not.toHaveBeenCalled();
  });

  it("persists one targeted message and emits recipient-scoped current counts", async () => {
    const { handler, ensureMessage, socket } = setup();

    await handler.assertCanDeliver(event(), context());
    await handler.deliver(event(), context());

    expect(ensureMessage).toHaveBeenCalledWith(
      DELIVERY_ID,
      expect.objectContaining({
        recipientUserId: PROVIDER_ID,
        requestId: REQUEST_ID,
        presentation: "system_message",
      }),
    );
    expect(socket.emitSystemMessageUpdate).toHaveBeenCalledWith(
      PROVIDER_ID,
      "message_created",
      {
        message: expect.objectContaining({
          metadata: {
            kind: "alumni_help_workflow",
            requestId: REQUEST_ID,
          },
        }),
      },
    );
    expect(
      JSON.stringify(socket.emitSystemMessageUpdate.mock.calls),
    ).not.toContain("workflowDeliveryId");
    expect(socket.emitUnreadCountUpdate).toHaveBeenCalledWith(PROVIDER_ID, {
      bellNotifications: 7,
      systemMessages: 6,
      total: 7,
    });
    expect(socket.emitAlumniHelpUpdate).toHaveBeenCalledWith(PROVIDER_ID, {
      requestId: REQUEST_ID,
      requestRevision: 4,
      helpActionRequiredCount: 3,
      helpNotificationCount: 5,
    });
  });

  it("uses counter-only delivery without creating a System Message", async () => {
    const { handler, ensureMessage, socket } = setup();
    await handler.deliver(
      event({ presentation: "counter_only" }),
      context(),
    );
    expect(ensureMessage).not.toHaveBeenCalled();
    expect(socket.emitSystemMessageUpdate).not.toHaveBeenCalled();
    expect(socket.emitUnreadCountUpdate).toHaveBeenCalledOnce();
    expect(socket.emitAlumniHelpUpdate).toHaveBeenCalledOnce();
  });

  it.each(["accept", "confirm_alternative"] as const)(
    "emits the newly created room only for %s",
    async (eventType) => {
      const { handler, socket } = setup();
      await handler.deliver(event({ eventType }), context());

      expect(socket.emitAlumniHelpUpdate).toHaveBeenCalledWith(PROVIDER_ID, {
        requestId: REQUEST_ID,
        requestRevision: 4,
        helpActionRequiredCount: 3,
        helpNotificationCount: 5,
        roomCreated: { conversationId: CONVERSATION_ID },
      });
    },
  );

  it("does not attach a room to later workflow updates", async () => {
    const { handler, socket } = setup();
    await handler.deliver(event({ eventType: "start" }), context());

    expect(socket.emitAlumniHelpUpdate).toHaveBeenCalledWith(PROVIDER_ID, {
      requestId: REQUEST_ID,
      requestRevision: 4,
      helpActionRequiredCount: 3,
      helpNotificationCount: 5,
    });
  });

  it.each([
    { openingNote: "must never enter an outbox payload" },
    { eventType: "outcome_submit" },
    {
      eventType: "create",
      outcomeSubmissionId: OUTCOME_ID,
      outcomeRevision: 1,
    },
    { occurredAt: "2026-09-12" },
  ])("permanently rejects payload drift %#", (drift) => {
    expect(() => parseAlumniHelpWorkflowPayload(payload(drift))).toThrow(
      PermanentNotificationOutboxDeliveryError,
    );
  });

  it("rejects a non-participant or unavailable recipient", async () => {
    const unavailable = setup({ recipientActive: false });
    await expect(
      unavailable.handler.assertCanDeliver(event(), context()),
    ).rejects.toMatchObject({ code: "ALUMNI_HELP_RECIPIENT_UNAVAILABLE" });

    const outsider = setup({
      recipientId: "64f100000000000000000099",
    });
    await expect(
      outsider.handler.assertCanDeliver(event(), context()),
    ).rejects.toMatchObject({ code: "ALUMNI_HELP_RECIPIENT_UNAVAILABLE" });

    const missingAuthorizationContext = setup({ recipientRole: "" });
    await expect(
      missingAuthorizationContext.handler.assertCanDeliver(event(), context()),
    ).rejects.toMatchObject({ code: "ALUMNI_HELP_RECIPIENT_UNAVAILABLE" });
  });
});

describe("enqueueAlumniHelpWorkflowNotifications", () => {
  it("enqueues one strict delivery per participant with actor counter-only", async () => {
    const enqueueInTransaction = vi
      .fn()
      .mockImplementation(async (input) => ({
        eventId: DELIVERY_ID,
      } as NotificationOutboxRecord));

    await enqueueAlumniHelpWorkflowNotifications(
      {
        requestId: REQUEST_ID,
        requestRevision: 2,
        timelineEventId: TIMELINE_EVENT_ID,
        eventType: "create",
        actorUserId: REQUESTER_ID,
        requesterId: REQUESTER_ID,
        providerId: PROVIDER_ID,
        occurredAt: new Date("2026-09-12T12:00:00.000Z"),
        session: {} as ClientSession,
      },
      { enqueueInTransaction },
    );

    expect(enqueueInTransaction).toHaveBeenCalledTimes(3);
    expect(enqueueInTransaction.mock.calls[0][0]).toMatchObject({
      topic: "alumni.help.workflow",
      dedupeKey: `alumni-help:${TIMELINE_EVENT_ID}:${REQUESTER_ID}`,
      payload: {
        recipientUserId: REQUESTER_ID,
        presentation: "counter_only",
      },
    });
    expect(enqueueInTransaction.mock.calls[1][0]).toMatchObject({
      dedupeKey: `alumni-help:${TIMELINE_EVENT_ID}:${PROVIDER_ID}`,
      payload: {
        recipientUserId: PROVIDER_ID,
        presentation: "system_message",
      },
    });
    expect(enqueueInTransaction.mock.calls[2][0]).toMatchObject({
      topic: "alumni.help.external_notification",
      dedupeKey: `alumni-help-external:${TIMELINE_EVENT_ID}:${PROVIDER_ID}`,
      payload: {
        workflowEventId: DELIVERY_ID,
        recipientUserId: PROVIDER_ID,
        requestId: REQUEST_ID,
      },
    });
  });

  it("routes automatic confirmation to requester and requires outcome identity", async () => {
    const enqueueInTransaction = vi
      .fn()
      .mockResolvedValue({ eventId: DELIVERY_ID } as NotificationOutboxRecord);
    await enqueueAlumniHelpWorkflowNotifications(
      {
        requestId: REQUEST_ID,
        requestRevision: 9,
        timelineEventId: TIMELINE_EVENT_ID,
        eventType: "outcome_auto_confirm",
        actorUserId: null,
        requesterId: REQUESTER_ID,
        providerId: PROVIDER_ID,
        outcomeSubmissionId: OUTCOME_ID,
        outcomeRevision: 1,
        occurredAt: new Date("2026-10-02T12:00:00.000Z"),
        session: {} as ClientSession,
      },
      { enqueueInTransaction },
    );
    expect(enqueueInTransaction.mock.calls[0][0].payload).toMatchObject({
      recipientUserId: REQUESTER_ID,
      presentation: "system_message",
      outcomeSubmissionId: OUTCOME_ID,
      outcomeRevision: 1,
    });
    expect(enqueueInTransaction.mock.calls[2][0]).toMatchObject({
      topic: "alumni.help.external_notification",
      payload: {
        workflowEventId: DELIVERY_ID,
        recipientUserId: REQUESTER_ID,
      },
    });
    expect(enqueueInTransaction.mock.calls[1][0].payload).toMatchObject({
      recipientUserId: PROVIDER_ID,
      presentation: "counter_only",
    });
  });
});

describe("Alumni Help action count", () => {
  it("uses the five approved predicates and excludes logically expired requests", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const filter = buildAlumniHelpActionRequiredFilter(PROVIDER_ID, now) as {
      $and: [
        { $or: Array<Record<string, unknown>> },
        { $or: Array<Record<string, unknown>> },
      ];
    };
    const actionPredicates = filter.$and[0].$or;
    expect(actionPredicates).toHaveLength(5);
    expect(actionPredicates.map((clause) => clause.status).filter(Boolean)).toEqual([
      "requested",
      "needs_information",
      "alternative_proposed",
    ]);
    expect(
      actionPredicates
        .map((clause) => clause.latestOutcomeStatus)
        .filter(Boolean),
    ).toEqual(["pending", "denied"]);
    expect(filter.$and[1].$or).toEqual([
      { purgeAt: { $exists: false } },
      { purgeAt: null },
      { purgeAt: { $gt: now } },
    ]);
  });

  it("applies logical retention before a delayed workflow delivery", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    expect(buildRetainedWorkflowRequestFilter(REQUEST_ID, now)).toEqual({
      _id: REQUEST_ID,
      $or: [
        { purgeAt: { $exists: false } },
        { purgeAt: null },
        { purgeAt: { $gt: now } },
      ],
    });
  });

  it("declares a unique partial workflow delivery index", () => {
    expect(Message.schema.indexes()).toContainEqual([
      { "metadata.workflowDeliveryId": 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: {
          "metadata.workflowDeliveryId": { $type: "string" },
        },
      }),
    ]);
  });
});
