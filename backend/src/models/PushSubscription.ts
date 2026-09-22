import mongoose, { type Document, type Model, Schema } from "mongoose";

export const PUSH_SUBSCRIPTION_COLLECTION = "push_subscriptions" as const;
export interface IPushSubscription extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  installationId: string;
  endpoint: string;
  endpointHash: string;
  vapidKeyId: string;
  expirationTime?: Date | null;
  keys: { p256dh: string; auth: string };
  lastSuccessfulPushAt?: Date | null;
  lastAttemptAt?: Date | null;
  consecutiveFailureCount: number;
  lastFailureCode?: string | null;
  deliveredEventIds: string[];
  staleAt: Date;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const pushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    installationId: {
      type: String,
      required: true,
      maxlength: 128,
      match: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    },
    endpoint: { type: String, required: true, maxlength: 2_048 },
    endpointHash: {
      type: String,
      required: true,
      match: SHA256_PATTERN,
    },
    vapidKeyId: {
      type: String,
      required: true,
      match: SHA256_PATTERN,
    },
    expirationTime: { type: Date, default: null },
    keys: {
      p256dh: { type: String, required: true, maxlength: 512 },
      auth: { type: String, required: true, maxlength: 512 },
    },
    lastSuccessfulPushAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    consecutiveFailureCount: { type: Number, required: true, default: 0, min: 0 },
    lastFailureCode: { type: String, default: null, maxlength: 80 },
    deliveredEventIds: {
      type: [String],
      default: [],
      validate: {
        validator: (value: unknown) =>
          Array.isArray(value) &&
          value.length <= 50 &&
          value.every(
            (entry) =>
              typeof entry === "string" &&
              /^[0-9a-f-]{36}$/i.test(entry),
          ),
        message: "Delivered event IDs must be a bounded UUID list.",
      },
    },
    staleAt: { type: Date, required: true },
    revision: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    collection: PUSH_SUBSCRIPTION_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

pushSubscriptionSchema.index(
  { userId: 1, installationId: 1 },
  { unique: true, name: "uniq_push_user_installation" },
);
pushSubscriptionSchema.index(
  { endpointHash: 1 },
  { unique: true, name: "uniq_push_endpoint_hash" },
);
pushSubscriptionSchema.index(
  { userId: 1, updatedAt: -1 },
  { name: "idx_push_user_active" },
);
pushSubscriptionSchema.index(
  { vapidKeyId: 1, userId: 1 },
  { name: "idx_push_vapid_key_user" },
);
pushSubscriptionSchema.index(
  { lastSuccessfulPushAt: 1, createdAt: 1 },
  { name: "idx_push_stale_cleanup" },
);
pushSubscriptionSchema.index(
  { staleAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_push_subscription_stale_at" },
);

const PushSubscription: Model<IPushSubscription> =
  (mongoose.models.PushSubscription as Model<IPushSubscription> | undefined) ||
  mongoose.model<IPushSubscription>("PushSubscription", pushSubscriptionSchema);

export default PushSubscription;
