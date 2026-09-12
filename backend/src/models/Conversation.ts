import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  CONVERSATION_KINDS,
  CONVERSATION_STATUSES,
  conversationPurgeAt,
  type ConversationKind,
  type ConversationStatus,
} from "../contracts/chatRooms";
import {
  datesEqual,
  isNonNegativeSafeInteger,
} from "../contracts/alumniDirectoryData";

export {
  CONVERSATION_KINDS,
  CONVERSATION_STATUSES,
  type ConversationKind,
  type ConversationStatus,
} from "../contracts/chatRooms";

export const CONVERSATION_COLLECTION = "conversations" as const;

export interface IConversation extends Document {
  _id: mongoose.Types.ObjectId;
  kind: ConversationKind;
  status: ConversationStatus;
  helpRequestId?: mongoose.Types.ObjectId | null;
  programId?: mongoose.Types.ObjectId | null;
  lastSequence: number;
  lastMessageId?: mongoose.Types.ObjectId | null;
  latestMessagePurgeAt?: Date | null;
  archivedAt?: Date | null;
  purgeAt?: Date | null;
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
      default: null,
      immutable: true,
    },
    programId: {
      type: Schema.Types.ObjectId,
      ref: "Program",
      default: null,
      immutable: true,
    },
    lastSequence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    lastMessageId: {
      type: Schema.Types.ObjectId,
      ref: "ChatMessage",
      default: null,
    },
    latestMessagePurgeAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
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
  const hasHelpRequest = this.helpRequestId instanceof mongoose.Types.ObjectId;
  const hasProgram = this.programId instanceof mongoose.Types.ObjectId;
  if (
    (this.kind === "alumni_help" && (!hasHelpRequest || hasProgram)) ||
    (this.kind === "program" && (!hasProgram || hasHelpRequest))
  ) {
    this.invalidate(
      "kind",
      "Conversation kind must match exactly one resource identity.",
    );
  }

  if (
    (this.lastSequence === 0 &&
      (this.lastMessageId != null || this.latestMessagePurgeAt != null)) ||
    (this.lastSequence > 0 &&
      (!(this.lastMessageId instanceof mongoose.Types.ObjectId) ||
        !(this.latestMessagePurgeAt instanceof Date)))
  ) {
    this.invalidate(
      "lastMessageId",
      "Message retention summary fields must match lastSequence.",
    );
  }

  if (this.status === "current") {
    if (this.archivedAt || this.purgeAt) {
      this.invalidate(
        "archivedAt",
        "Current conversations cannot contain archive retention metadata.",
      );
    }
  } else if (!this.archivedAt || !this.purgeAt) {
    this.invalidate(
      "archivedAt",
      "Archived conversations require archivedAt and purgeAt.",
    );
  } else if (
    !datesEqual(
      this.purgeAt,
      conversationPurgeAt(this.archivedAt, this.latestMessagePurgeAt),
    )
  ) {
    this.invalidate(
      "purgeAt",
      "Conversation purgeAt must match its approved retention clock.",
    );
  }
  next();
});

conversationSchema.index(
  { helpRequestId: 1 },
  {
    unique: true,
    name: "uniq_conversation_alumni_help_request",
    partialFilterExpression: { helpRequestId: { $type: "objectId" } },
  },
);
conversationSchema.index(
  { programId: 1 },
  {
    unique: true,
    name: "uniq_conversation_program",
    partialFilterExpression: { programId: { $type: "objectId" } },
  },
);
conversationSchema.index(
  { status: 1, updatedAt: -1, _id: -1 },
  { name: "idx_conversation_status_list" },
);
conversationSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_conversation_purge_at" },
);

const Conversation: Model<IConversation> =
  (mongoose.models.Conversation as Model<IConversation> | undefined) ||
  mongoose.model<IConversation>("Conversation", conversationSchema);

export default Conversation;
