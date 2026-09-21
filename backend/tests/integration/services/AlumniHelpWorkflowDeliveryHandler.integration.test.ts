import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import Message from "../../../src/models/Message";
import {
  ALUMNI_HELP_WORKFLOW_EVENT_TYPES,
  AlumniHelpWorkflowDeliveryHandler,
} from "../../../src/services/alumni/AlumniHelpWorkflowDeliveryHandler";
import type { ClaimedNotificationOutbox } from "../../../src/services/reliability/NotificationOutboxService";
import { ensureIntegrationDB } from "../setup/connect";

const REQUEST_ID = "64f100000000000000000001";
const REQUESTER_ID = "64f100000000000000000002";
const PROVIDER_ID = "64f100000000000000000003";
const CONVERSATION_ID = "64f100000000000000000006";
const OCCURRED_AT = "2026-09-12T12:00:00.000Z";

describe("Alumni Help workflow Mongo delivery", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
    await Message.init();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
  });

  it.each(ALUMNI_HELP_WORKFLOW_EVENT_TYPES)(
    "persists and emits %s using the real Message model, including idempotent replay",
    async (eventType) => {
      const socket = {
        emitSystemMessageUpdate: vi.fn(),
        emitUnreadCountUpdate: vi.fn(),
        emitAlumniHelpUpdate: vi.fn(),
      };
      const handler = new AlumniHelpWorkflowDeliveryHandler({
        releaseAvailable: () => true,
        runtimeReader: {
          getOperationalRuntimeConfig: async () =>
            createRuntimeConfigDTO("on", 1),
        },
        loadRequest: async () => ({
          id: REQUEST_ID,
          requesterId: REQUESTER_ID,
          providerId: PROVIDER_ID,
          conversationId: CONVERSATION_ID,
          revision: 4,
        }),
        loadRecipient: async () => ({
          id: PROVIDER_ID,
          role: "Participant",
          isActive: true,
          isVerified: true,
        }),
        notificationCounts: {
          countsForUser: async () => ({
            helpActionRequiredCount: 3,
            helpNotificationCount: 5,
          }),
        },
        socket,
      });
      const eventId = randomUUID();
      const event = {
        eventId,
        payload: {
          recipientUserId: PROVIDER_ID,
          requestId: REQUEST_ID,
          requestRevision: 2,
          timelineEventId: "64f100000000000000000004",
          eventType,
          occurredAt: OCCURRED_AT,
          presentation: "system_message",
          ...(eventType.startsWith("outcome_")
            ? {
                outcomeSubmissionId: "64f100000000000000000005",
                outcomeRevision: 1,
              }
            : {}),
        },
      } as ClaimedNotificationOutbox;
      const context = {
        signal: new AbortController().signal,
        renewLease: vi.fn(),
      };

      await handler.assertCanDeliver(event, context);
      await handler.deliver(event, context);
      await handler.deliver(event, context);

      const messages = await Message.find({
        "metadata.workflowDeliveryId": eventId,
      }).lean();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        targetUserId: PROVIDER_ID,
        createdAt: new Date(OCCURRED_AT),
        updatedAt: new Date(OCCURRED_AT),
      });
      expect(socket.emitSystemMessageUpdate).toHaveBeenCalledTimes(2);
      expect(socket.emitUnreadCountUpdate).toHaveBeenLastCalledWith(
        PROVIDER_ID,
        { bellNotifications: 1, systemMessages: 1, total: 1 },
      );
      expect(socket.emitAlumniHelpUpdate).toHaveBeenLastCalledWith(
        PROVIDER_ID,
        expect.objectContaining({
          requestId: REQUEST_ID,
          requestRevision: 4,
          helpActionRequiredCount: 3,
          helpNotificationCount: 5,
        }),
      );
      expect(
        await Message.getUnreadCountsForUser(REQUESTER_ID, "Participant"),
      ).toEqual({ bellNotifications: 0, systemMessages: 0, total: 0 });
    },
  );
});
