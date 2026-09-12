import mongoose, { type Document, type Model, Schema } from "mongoose";

export const NOTIFICATION_PREFERENCE_COLLECTION =
  "notification_preferences" as const;

export interface INotificationPreference extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  pushEnabled: boolean;
  emailEnabled: boolean;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const notificationPreferenceSchema = new Schema<INotificationPreference>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    pushEnabled: { type: Boolean, required: true, default: true },
    emailEnabled: { type: Boolean, required: true, default: true },
    purgeAt: { type: Date, default: null },
    revision: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    collection: NOTIFICATION_PREFERENCE_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

notificationPreferenceSchema.index(
  { userId: 1 },
  { unique: true, name: "uniq_notification_preference_user" },
);
notificationPreferenceSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_notification_preference_purge_at" },
);

const NotificationPreference: Model<INotificationPreference> =
  (mongoose.models.NotificationPreference as
    | Model<INotificationPreference>
    | undefined) ||
  mongoose.model<INotificationPreference>(
    "NotificationPreference",
    notificationPreferenceSchema,
  );

export default NotificationPreference;
