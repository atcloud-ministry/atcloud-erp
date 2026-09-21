import AlumniInvitation from "../../models/AlumniInvitation";
import type { RuntimeConfigSuccessDTO } from "../../contracts/runtimeConfig";
import { readAlumniNetworkReleaseAvailable } from "../../config/alumniNetworkFeature";
import { EmailHelpers, EmailTransporter, type EmailOptions } from "../email";
import { featureControlService } from "../runtime/FeatureControlService";
import type {
  NotificationOutboxDeliveryContext,
  NotificationOutboxDeliveryHandler,
} from "../reliability/NotificationOutboxDeliveryRegistry";
import type { ClaimedNotificationOutbox } from "../reliability/NotificationOutboxService";
import {
  DeferredNotificationOutboxDeliveryError,
  PermanentNotificationOutboxDeliveryError,
  RetryableNotificationOutboxDeliveryError,
} from "../reliability/NotificationOutboxWorker";
import {
  alumniInvitationTokenHashMatches,
  deriveAlumniInvitationToken,
  normalizeAlumniContactEmail,
  type AlumniInvitationTokenMaterial,
} from "./AlumniInvitationSecurity";

export const ALUMNI_INVITATION_EMAIL_TOPIC =
  "alumni.invitation.email" as const;
export const ALUMNI_INVITATION_EMAIL_PAYLOAD_VERSION = 1 as const;

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export interface AlumniInvitationEmailPayloadV1 {
  readonly invitationId: string;
  readonly issueCount: number;
}

export interface AlumniInvitationEmailState {
  readonly invitationId: string;
  readonly status: string;
  readonly issueCount: number;
  readonly issuedAt: Date;
  readonly tokenExpiresAt: Date;
  readonly tokenVersion: number;
  readonly tokenHash?: string;
  readonly contactEmail?: string;
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly contactPurgedAt?: Date | null;
}

export interface AlumniInvitationEmailSender {
  send(options: EmailOptions): Promise<void>;
}

export interface AlumniInvitationRuntimeReader {
  getOperationalRuntimeConfig(options?: {
    readonly signal?: AbortSignal;
  }): Promise<RuntimeConfigSuccessDTO>;
}

export interface AlumniInvitationEmailDeliveryDependencies {
  readonly loadInvitation?: (
    invitationId: string,
    signal: AbortSignal,
  ) => Promise<AlumniInvitationEmailState | null>;
  readonly sender?: AlumniInvitationEmailSender;
  readonly runtimeReader?: AlumniInvitationRuntimeReader;
  readonly releaseAvailable?: () => boolean;
  readonly now?: () => Date;
  readonly deriveToken?: (input: AlumniInvitationTokenMaterial) => string;
  readonly tokenHashMatches?: (token: string, expectedHash: string) => boolean;
  readonly buildClaimUrl?: (invitationId: string, token: string) => string;
}

interface DeliverableInvitation {
  readonly state: AlumniInvitationEmailState;
  readonly token: string;
  readonly email: string;
}

function permanent(code: string): never {
  throw new PermanentNotificationOutboxDeliveryError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsePayload(value: unknown): AlumniInvitationEmailPayloadV1 {
  if (!isPlainObject(value)) permanent("ALUMNI_INVITATION_EVENT_INVALID");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "invitationId" ||
    keys[1] !== "issueCount" ||
    typeof value.invitationId !== "string" ||
    !OBJECT_ID_PATTERN.test(value.invitationId) ||
    !Number.isSafeInteger(value.issueCount) ||
    Number(value.issueCount) < 1 ||
    Number(value.issueCount) >= Number.MAX_SAFE_INTEGER
  ) {
    permanent("ALUMNI_INVITATION_EVENT_INVALID");
  }
  return Object.freeze({
    invitationId: value.invitationId.toLowerCase(),
    issueCount: Number(value.issueCount),
  });
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

async function loadInvitationFromMongo(
  invitationId: string,
  signal: AbortSignal,
): Promise<AlumniInvitationEmailState | null> {
  const document = await AlumniInvitation.findById(invitationId)
    .select("+contactEmail +contactFirstName +contactLastName +tokenHash")
    .setOptions({ signal })
    .lean()
    .exec();
  if (!document) return null;
  return {
    invitationId: String(document._id),
    status: document.status,
    issueCount: document.issueCount,
    issuedAt: document.issuedAt,
    tokenExpiresAt: document.tokenExpiresAt,
    tokenVersion: document.tokenVersion,
    tokenHash: document.tokenHash,
    contactEmail: document.contactEmail,
    contactFirstName: document.contactFirstName,
    contactLastName: document.contactLastName,
    contactPurgedAt: document.contactPurgedAt,
  };
}

function hasProductionSmtpConfiguration(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASS;
  return Boolean(
    process.env.SMTP_HOST &&
      user &&
      password &&
      !user.includes("your-email") &&
      !password.includes("your-app-password"),
  );
}

const DEFAULT_SENDER: AlumniInvitationEmailSender = Object.freeze({
  async send(options: EmailOptions): Promise<void> {
    if (!hasProductionSmtpConfiguration()) {
      throw new Error("Alumni invitation email transport is unavailable.");
    }
    await EmailTransporter.send(options);
  },
});

function buildDefaultClaimUrl(invitationId: string, token: string): string {
  const baseUrl = EmailHelpers.getFrontendBaseUrl();
  const parsed = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")
  ) {
    throw new Error("Alumni invitation frontend URL is invalid.");
  }
  return `${baseUrl}/#/dashboard/community/alumni/me?invitation=${encodeURIComponent(
    invitationId,
  )}&claim=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function buildEmail(
  invitation: DeliverableInvitation,
  claimUrl: string,
): EmailOptions {
  const displayName = [
    invitation.state.contactFirstName,
    invitation.state.contactLastName,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const greetingText = displayName ? `Hello ${displayName},` : "Hello,";
  const greetingHtml = escapeHtml(greetingText);
  const safeUrl = escapeHtml(claimUrl);
  return {
    to: invitation.email,
    subject: "Your @Cloud alumni network invitation",
    text: `${greetingText}\n\nYou have been invited to claim your @Cloud alumni profile. This one-time link expires in 14 days:\n${claimUrl}\n\nIf you did not expect this invitation, you can ignore this email.`,
    html: `<p>${greetingHtml}</p><p>You have been invited to claim your @Cloud alumni profile.</p><p><a href="${safeUrl}">Claim your alumni profile</a></p><p>This one-time link expires in 14 days. If you did not expect this invitation, you can ignore this email.</p>`,
  };
}

/** Delivery reloads current state, so a reissue immediately fences older events. */
export class AlumniInvitationEmailDeliveryHandler
  implements NotificationOutboxDeliveryHandler
{
  readonly topic = ALUMNI_INVITATION_EMAIL_TOPIC;
  readonly payloadVersion = ALUMNI_INVITATION_EMAIL_PAYLOAD_VERSION;

  private readonly loadInvitation: NonNullable<
    AlumniInvitationEmailDeliveryDependencies["loadInvitation"]
  >;
  private readonly sender: AlumniInvitationEmailSender;
  private readonly runtimeReader: AlumniInvitationRuntimeReader;
  private readonly releaseAvailable: () => boolean;
  private readonly now: () => Date;
  private readonly deriveToken: NonNullable<
    AlumniInvitationEmailDeliveryDependencies["deriveToken"]
  >;
  private readonly tokenHashMatches: NonNullable<
    AlumniInvitationEmailDeliveryDependencies["tokenHashMatches"]
  >;
  private readonly buildClaimUrl: NonNullable<
    AlumniInvitationEmailDeliveryDependencies["buildClaimUrl"]
  >;

  constructor(dependencies: AlumniInvitationEmailDeliveryDependencies = {}) {
    this.loadInvitation =
      dependencies.loadInvitation ?? loadInvitationFromMongo;
    this.sender = dependencies.sender ?? DEFAULT_SENDER;
    this.runtimeReader = dependencies.runtimeReader ?? featureControlService;
    this.releaseAvailable =
      dependencies.releaseAvailable ?? readAlumniNetworkReleaseAvailable;
    this.now = dependencies.now ?? (() => new Date());
    this.deriveToken =
      dependencies.deriveToken ?? deriveAlumniInvitationToken;
    this.tokenHashMatches =
      dependencies.tokenHashMatches ?? alumniInvitationTokenHashMatches;
    this.buildClaimUrl = dependencies.buildClaimUrl ?? buildDefaultClaimUrl;
  }

  async canClaim(signal: AbortSignal): Promise<boolean> {
    return this.isRuntimeWritable(signal);
  }

  async assertCanDeliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    await this.assertRuntimeWritable(context.signal);
    await this.getDeliverable(event, context.signal);
  }

  async deliver(
    event: ClaimedNotificationOutbox,
    context: NotificationOutboxDeliveryContext,
  ): Promise<void> {
    const invitation = await this.getDeliverable(event, context.signal);
    context.signal.throwIfAborted();

    let claimUrl: string;
    try {
      claimUrl = this.buildClaimUrl(
        invitation.state.invitationId,
        invitation.token,
      );
    } catch {
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_INVITATION_EMAIL_CONFIGURATION_UNAVAILABLE",
      );
    }

    // This is intentionally the final awaited guard before outbound SMTP I/O.
    await this.assertRuntimeWritable(context.signal);
    context.signal.throwIfAborted();
    try {
      await this.sender.send(buildEmail(invitation, claimUrl));
    } catch {
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_INVITATION_EMAIL_SEND_FAILED",
      );
    }
  }

  private async isRuntimeWritable(signal: AbortSignal): Promise<boolean> {
    try {
      signal.throwIfAborted();
      if (!this.releaseAvailable()) return false;
      const config = await this.runtimeReader.getOperationalRuntimeConfig({
        signal,
      });
      signal.throwIfAborted();
      const feature = config.data.alumniNetwork;
      return feature.mode === "on" && feature.writable === true;
    } catch {
      return false;
    }
  }

  private async assertRuntimeWritable(signal: AbortSignal): Promise<void> {
    if (!(await this.isRuntimeWritable(signal))) {
      throw new DeferredNotificationOutboxDeliveryError(
        "ALUMNI_NETWORK_NOT_WRITABLE",
      );
    }
  }

  private async getDeliverable(
    event: ClaimedNotificationOutbox,
    signal: AbortSignal,
  ): Promise<DeliverableInvitation> {
    signal.throwIfAborted();
    const payload = parsePayload(event.payload);
    const state = await this.loadInvitation(payload.invitationId, signal);
    signal.throwIfAborted();
    const now = this.now();
    if (
      !state ||
      typeof state.invitationId !== "string" ||
      state.invitationId.toLowerCase() !== payload.invitationId ||
      state.status !== "active" ||
      state.issueCount !== payload.issueCount ||
      state.contactPurgedAt ||
      !validDate(state.issuedAt) ||
      !validDate(state.tokenExpiresAt) ||
      !validDate(now) ||
      state.tokenExpiresAt.getTime() <= now.getTime() ||
      typeof state.tokenHash !== "string" ||
      typeof state.contactEmail !== "string"
    ) {
      permanent("ALUMNI_INVITATION_EVENT_STALE");
    }

    let email: string;
    try {
      email = normalizeAlumniContactEmail(state.contactEmail);
    } catch {
      permanent("ALUMNI_INVITATION_EVENT_STALE");
    }

    let token: string;
    try {
      token = this.deriveToken({
        invitationId: state.invitationId,
        issueCount: state.issueCount,
        issuedAt: state.issuedAt,
        tokenVersion: state.tokenVersion,
      });
    } catch {
      throw new RetryableNotificationOutboxDeliveryError(
        "ALUMNI_INVITATION_SECURITY_UNAVAILABLE",
      );
    }
    if (!this.tokenHashMatches(token, state.tokenHash)) {
      permanent("ALUMNI_INVITATION_EVENT_STALE");
    }
    return Object.freeze({ state, token, email });
  }
}

export const alumniInvitationEmailDeliveryHandler =
  new AlumniInvitationEmailDeliveryHandler();
