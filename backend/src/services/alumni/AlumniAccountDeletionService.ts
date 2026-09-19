import mongoose, { type ClientSession } from "mongoose";
import {
  ACCOUNT_DELETION_RETENTION_DAYS,
  CONSENT_RECORD_RETENTION_MONTHS,
  addFixedDays,
  addUtcCalendarMonths,
} from "../../contracts/alumniDirectoryData";
import {
  ALUMNI_HELP_ACTIVE_REQUEST_STATUSES,
  acceptedHelpRequestPurgeAt,
  neverAcceptedHelpRequestPurgeAt,
  type AlumniHelpLifecycleAction,
  type AlumniHelpParticipantRole,
  type AlumniHelpRequestStatus,
} from "../../contracts/alumniHelpFlow";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import AlumniHelpOutcomeSubmission from "../../models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest, {
  type AlumniHelpLifecycleEvent,
  type IAlumniHelpRequest,
} from "../../models/AlumniHelpRequest";
import AlumniProfile from "../../models/AlumniProfile";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";
import ConsentRecord from "../../models/ConsentRecord";
import NotificationPreference from "../../models/NotificationPreference";
import PushSubscription from "../../models/PushSubscription";
import RefreshSession from "../../models/RefreshSession";
import User from "../../models/User";
import { AuditLogService } from "../AuditLogService";
import { alumniHelpRoomProvisioner } from "./AlumniHelpRoomProvisioner";
import {
  MongoTransactionService,
  mongoTransactionService,
} from "../reliability/MongoTransactionService";

export const RESTORE_ACCOUNT_DELETION_ACTOR_KEY = "restore-recovery" as const;

/**
 * Ordinary account deletion is performed by an authenticated user.  The
 * isolated restore workflow may replay an authoritative deletion manifest as
 * a fixed system actor; it never accepts a caller-selected system identity.
 */
export type AlumniAccountDeletionActor =
  | {
      readonly type?: "user";
      readonly id: string;
      readonly role: string;
    }
  | {
      readonly type: "system";
      readonly key: string;
    };

export interface DeleteAlumniAccountInput {
  readonly targetUserId: string;
  readonly actor: AlumniAccountDeletionActor;
  readonly correlationId?: string;
  /**
   * Preserves the source deletion clock when replaying a deletion into an
   * isolated restore.  Normal HTTP deletion continues to use the service
   * clock.
   */
  readonly occurredAt?: Date;
}

export interface DeleteAlumniAccountResult {
  readonly profileScheduled: boolean;
  readonly affiliationsScheduled: number;
  readonly consentsTerminated: number;
  readonly helpRequestsTerminated: number;
  readonly helpRoomsArchived: number;
  readonly accessWindowsClosed: number;
}

export interface AlumniAccountDeletionTransactionContext {
  readonly targetUserId: mongoose.Types.ObjectId;
  readonly now: Date;
  readonly session: ClientSession;
}

export type AlumniAccountDeletionTransactionWork = (
  context: AlumniAccountDeletionTransactionContext,
) => Promise<void>;

interface AlumniAccountDeletionDependencies {
  readonly now?: () => Date;
  readonly transactions?: MongoTransactionService;
  readonly audit?: Pick<typeof AuditLogService, "recordRequiredInTransaction">;
}

function objectId(value: string, field: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new TypeError(`${field} must be a valid ObjectId.`);
  }
  return new mongoose.Types.ObjectId(value);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Account deletion requires a valid current time.");
  }
  return new Date(value);
}

function systemActorKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== RESTORE_ACCOUNT_DELETION_ACTOR_KEY
  ) {
    throw new TypeError("Account deletion system actor key is invalid.");
  }
  return value;
}

function auditActor(
  actor: AlumniAccountDeletionActor,
): { readonly type: "user"; readonly id: string; readonly role: string } | {
  readonly type: "system";
  readonly key: string;
} {
  if (actor.type === "system") {
    return Object.freeze({ type: "system" as const, key: systemActorKey(actor.key) });
  }
  if (actor.type !== undefined && actor.type !== "user") {
    throw new TypeError("Account deletion actor type is invalid.");
  }
  objectId(actor.id, "actor.id");
  if (
    typeof actor.role !== "string" ||
    actor.role.length < 1 ||
    actor.role.length > 80
  ) {
    throw new TypeError("Account deletion actor role is invalid.");
  }
  return Object.freeze({
    type: "user" as const,
    id: actor.id,
    role: actor.role,
  });
}

/**
 * Applies the approved account-deletion clocks and deletes the account's live
 * delivery/session records atomically with the User record. Retained Help and
 * Chat records keep their separately approved lifecycle clocks.
 */
export class AlumniAccountDeletionService {
  private readonly now: () => Date;
  private readonly transactions: MongoTransactionService;
  private readonly audit: Pick<
    typeof AuditLogService,
    "recordRequiredInTransaction"
  >;

  constructor(dependencies: AlumniAccountDeletionDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.transactions = dependencies.transactions ?? mongoTransactionService;
    this.audit = dependencies.audit ?? AuditLogService;
  }

  async deleteAccount(
    input: DeleteAlumniAccountInput,
    transactionWork?: AlumniAccountDeletionTransactionWork,
  ): Promise<DeleteAlumniAccountResult> {
    const targetUserId = objectId(input.targetUserId, "targetUserId");
    const actor = auditActor(input.actor);
    if (input.occurredAt !== undefined && actor.type !== "system") {
      throw new TypeError(
        "Only the isolated restore actor may supply an account deletion time.",
      );
    }
    const now = validNow(input.occurredAt ?? this.now());

    return this.transactions.run(async (session) => {
      if (transactionWork) {
        await transactionWork({ targetUserId, now, session });
      }
      return this.deleteInTransaction(input, actor, targetUserId, now, session);
    });
  }

  private participant(
    request: IAlumniHelpRequest,
    targetUserId: mongoose.Types.ObjectId,
  ): AlumniHelpParticipantRole {
    if (request.requesterId.equals(targetUserId)) return "requester";
    if (request.providerId.equals(targetUserId)) return "provider";
    throw new Error("Account owner is not a Help Request participant.");
  }

  private async terminateHelpRequests(
    targetUserId: mongoose.Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<{ requests: number; rooms: number }> {
    const requests = await AlumniHelpRequest.find({
      $or: [{ requesterId: targetUserId }, { providerId: targetUserId }],
      status: { $in: ALUMNI_HELP_ACTIVE_REQUEST_STATUSES },
    })
      .sort({ _id: 1 })
      .session(session)
      .exec();
    let rooms = 0;

    for (const request of requests) {
      const expectedRevision = request.revision;
      const fromStatus = request.status;
      const actorRole = this.participant(request, targetUserId);
      let action: AlumniHelpLifecycleAction;
      let toStatus: AlumniHelpRequestStatus;

      if (request.hasBeenAccepted) {
        action = "close";
        toStatus = "closed";
        request.closedAt = now;
        request.purgeAt = acceptedHelpRequestPurgeAt(
          now,
          request.latestOutcomeDueAt,
        );
      } else if (actorRole === "requester") {
        action = "withdraw";
        toStatus = "withdrawn";
        request.withdrawnAt = now;
        request.purgeAt = neverAcceptedHelpRequestPurgeAt(now);
      } else {
        action = "decline";
        toStatus = "declined";
        request.declinedAt = now;
        request.purgeAt = neverAcceptedHelpRequestPurgeAt(now);
      }

      const event: AlumniHelpLifecycleEvent = {
        _id: new mongoose.Types.ObjectId(),
        sequence: request.lifecycleTimeline.length + 1,
        action,
        fromStatus,
        toStatus,
        actorRole,
        actorId: targetUserId,
        note: null,
        helpType: null,
        occurredAt: now,
      };
      request.status = toStatus;
      request.activeUniqueness = false;
      request.lifecycleTimeline.push(event);
      request.revision = expectedRevision + 1;
      await request.validate();

      const updated = await AlumniHelpRequest.updateOne(
        { _id: request._id, status: fromStatus, revision: expectedRevision },
        {
          $set: {
            status: request.status,
            activeUniqueness: false,
            declinedAt: request.declinedAt ?? null,
            withdrawnAt: request.withdrawnAt ?? null,
            closedAt: request.closedAt ?? null,
            purgeAt: request.purgeAt,
            revision: request.revision,
          },
          $push: { lifecycleTimeline: event },
        },
        { session, runValidators: false },
      );
      if (updated.modifiedCount !== 1) {
        throw new Error("Help Request changed during account deletion.");
      }

      if (request.hasBeenAccepted) {
        if (!request.conversationId || !request.purgeAt) {
          throw new Error("Accepted Help Request is missing its Room.");
        }
        await AlumniHelpOutcomeSubmission.updateMany(
          { helpRequestId: request._id },
          { $set: { purgeAt: request.purgeAt } },
          { session, runValidators: false },
        );
        await alumniHelpRoomProvisioner.archiveInTransaction({
          conversationId: request.conversationId,
          helpRequestId: request._id,
          archivedAt: now,
          session,
        });
        rooms += 1;
      }
    }
    return { requests: requests.length, rooms };
  }

  private async closeRemainingAccessWindows(
    targetUserId: mongoose.Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<number> {
    const members = await ConversationMember.find({
      userId: targetUserId,
      status: "active",
    })
      .sort({ _id: 1 })
      .session(session)
      .exec();
    let closed = 0;

    for (const member of members) {
      const room = await Conversation.findById(member.conversationId)
        .session(session)
        .exec();
      if (!room) throw new Error("Conversation is missing during account deletion.");
      const expectedRevision = member.revision;
      let changedWindow = false;
      for (const window of member.accessWindows) {
        if (window.visibleThroughSequence == null) {
          window.visibleThroughSequence = room.lastSequence;
          window.closedAt = now;
          changedWindow = true;
        }
      }
      if (!changedWindow) {
        throw new Error("Active conversation membership has no open access window.");
      }
      member.status = "history_only";
      member.lastReadSequence = room.lastSequence;
      member.unreadCount = 0;
      member.unreadReconciledThroughSequence = room.lastSequence;
      member.unreadReconciledAt = now;
      member.purgeAt = room.status === "archived" ? room.purgeAt : null;
      member.revision = expectedRevision + 1;
      await member.validate();
      const update = await ConversationMember.updateOne(
        { _id: member._id, status: "active", revision: expectedRevision },
        {
          $set: {
            status: member.status,
            accessWindows: member.accessWindows,
            lastReadSequence: member.lastReadSequence,
            unreadCount: 0,
            unreadReconciledThroughSequence:
              member.unreadReconciledThroughSequence,
            unreadReconciledAt: now,
            purgeAt: member.purgeAt ?? null,
            updatedAt: now,
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: false },
      );
      if (update.modifiedCount !== 1) {
        throw new Error("Conversation membership changed during account deletion.");
      }
      closed += 1;
    }
    return closed;
  }

  private async deleteInTransaction(
    input: DeleteAlumniAccountInput,
    actor: ReturnType<typeof auditActor>,
    targetUserId: mongoose.Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<DeleteAlumniAccountResult> {
    const profilePurgeAt = addFixedDays(
      now,
      ACCOUNT_DELETION_RETENTION_DAYS,
    );
    const consentPurgeAt = addUtcCalendarMonths(
      now,
      CONSENT_RECORD_RETENTION_MONTHS,
    );
    const help = await this.terminateHelpRequests(targetUserId, now, session);
    const accessWindowsClosed = await this.closeRemainingAccessWindows(
      targetUserId,
      now,
      session,
    );

    const profile = await AlumniProfile.findOne({ userId: targetUserId })
      .session(session)
      .exec();
    let profileScheduled = false;
    let affiliationsScheduled = 0;

    if (profile) {
      const expectedRevision = profile.revision;
      const wasPublished = profile.publishStatus === "published";
      profile.set({
        publishStatus: wasPublished ? "withdrawn" : profile.publishStatus,
        currentPublicationConsentId: undefined,
        withdrawnAt: wasPublished ? now : profile.withdrawnAt,
        accountDeletionApprovedAt: now,
        purgeAt: profilePurgeAt,
        revision: expectedRevision + 1,
      });
      await profile.validate();

      const profileUpdate = await AlumniProfile.updateOne(
        { _id: profile._id, userId: targetUserId, revision: expectedRevision },
        {
          $set: {
            publishStatus: profile.publishStatus,
            withdrawnAt: profile.withdrawnAt ?? null,
            accountDeletionApprovedAt: now,
            purgeAt: profilePurgeAt,
            revision: expectedRevision + 1,
          },
          $unset: { currentPublicationConsentId: 1 },
        },
        { session, runValidators: false },
      );
      if (profileUpdate.modifiedCount !== 1) {
        throw new Error("Alumni profile changed during account deletion.");
      }
      profileScheduled = true;

      const affiliationUpdate = await AlumniAffiliation.updateMany(
        {
          alumniProfileId: profile._id,
          accountDeletionApprovedAt: null,
          purgeAt: null,
        },
        {
          $set: {
            accountDeletionApprovedAt: now,
            purgeAt: profilePurgeAt,
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: false },
      );
      affiliationsScheduled = affiliationUpdate.modifiedCount;
    }

    const activeConsents = await ConsentRecord.find({
      subjectUserId: targetUserId,
      status: "active",
    })
      .session(session)
      .exec();
    let consentsTerminated = 0;
    for (const consent of activeConsents) {
      const expectedRevision = consent.revision;
      consent.set({
        status: "account_deleted",
        accountDeletionApprovedAt: now,
        purgeAt: consentPurgeAt,
        revision: expectedRevision + 1,
      });
      await consent.validate();
      const consentUpdate = await ConsentRecord.updateOne(
        { _id: consent._id, status: "active", revision: expectedRevision },
        {
          $set: {
            status: "account_deleted",
            accountDeletionApprovedAt: now,
            purgeAt: consentPurgeAt,
            revision: expectedRevision + 1,
          },
        },
        { session, runValidators: false },
      );
      if (consentUpdate.modifiedCount !== 1) {
        throw new Error("Consent changed during account deletion.");
      }
      consentsTerminated += 1;
    }

    // MongoDB does not support parallel operations on one transaction session.
    await PushSubscription.deleteMany({ userId: targetUserId }, { session });
    await NotificationPreference.deleteMany(
      { userId: targetUserId },
      { session },
    );
    await RefreshSession.deleteMany({ userId: targetUserId }, { session });

    const deletedUser = await User.findOneAndDelete(
      { _id: targetUserId },
      { session },
    );
    if (!deletedUser) {
      throw new Error("User not found during account deletion.");
    }

    await this.audit.recordRequiredInTransaction(
      {
        action: "alumni_account.deleted",
        actor,
        source: actor.type === "system" ? "system" : "http",
        outcome: "success",
        target: { model: "User", id: targetUserId.toString() },
        correlationId: input.correlationId,
        details: {
          profileScheduled,
          affiliationsScheduled,
          consentsTerminated,
          helpRequestsTerminated: help.requests,
          helpRoomsArchived: help.rooms,
          accessWindowsClosed,
          profileRetentionDays: ACCOUNT_DELETION_RETENTION_DAYS,
          consentRetentionMonths: CONSENT_RECORD_RETENTION_MONTHS,
        },
      },
      session,
    );

    return {
      profileScheduled,
      affiliationsScheduled,
      consentsTerminated,
      helpRequestsTerminated: help.requests,
      helpRoomsArchived: help.rooms,
      accessWindowsClosed,
    };
  }
}

export const alumniAccountDeletionService =
  new AlumniAccountDeletionService();
