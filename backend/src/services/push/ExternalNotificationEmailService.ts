import mongoose from "mongoose";
import AlumniHelpRequest from "../../models/AlumniHelpRequest";
import ChatMessage from "../../models/ChatMessage";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";
import NotificationPreference from "../../models/NotificationPreference";
import User from "../../models/User";
import { EmailHelpers, EmailTransporter, type EmailOptions } from "../email";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export interface ExternalNotificationEmailSender {
  send(options: EmailOptions): Promise<unknown>;
}

export type ExternalEmailDeliveryResult = "sent" | "skipped";

interface ExternalNotificationEmailDependencies {
  readonly now?: () => Date;
  readonly sender?: ExternalNotificationEmailSender;
  readonly frontendBaseUrl?: () => string;
}

interface EligibleRecipientRow {
  readonly email: string;
}

function objectId(value: string): mongoose.Types.ObjectId | null {
  return OBJECT_ID_PATTERN.test(value) ? new mongoose.Types.ObjectId(value) : null;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("External notification email clock is invalid.");
  }
  return new Date(value);
}

function validEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 254 &&
    !/[\r\n]/u.test(value) &&
    /^[^\s@]+@[^\s@]+$/u.test(value)
  );
}

function frontendUrl(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")
  ) {
    throw new Error("External notification frontend URL is invalid.");
  }
  // External notification links never inherit an operator-supplied path. This
  // keeps both the HTML attribute and the client route entirely server-owned.
  return `${parsed.origin}/#${path}`;
}

function emailOptions(
  email: string,
  subject: string,
  content: string,
  url: string,
  linkLabel: string,
): EmailOptions {
  // subject/content/linkLabel are fixed constants and url is constructed from
  // a validated deployment origin plus an ObjectId-only route.
  return Object.freeze({
    to: email,
    subject,
    text: `${content}\n\n${linkLabel}: ${url}`,
    html: `<p>${content}</p><p><a href="${url}">${linkLabel}</a></p>`,
  });
}

/**
 * Executes a final recipient/resource authorization aggregate immediately
 * before invoking SMTP. Neither method accepts arbitrary links or copy.
 */
export class ExternalNotificationEmailService {
  private readonly now: () => Date;
  private readonly sender: ExternalNotificationEmailSender;
  private readonly frontendBaseUrl: () => string;

  constructor(dependencies: ExternalNotificationEmailDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.sender = dependencies.sender ?? EmailTransporter;
    this.frontendBaseUrl =
      dependencies.frontendBaseUrl ?? (() => EmailHelpers.getFrontendBaseUrl());
  }

  async sendChatFallback(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly recipientUserId: string;
    readonly sequence: number;
    readonly kind?: "text" | "announcement";
    readonly authorizeRecipient: () => Promise<boolean>;
    readonly signal?: AbortSignal;
  }): Promise<ExternalEmailDeliveryResult> {
    input.signal?.throwIfAborted();
    const conversationId = objectId(input.conversationId);
    const messageId = objectId(input.messageId);
    const recipientUserId = objectId(input.recipientUserId);
    if (
      !conversationId ||
      !messageId ||
      !recipientUserId ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1
    ) {
      return "skipped";
    }
    const now = validNow(this.now());
    const rows = await User.aggregate<EligibleRecipientRow>([
      {
        $match: {
          _id: recipientUserId,
          isActive: true,
          isVerified: true,
          emailNotifications: true,
        },
      },
      {
        $lookup: {
          from: NotificationPreference.collection.name,
          let: { recipientId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$recipientId"] },
                emailEnabled: false,
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "disabledEmailPreference",
        },
      },
      { $match: { "disabledEmailPreference.0": { $exists: false } } },
      {
        $lookup: {
          from: ConversationMember.collection.name,
          let: { recipientId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$recipientId"] },
                conversationId,
                status: "active",
                muted: false,
                accessWindows: {
                  $elemMatch: {
                    visibleFromSequence: { $lte: input.sequence },
                    $or: [
                      { visibleThroughSequence: null },
                      { visibleThroughSequence: { $gte: input.sequence } },
                    ],
                  },
                },
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedMember",
        },
      },
      { $match: { "authorizedMember.0": { $exists: true } } },
      {
        $lookup: {
          from: Conversation.collection.name,
          pipeline: [
            {
              $match: {
                _id: conversationId,
                status: "current",
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedConversation",
        },
      },
      { $match: { "authorizedConversation.0": { $exists: true } } },
      {
        $lookup: {
          from: ChatMessage.collection.name,
          pipeline: [
            {
              $match: {
                _id: messageId,
                conversationId,
                sequence: input.sequence,
                purgeAt: { $gt: now },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "retainedMessage",
        },
      },
      { $match: { "retainedMessage.0": { $exists: true } } },
      { $project: { _id: 0, email: 1 } },
      { $limit: 1 },
    ])
      .option({ signal: input.signal })
      .exec();
    input.signal?.throwIfAborted();
    const email = rows[0]?.email;
    if (!validEmail(email)) return "skipped";
    const url = frontendUrl(
      this.frontendBaseUrl(),
      `/dashboard/chat-rooms/${conversationId.toString()}`,
    );
    const options = emailOptions(
      email,
      input.kind === "announcement"
        ? "New @Cloud Program announcement"
        : "New @Cloud Chat Rooms message",
      input.kind === "announcement"
        ? "A new Program announcement is available. Sign in to view it securely."
        : "You have a new chat message. Sign in to view it securely.",
      url,
      "Open Chat Rooms",
    );
    // Keep the canonical membership read adjacent to SMTP. In particular, a
    // stale materialized Program member cannot authorize a post-revocation
    // fallback email after the earlier Push attempt.
    if (!(await input.authorizeRecipient())) return "skipped";
    input.signal?.throwIfAborted();
    await this.sender.send(
      options,
    );
    return "sent";
  }

  async sendHelpFallback(input: {
    readonly requestId: string;
    readonly recipientUserId: string;
    readonly minimumRevision: number;
    readonly signal?: AbortSignal;
  }): Promise<ExternalEmailDeliveryResult> {
    input.signal?.throwIfAborted();
    const requestId = objectId(input.requestId);
    const recipientUserId = objectId(input.recipientUserId);
    if (
      !requestId ||
      !recipientUserId ||
      !Number.isSafeInteger(input.minimumRevision) ||
      input.minimumRevision < 0
    ) {
      return "skipped";
    }
    const now = validNow(this.now());
    const rows = await User.aggregate<EligibleRecipientRow>([
      {
        $match: {
          _id: recipientUserId,
          isActive: true,
          isVerified: true,
          emailNotifications: true,
        },
      },
      {
        $lookup: {
          from: NotificationPreference.collection.name,
          let: { recipientId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$recipientId"] },
                emailEnabled: false,
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "disabledEmailPreference",
        },
      },
      { $match: { "disabledEmailPreference.0": { $exists: false } } },
      {
        $lookup: {
          from: AlumniHelpRequest.collection.name,
          let: { recipientId: "$_id" },
          pipeline: [
            {
              $match: {
                _id: requestId,
                revision: { $gte: input.minimumRevision },
                $expr: {
                  $or: [
                    { $eq: ["$requesterId", "$$recipientId"] },
                    { $eq: ["$providerId", "$$recipientId"] },
                  ],
                },
                $or: [
                  { purgeAt: null },
                  { purgeAt: { $exists: false } },
                  { purgeAt: { $gt: now } },
                ],
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "authorizedHelpRequest",
        },
      },
      { $match: { "authorizedHelpRequest.0": { $exists: true } } },
      { $project: { _id: 0, email: 1 } },
      { $limit: 1 },
    ])
      .option({ signal: input.signal })
      .exec();
    input.signal?.throwIfAborted();
    const email = rows[0]?.email;
    if (!validEmail(email)) return "skipped";
    const url = frontendUrl(
      this.frontendBaseUrl(),
      `/dashboard/community/help-requests/${requestId.toString()}`,
    );
    await this.sender.send(
      emailOptions(
        email,
        "@Cloud Alumni Help update",
        "There is an update to your Alumni Help request. Sign in to review it securely.",
        url,
        "View Alumni Help request",
      ),
    );
    return "sent";
  }
}

export const externalNotificationEmailService =
  new ExternalNotificationEmailService();
