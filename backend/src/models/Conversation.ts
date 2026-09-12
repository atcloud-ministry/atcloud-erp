import mongoose, { type Document, type Model, Schema } from "mongoose";
import { isNonNegativeSafeInteger } from "../contracts/alumniDirectoryData";

export const CONVERSATION_COLLECTION = "conversations" as const;
export const CONVERSATION_KINDS = ["alumni_help"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const CONVERSATION_STATUSES = ["current", "archived"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface IConversation extends Document {
  _id: mongoose.Types.ObjectId;
  kind: ConversationKind;
  status: ConversationStatus;
  helpRequestId: mongoose.Types.ObjectId;
  lastSequence: number;
  archivedAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    kind: {
      type: String,
      enum: CONVERSATION_KINDS,
      required: true,
      immutable: true,
      default: "alumni_help",
    },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      required: true,
      default: "current",
    },
    helpRequestId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniHelpRequest",
      required: true,
      immutable: true,
    },
    lastSequence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    archivedAt: { type: Date, default: null },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
  },
  {
    collection: CONVERSATION_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

conversationSchema.pre("validate", function enforceConversationInvariants(next) {
  if ((this.status === "archived") !== Boolean(this.archivedAt)) {
    this.invalidate(
      "archivedAt",
      "Archived conversation state and archivedAt must match.",
    );
  }
  next();
});

conversationSchema.index(
  { helpRequestId: 1 },
  { unique: true, name: "uniq_conversation_alumni_help_request" },
);
conversationSchema.index(
  { status: 1, updatedAt: -1, _id: -1 },
  { name: "idx_conversation_status_list" },
);

const Conversation: Model<IConversation> =
  (mongoose.models.Conversation as Model<IConversation> | undefined) ||
  mongoose.model<IConversation>("Conversation", conversationSchema);

export default Conversation;
