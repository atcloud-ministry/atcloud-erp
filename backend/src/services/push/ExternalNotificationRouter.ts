import {
  notificationBadgeCountService,
  type NotificationBadgeCountService,
} from "../notifications/NotificationBadgeCountService";
import {
  externalNotificationEmailService,
  type ExternalNotificationEmailService,
} from "./ExternalNotificationEmailService";
import {
  webPushDeliveryService,
  type PushRecipientDeliveryResult,
  type WebPushDeliveryService,
  type WebPushNotificationPayload,
} from "./WebPushDeliveryService";

export type ExternalNotificationRoute =
  | "push"
  | "email"
  | "skipped"
  | "retry";

export interface ExternalNotificationRouteResult {
  readonly route: ExternalNotificationRoute;
  readonly push: PushRecipientDeliveryResult;
}

interface ExternalNotificationRouterDependencies {
  readonly push?: Pick<
    WebPushDeliveryService,
    "deliverChatMessage" | "deliverHelpNotification"
  >;
  readonly email?: Pick<
    ExternalNotificationEmailService,
    "sendChatFallback" | "sendHelpFallback"
  >;
  readonly badges?: Pick<NotificationBadgeCountService, "totalForUser">;
}

function result(
  route: ExternalNotificationRoute,
  push: PushRecipientDeliveryResult,
): ExternalNotificationRouteResult {
  return Object.freeze({ route, push });
}

function payload(
  title: string,
  body: string,
  tag: string,
  deepLink: string,
  badgeCount: number,
): WebPushNotificationPayload {
  return Object.freeze({ title, body, tag, deepLink, badgeCount });
}

/** Implements the single Push -> Email fallback matrix for external notices. */
export class ExternalNotificationRouter {
  private readonly push: Pick<
    WebPushDeliveryService,
    "deliverChatMessage" | "deliverHelpNotification"
  >;
  private readonly email: Pick<
    ExternalNotificationEmailService,
    "sendChatFallback" | "sendHelpFallback"
  >;
  private readonly badges: Pick<NotificationBadgeCountService, "totalForUser">;

  constructor(dependencies: ExternalNotificationRouterDependencies = {}) {
    this.push = dependencies.push ?? webPushDeliveryService;
    this.email = dependencies.email ?? externalNotificationEmailService;
    this.badges = dependencies.badges ?? notificationBadgeCountService;
  }

  async deliverChat(input: {
    readonly eventId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly recipientUserId: string;
    readonly sequence: number;
    readonly signal?: AbortSignal;
  }): Promise<ExternalNotificationRouteResult> {
    const badgeCount = await this.badges.totalForUser(input.recipientUserId);
    input.signal?.throwIfAborted();
    if (badgeCount === null) {
      return result("skipped", noSubscription());
    }
    const push = await this.push.deliverChatMessage({
      ...input,
      payload: payload(
        "@Cloud Chat Rooms",
        "You have a new chat message.",
        `chat-${input.conversationId}`,
        `/#/dashboard/chat-rooms/${input.conversationId}`,
        badgeCount,
      ),
    });
    return this.finishChatFallback(input, push);
  }

  async deliverHelp(input: {
    readonly eventId: string;
    readonly requestId: string;
    readonly requestRevision: number;
    readonly recipientUserId: string;
    readonly signal?: AbortSignal;
  }): Promise<ExternalNotificationRouteResult> {
    const badgeCount = await this.badges.totalForUser(input.recipientUserId);
    input.signal?.throwIfAborted();
    if (badgeCount === null) {
      return result("skipped", noSubscription());
    }
    const push = await this.push.deliverHelpNotification({
      eventId: input.eventId,
      requestId: input.requestId,
      minimumRevision: input.requestRevision,
      recipientUserId: input.recipientUserId,
      payload: payload(
        "@Cloud Alumni Help",
        "There is an update to your Alumni Help request.",
        `help-${input.requestId}`,
        `/#/dashboard/community/help-requests/${input.requestId}`,
        badgeCount,
      ),
      signal: input.signal,
    });
    if (push.route === "transient_failure") return result("retry", push);
    if (push.route === "delivered") return result("push", push);
    const email = await this.email.sendHelpFallback({
      requestId: input.requestId,
      recipientUserId: input.recipientUserId,
      minimumRevision: input.requestRevision,
      signal: input.signal,
    });
    return result(email === "sent" ? "email" : "skipped", push);
  }

  private async finishChatFallback(
    input: {
      readonly conversationId: string;
      readonly messageId: string;
      readonly recipientUserId: string;
      readonly sequence: number;
      readonly signal?: AbortSignal;
    },
    push: PushRecipientDeliveryResult,
  ): Promise<ExternalNotificationRouteResult> {
    if (push.route === "transient_failure") return result("retry", push);
    if (push.route === "delivered") return result("push", push);
    if (push.route === "muted") return result("skipped", push);
    const email = await this.email.sendChatFallback({
      conversationId: input.conversationId,
      messageId: input.messageId,
      recipientUserId: input.recipientUserId,
      sequence: input.sequence,
      signal: input.signal,
    });
    return result(email === "sent" ? "email" : "skipped", push);
  }
}

function noSubscription(): PushRecipientDeliveryResult {
  return Object.freeze({
    route: "no_subscription" as const,
    attempted: 0,
    succeeded: 0,
    permanentFailures: 0,
    transientFailures: 0,
  });
}

export const externalNotificationRouter = new ExternalNotificationRouter();
