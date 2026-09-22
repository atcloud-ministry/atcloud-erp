import mongoose, { type Document, type Model, Schema } from "mongoose";

export const FILE_CLEANUP_JOB_COLLECTION = "filecleanupjobs" as const;
export const FILE_CLEANUP_STORAGE_AREAS = [
  "avatars",
  "images",
  "events",
] as const;

export type FileCleanupStorageArea =
  (typeof FILE_CLEANUP_STORAGE_AREAS)[number];

export interface IFileCleanupJob extends Document {
  jobKey: string;
  storageArea: FileCleanupStorageArea;
  filename: string;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  lastAttemptAt?: Date | null;
  lastErrorCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fileCleanupJobSchema = new Schema<IFileCleanupJob>(
  {
    jobKey: {
      type: String,
      required: true,
      immutable: true,
      match: SHA256_PATTERN,
    },
    storageArea: {
      type: String,
      required: true,
      immutable: true,
      enum: FILE_CLEANUP_STORAGE_AREAS,
    },
    filename: {
      type: String,
      required: true,
      immutable: true,
      minlength: 1,
      maxlength: 255,
      select: false,
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    leaseToken: {
      type: String,
      default: null,
      match: UUID_PATTERN,
    },
    leaseExpiresAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: null, maxlength: 80 },
  },
  {
    collection: FILE_CLEANUP_JOB_COLLECTION,
    timestamps: true,
    strict: "throw",
  },
);

fileCleanupJobSchema.index(
  { jobKey: 1 },
  { unique: true, name: "uniq_file_cleanup_job" },
);
fileCleanupJobSchema.index(
  { nextAttemptAt: 1, leaseExpiresAt: 1, _id: 1 },
  { name: "file_cleanup_due" },
);

fileCleanupJobSchema.set("toJSON", {
  transform: (_document, raw) => {
    const value = raw as unknown as Record<string, unknown>;
    delete value.filename;
    delete value.__v;
    return value;
  },
});

const FileCleanupJob: Model<IFileCleanupJob> =
  (mongoose.models.FileCleanupJob as Model<IFileCleanupJob>) ||
  mongoose.model<IFileCleanupJob>("FileCleanupJob", fileCleanupJobSchema);

export default FileCleanupJob;
