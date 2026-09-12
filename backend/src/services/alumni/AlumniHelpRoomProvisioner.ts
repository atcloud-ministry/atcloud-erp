import mongoose, { type ClientSession } from "mongoose";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";

export interface EnsureAlumniHelpRoomInput {
  readonly helpRequestId: mongoose.Types.ObjectId;
  readonly requesterId: mongoose.Types.ObjectId;
  readonly providerId: mongoose.Types.ObjectId;
  readonly acceptedAt: Date;
  readonly session: ClientSession;
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
}

export const alumniHelpRoomProvisioner = new AlumniHelpRoomProvisioner();
