import mongoose, { type Document, type Model, Schema } from "mongoose";
import { isNonNegativeSafeInteger } from "../contracts/alumniDirectoryData";
import { ALUMNI_HELP_PARTICIPANT_ROLES, type AlumniHelpParticipantRole } from "../contracts/alumniHelpFlow";

export const CONVERSATION_MEMBER_COLLECTION = "conversation_members" as const;
export const CONVERSATION_MEMBER_STATUSES = ["active"] as const;
export type ConversationMemberStatus =
  (typeof CONVERSATION_MEMBER_STATUSES)[number];

export interface IConversationMember extends Document {
  _id: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: AlumniHelpParticipantRole;
  status: ConversationMemberStatus;
  joinedAt: Date;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const conversationMemberSchema = new Schema<IConversationMember>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      immutable: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    role: {
      type: String,
      enum: ALUMNI_HELP_PARTICIPANT_ROLES,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: CONVERSATION_MEMBER_STATUSES,
      required: true,
      default: "active",
    },
    joinedAt: { type: Date, required: true, immutable: true },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
  },
  {
    collection: CONVERSATION_MEMBER_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

conversationMemberSchema.index(
  { conversationId: 1, userId: 1 },
  { unique: true, name: "uniq_conversation_member_user" },
);
conversationMemberSchema.index(
  { conversationId: 1, role: 1 },
  { unique: true, name: "uniq_conversation_member_role" },
);
conversationMemberSchema.index(
  { userId: 1, status: 1, updatedAt: -1, _id: -1 },
  { name: "idx_conversation_member_user_list" },
);

const ConversationMember: Model<IConversationMember> =
  (mongoose.models.ConversationMember as
    | Model<IConversationMember>
    | undefined) ||
  mongoose.model<IConversationMember>(
    "ConversationMember",
    conversationMemberSchema,
  );

export default ConversationMember;
