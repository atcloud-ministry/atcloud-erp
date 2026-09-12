import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  isValidDisplayText,
  normalizeDisplayText,
} from "@atcloud/shared-time/registration-profile";
import {
  CHAT_MESSAGE_FIELD_LIMITS,
  CHAT_MESSAGE_KINDS,
  UUID_PATTERN,
  chatMessagePurgeAt,
  isValidChatMessagePayload,
  isValidChatSafeLinkUrl,
  isValidChatText,
  isValidSafeLinkLabel,
  normalizeChatText,
  normalizeSafeLinkLabel,
  type ChatMessageKind,
  type ChatSafeLink,
} from "../contracts/chatRooms";
import { datesEqual } from "../contracts/alumniDirectoryData";

export {
  CHAT_MESSAGE_FIELD_LIMITS,
  CHAT_MESSAGE_KINDS,
  type ChatMessageKind,
  type ChatSafeLink,
} from "../contracts/chatRooms";

export const CHAT_MESSAGE_COLLECTION = "chat_messages" as const;

export interface ChatSenderSnapshot {
  readonly displayName: string;
  readonly avatar: string | null;
}

export interface IChatMessage extends Document {
  _id: mongoose.Types.ObjectId;
  conversationId: mongoose.Types.ObjectId;
  sequence: number;
  senderId: mongoose.Types.ObjectId;
  senderSnapshot: ChatSenderSnapshot;
  clientMessageId: string;
  kind: ChatMessageKind;
  content?: string | null;
  safeLink?: ChatSafeLink | null;
  createdAt: Date;
  purgeAt: Date;
}

const chatSafeLinkSchema = new Schema<ChatSafeLink>(
  {
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: CHAT_MESSAGE_FIELD_LIMITS.safeLinkUrl,
      validate: isValidChatSafeLinkUrl,
      immutable: true,
    },
    label: {
      type: String,
      required: true,
      set: normalizeSafeLinkLabel,
      maxlength: CHAT_MESSAGE_FIELD_LIMITS.safeLinkLabel,
      validate: isValidSafeLinkLabel,
      immutable: true,
    },
  },
  { _id: false, strict: "throw" },
);

const chatSenderSnapshotSchema = new Schema<ChatSenderSnapshot>(
  {
    displayName: {
      type: String,
      required: true,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeDisplayText(value) : value,
      validate: {
        validator: (value: unknown) => isValidDisplayText(value, 1, 160),
        message: "Sender displayName must contain 1-160 safe characters.",
      },
      immutable: true,
    },
    avatar: {
      type: String,
      default: null,
      maxlength: 2_048,
      immutable: true,
    },
  },
  { _id: false, strict: "throw", minimize: false },
);

const chatMessageSchema = new Schema<IChatMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      immutable: true,
    },
    sequence: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    senderSnapshot: {
      type: chatSenderSnapshotSchema,
      required: true,
      immutable: true,
    },
    clientMessageId: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: UUID_PATTERN,
      immutable: true,
    },
    kind: {
      type: String,
      enum: CHAT_MESSAGE_KINDS,
      required: true,
      immutable: true,
    },
    content: {
      type: String,
      default: null,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeChatText(value) : value,
      validate: {
        validator: (value: unknown) => value == null || isValidChatText(value),
      },
      immutable: true,
    },
    safeLink: {
      type: chatSafeLinkSchema,
      default: null,
      immutable: true,
    },
    createdAt: { type: Date, required: true, immutable: true },
    purgeAt: { type: Date, required: true, immutable: true },
  },
  {
    collection: CHAT_MESSAGE_COLLECTION,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

chatMessageSchema.pre("validate", function enforceChatMessageInvariants(next) {
  if (
    !isValidChatMessagePayload({
      content: this.content,
      safeLink: this.safeLink,
    })
  ) {
    this.invalidate(
      "content",
      "A chat message requires a valid bounded text or safeLink payload.",
    );
  }
  if (
    this.createdAt instanceof Date &&
    !Number.isNaN(this.createdAt.getTime()) &&
    !datesEqual(this.purgeAt, chatMessagePurgeAt(this.createdAt))
  ) {
    this.invalidate(
      "purgeAt",
      "ChatMessage purgeAt must be twelve UTC calendar months after creation.",
    );
  }
  next();
});

chatMessageSchema.index(
  { conversationId: 1, sequence: 1 },
  { unique: true, name: "uniq_chat_message_room_sequence" },
);
chatMessageSchema.index(
  { conversationId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, name: "uniq_chat_message_client_retry" },
);
chatMessageSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_chat_message_purge_at" },
);

const ChatMessage: Model<IChatMessage> =
  (mongoose.models.ChatMessage as Model<IChatMessage> | undefined) ||
  mongoose.model<IChatMessage>("ChatMessage", chatMessageSchema);

export default ChatMessage;
