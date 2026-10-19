import mongoose, { type ClientSession } from "mongoose";
import {
  ALUMNI_HELP_ACTIVE_REQUEST_STATUSES,
  acceptedHelpRequestPurgeAt,
  neverAcceptedHelpRequestPurgeAt,
  type AlumniHelpLifecycleAction,
  type AlumniHelpParticipantRole,
  type AlumniHelpRequestStatus,
} from "../../contracts/alumniHelpFlow";
import AlumniHelpOutcomeSubmission from "../../models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest, {
  type AlumniHelpLifecycleEvent,
  type IAlumniHelpRequest,
} from "../../models/AlumniHelpRequest";
import { alumniHelpRoomProvisioner } from "./AlumniHelpRoomProvisioner";
import { enqueueAlumniHelpWorkflowNotifications } from "./AlumniHelpWorkflowDeliveryHandler";

export interface TerminateActiveHelpRequestsInput {
  readonly targetUserId: mongoose.Types.ObjectId;
  /**
   * "any" ends every request the user takes part in (account deletion).
   * "provider" ends only requests made to the user as an alumni member, which
   * is what leaving the Alumni Network means; their own requests stay open.
   */
  readonly scope: "any" | "provider";
  readonly now: Date;
  readonly session: ClientSession;
  /** Notify the other participant through the Alumni Help workflow outbox. */
  readonly notify?: { readonly correlationId?: string };
  /** Message used when a concurrent change is detected. */
  readonly conflictMessage: string;
}

function participant(
  request: IAlumniHelpRequest,
  targetUserId: mongoose.Types.ObjectId,
): AlumniHelpParticipantRole {
  if (request.requesterId.equals(targetUserId)) return "requester";
  if (request.providerId.equals(targetUserId)) return "provider";
  throw new Error("Target user is not a Help Request participant.");
}

/**
 * End the user's active Help Requests in the caller's transaction. Accepted
 * requests are closed and their Chat Room archived, which leaves the history
 * readable but stops new messages for both participants; requests never
 * accepted are declined or withdrawn.
 */
export async function terminateActiveHelpRequestsInTransaction(
  input: TerminateActiveHelpRequestsInput,
): Promise<{ requests: number; rooms: number }> {
  const { targetUserId, now, session } = input;
  const requests = await AlumniHelpRequest.find({
    ...(input.scope === "provider"
      ? { providerId: targetUserId }
      : { $or: [{ requesterId: targetUserId }, { providerId: targetUserId }] }),
    status: { $in: ALUMNI_HELP_ACTIVE_REQUEST_STATUSES },
  })
    .sort({ _id: 1 })
    .session(session)
    .exec();
  let rooms = 0;

  for (const request of requests) {
    const expectedRevision = request.revision;
    const fromStatus = request.status;
    const actorRole = participant(request, targetUserId);
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
      throw new Error(input.conflictMessage);
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

    if (input.notify) {
      await enqueueAlumniHelpWorkflowNotifications({
        requestId: request._id.toString(),
        requestRevision: request.revision,
        timelineEventId: event._id.toString(),
        eventType: action,
        actorUserId: targetUserId.toString(),
        requesterId: request.requesterId.toString(),
        providerId: request.providerId.toString(),
        occurredAt: now,
        session,
        correlationId: input.notify.correlationId,
      });
    }
  }
  return { requests: requests.length, rooms };
}
