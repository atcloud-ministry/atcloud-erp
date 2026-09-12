import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  CONVERSATION_MEMBER_ROLES,
  CONVERSATION_MEMBER_STATUSES,
  hasOpenAccessWindow,
  isValidAccessWindowSequenceRange,
  type ConversationAccessWindowValue,
  type ConversationMemberRole,
  type ConversationMemberStatus,
} from "../contracts/chatRooms";
import { isNonNegativeSafeInteger } from "../contracts/alumniDirectoryData";

export {
  CONVERSATION_MEMBER_ROLES,
  CONVERSATION_MEMBER_STATUSES,
  type ConversationMemberRole,
  type ConversationMemberStatus,
} from "../contracts/chatRooms";

export const CONVERSATION_MEMBER_COLLECTION = "conversation_members" as const;

export interface ConversationAccessWindow
  extends ConversationAccessWindowValue {
  visibleThroughSequence?: number | null;
  closedAt?: Date | null;
}

export interface IConversationMember extends Document {
  _id: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  role: ConversationMemberRole;
  status: ConversationMemberStatus;
  joinedAt: Date;
  accessWindows: ConversationAccessWindow[];
  lastReadSequence: number;
  unreadCount: number;
  unreadReconciledThroughSequence: number;
  unreadReconciledAt?: Date | null;
  muted: boolean;
  mutedAt?: Date | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const conversationAccessWindowSchema = new Schema<ConversationAccessWindow>(
  {
    visibleFromSequence: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    visibleThroughSequence: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (value: unknown) =>
          value == null || isNonNegativeSafeInteger(value),
      },
    },
    openedAt: { type: Date, required: true, immutable: true },
    closedAt: { type: Date, default: null },
  },
  { _id: false, strict: "throw" },
);

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
      enum: CONVERSATION_MEMBER_ROLES,
      required: true,
    },
    status: {
      type: String,
      enum: CONVERSATION_MEMBER_STATUSES,
      required: true,
      default: "active",
    },
    joinedAt: { type: Date, required: true, immutable: true },
    accessWindows: {
      type: [conversationAccessWindowSchema],
      required: true,
      validate: {
        validator: (value: unknown) => Array.isArray(value) && value.length > 0,
        message: "A conversation member requires at least one access window.",
      },
    },
    lastReadSequence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    unreadCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    unreadReconciledThroughSequence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: isNonNegativeSafeInteger,
    },
    unreadReconciledAt: { type: Date, default: null },
    muted: { type: Boolean, required: true, default: false },
    mutedAt: { type: Date, default: null },
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
    collection: CONVERSATION_MEMBER_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

conversationMemberSchema.pre(
  "validate",
  function enforceConversationMemberInvariants(next) {
    const windows = this.accessWindows ?? [];
    let previous: ConversationAccessWindow | undefined;
    for (const window of windows) {
      if (!isValidAccessWindowSequenceRange(window)) {
        this.invalidate(
          "accessWindows",
          "Access-window sequence ranges must be valid and may be empty only at cutoff.",
        );
        break;
      }
      const isClosed = window.visibleThroughSequence != null;
      if (isClosed !== Boolean(window.closedAt)) {
        this.invalidate(
          "accessWindows",
          "Access-window sequence and time cutoffs must be set together.",
        );
        break;
      }
      if (window.closedAt && window.closedAt < window.openedAt) {
        this.invalidate(
          "accessWindows",
          "An access window cannot close before it opens.",
        );
        break;
      }
      if (
        previous &&
        (previous.visibleThroughSequence == null ||
          window.visibleFromSequence <= previous.visibleThroughSequence ||
          !previous.closedAt ||
          window.openedAt < previous.closedAt)
      ) {
        this.invalidate(
          "accessWindows",
          "Access windows must be ordered, closed, and non-overlapping before append.",
        );
        break;
      }
      previous = window;
    }

    const hasOpenWindow = hasOpenAccessWindow(windows);
    if (
      (this.status === "active" && !hasOpenWindow) ||
      (this.status === "history_only" && hasOpenWindow)
    ) {
      this.invalidate(
        "status",
        "Member status must match the current access window.",
      );
    }
    if (this.status === "history_only" && this.unreadCount !== 0) {
      this.invalidate(
        "unreadCount",
        "History-only members cannot retain an unread count.",
      );
    }
    if (this.muted !== Boolean(this.mutedAt)) {
      this.invalidate("mutedAt", "muted and mutedAt must be set together.");
    }
    if (this.purgeAt && this.purgeAt <= this.joinedAt) {
      this.invalidate("purgeAt", "Member purgeAt must be after joinedAt.");
    }
    next();
  },
);

conversationMemberSchema.index(
  { conversationId: 1, userId: 1 },
  { unique: true, name: "uniq_conversation_member_user" },
);
conversationMemberSchema.index(
  { conversationId: 1, status: 1, userId: 1 },
  { name: "idx_conversation_member_room_access" },
);
conversationMemberSchema.index(
  { userId: 1, status: 1, updatedAt: -1, _id: -1 },
  { name: "idx_conversation_member_user_list" },
);
conversationMemberSchema.index(
  { userId: 1, status: 1, unreadCount: 1, conversationId: 1 },
  { name: "idx_conversation_member_user_unread" },
);
conversationMemberSchema.index(
  { status: 1, unreadReconciledAt: 1, _id: 1 },
  { name: "idx_conversation_member_unread_reconciliation" },
);
conversationMemberSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_conversation_member_purge_at" },
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
