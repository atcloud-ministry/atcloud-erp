import mongoose, { type ClientSession } from "mongoose";
import { conversationPurgeAt } from "../../contracts/chatRooms";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";

export interface EnsureAlumniHelpRoomInput {
  readonly helpRequestId: mongoose.Types.ObjectId;
  readonly requesterId: mongoose.Types.ObjectId;
  readonly providerId: mongoose.Types.ObjectId;
  readonly acceptedAt: Date;
  readonly session: ClientSession;
}

export interface ArchiveAlumniHelpRoomInput {
  readonly conversationId: mongoose.Types.ObjectId;
  readonly helpRequestId: mongoose.Types.ObjectId;
  readonly archivedAt: Date;
  readonly session: ClientSession;
}

export interface StartAlumniHelpRoomGraceInput {
  readonly conversationId: mongoose.Types.ObjectId;
  readonly helpRequestId: mongoose.Types.ObjectId;
  readonly occurredAt: Date;
  readonly writeAccessEndsAt: Date;
  readonly session: ClientSession;
}

function sameInstant(first: Date | null | undefined, second: Date): boolean {
  return first instanceof Date && first.getTime() === second.getTime();
}

/**
 * Creates the private two-person room as part of the acceptance transaction.
 * The unique helpRequestId and member-pair indexes make transaction retries
 * safe; message/history capabilities are intentionally added in M4.
 */
export class AlumniHelpRoomProvisioner {
  async ensureInTransaction(
    input: EnsureAlumniHelpRoomInput,
  ): Promise<mongoose.Types.ObjectId> {
    if (input.requesterId.equals(input.providerId)) {
      throw new Error("An Alumni Help Room requires two distinct members.");
    }

    const room = await Conversation.findOneAndUpdate(
      { kind: "alumni_help", helpRequestId: input.helpRequestId },
      {
        $setOnInsert: {
          _id: new mongoose.Types.ObjectId(),
          kind: "alumni_help",
          status: "current",
          helpRequestId: input.helpRequestId,
          lastSequence: 0,
          lastMessageId: null,
          latestMessagePurgeAt: null,
          writeAccessEndsAt: null,
          archivedAt: null,
          purgeAt: null,
          revision: 0,
          createdAt: input.acceptedAt,
          updatedAt: input.acceptedAt,
        },
      },
      {
        upsert: true,
        new: true,
        session: input.session,
        runValidators: true,
        setDefaultsOnInsert: true,
        // The room's immutable creation clock is the acceptance clock supplied
        // by the domain transaction. Disable query timestamp injection here so
        // Mongoose does not also place updatedAt in $set and conflict with the
        // explicit $setOnInsert value.
        timestamps: false,
      },
    );
    if (!room) throw new Error("Failed to provision the Alumni Help Room.");

    await ConversationMember.bulkWrite(
      [
        {
          updateOne: {
            filter: {
              conversationId: room._id,
              userId: input.requesterId,
            },
            update: {
              $setOnInsert: {
                conversationId: room._id,
                userId: input.requesterId,
                role: "requester",
                status: "active",
                joinedAt: input.acceptedAt,
                accessWindows: [
                  {
                    visibleFromSequence: 1,
                    visibleThroughSequence: null,
                    openedAt: input.acceptedAt,
                    closedAt: null,
                  },
                ],
                lastReadSequence: 0,
                unreadCount: 0,
                unreadReconciledThroughSequence: 0,
                unreadReconciledAt: input.acceptedAt,
                muted: false,
                mutedAt: null,
                purgeAt: null,
                revision: 0,
              },
            },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: {
              conversationId: room._id,
              userId: input.providerId,
            },
            update: {
              $setOnInsert: {
                conversationId: room._id,
                userId: input.providerId,
                role: "provider",
                status: "active",
                joinedAt: input.acceptedAt,
                accessWindows: [
                  {
                    visibleFromSequence: 1,
                    visibleThroughSequence: null,
                    openedAt: input.acceptedAt,
                    closedAt: null,
                  },
                ],
                lastReadSequence: 0,
                unreadCount: 0,
                unreadReconciledThroughSequence: 0,
                unreadReconciledAt: input.acceptedAt,
                muted: false,
                mutedAt: null,
                purgeAt: null,
                revision: 0,
              },
            },
            upsert: true,
          },
        },
      ],
      { session: input.session, ordered: true },
    );

    const members = await ConversationMember.countDocuments({
      conversationId: room._id,
      status: "active",
    }).session(input.session);
    if (members !== 2) {
      throw new Error("An Alumni Help Room must contain exactly two members.");
    }

    return room._id;
  }

  /**
   * Keep a closed Help Request's private Room writable until the fixed
   * deadline. The separate bounded worker archives it at that exact clock.
   */
  async startGraceInTransaction(
    input: StartAlumniHelpRoomGraceInput,
  ): Promise<void> {
    if (
      !(input.occurredAt instanceof Date) ||
      Number.isNaN(input.occurredAt.getTime()) ||
      !(input.writeAccessEndsAt instanceof Date) ||
      Number.isNaN(input.writeAccessEndsAt.getTime()) ||
      input.writeAccessEndsAt.getTime() <= input.occurredAt.getTime()
    ) {
      throw new Error("The Alumni Help Room grace deadline is invalid.");
    }
    const room = await Conversation.findOne({
      _id: input.conversationId,
      kind: "alumni_help",
      helpRequestId: input.helpRequestId,
    })
      .session(input.session)
      .exec();
    if (!room) throw new Error("The Alumni Help Room is unavailable.");
    if (room.status !== "current") {
      throw new Error("The Alumni Help Room is no longer current.");
    }
    if (
      room.writeAccessEndsAt instanceof Date &&
      !sameInstant(room.writeAccessEndsAt, input.writeAccessEndsAt)
    ) {
      throw new Error("The Alumni Help Room grace period is already different.");
    }
    if (sameInstant(room.writeAccessEndsAt, input.writeAccessEndsAt)) return;

    room.writeAccessEndsAt = input.writeAccessEndsAt;
    room.updatedAt = input.occurredAt;
    await room.validate();
    const updated = await Conversation.updateOne(
      {
        _id: room._id,
        kind: "alumni_help",
        helpRequestId: input.helpRequestId,
        status: "current",
        revision: room.revision,
        writeAccessEndsAt: null,
      },
      {
        $set: {
          writeAccessEndsAt: input.writeAccessEndsAt,
          updatedAt: input.occurredAt,
        },
        $inc: { revision: 1 },
      },
      { session: input.session, runValidators: false },
    );
    if (updated.modifiedCount !== 1) {
      throw new Error("The Alumni Help Room changed during grace setup.");
    }
  }

  /** Archive the room and both access histories inside the Help close transaction. */
  async archiveInTransaction(
    input: ArchiveAlumniHelpRoomInput,
  ): Promise<void> {
    const room = await Conversation.findOne({
      _id: input.conversationId,
      kind: "alumni_help",
      helpRequestId: input.helpRequestId,
    })
      .session(input.session)
      .lean()
      .exec();
    if (!room) throw new Error("The Alumni Help Room is unavailable.");

    const purgeAt = conversationPurgeAt(
      input.archivedAt,
      room.latestMessagePurgeAt,
    );
    if (room.status === "current") {
      const expectedRevision = room.revision;
      const archived = await Conversation.updateOne(
        {
          _id: room._id,
          kind: "alumni_help",
          helpRequestId: input.helpRequestId,
          status: "current",
          revision: expectedRevision,
        },
        {
          $set: {
            status: "archived",
            archivedAt: input.archivedAt,
            purgeAt,
            updatedAt: input.archivedAt,
          },
          $inc: { revision: 1 },
        },
        { session: input.session, runValidators: false },
      );
      if (archived.modifiedCount !== 1) {
        throw new Error("The Alumni Help Room changed during archive.");
      }
    } else if (
      !sameInstant(room.archivedAt, input.archivedAt) ||
      !sameInstant(room.purgeAt, purgeAt)
    ) {
      throw new Error("The Alumni Help Room is already archived differently.");
    }

    const members = await ConversationMember.find({
      conversationId: room._id,
    })
      .sort({ _id: 1 })
      .session(input.session);
    if (members.length !== 2) {
      throw new Error("An Alumni Help Room must contain exactly two members.");
    }
    for (const member of members) {
      const expectedRevision = member.revision;
      let changed = false;
      for (const window of member.accessWindows) {
        if (window.visibleThroughSequence == null) {
          window.visibleThroughSequence = room.lastSequence;
          window.closedAt = input.archivedAt;
          changed = true;
        }
      }
      if (
        member.status !== "history_only" ||
        member.unreadCount !== 0 ||
        !sameInstant(member.purgeAt, purgeAt)
      ) {
        changed = true;
      }
      if (!changed) continue;
      member.status = "history_only";
      member.unreadCount = 0;
      member.purgeAt = purgeAt;
      await member.validate();
      const updated = await ConversationMember.updateOne(
        { _id: member._id, revision: expectedRevision },
        {
          $set: {
            accessWindows: member.accessWindows,
            status: "history_only",
            unreadCount: 0,
            purgeAt,
            updatedAt: input.archivedAt,
          },
          $inc: { revision: 1 },
        },
        { session: input.session, runValidators: false },
      );
      if (updated.modifiedCount !== 1) {
        throw new Error("An Alumni Help Room member changed during archive.");
      }
    }
  }
}

export const alumniHelpRoomProvisioner = new AlumniHelpRoomProvisioner();
