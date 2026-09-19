import {
  codePointLength,
  isValidDisplayText,
  normalizeDisplayText,
  normalizeNullableDisplayText,
} from "@atcloud/shared-time/registration-profile";
import mongoose, { type Document, type Model, Schema } from "mongoose";
import {
  ALUMNI_HELP_FIELD_LIMITS,
  ALUMNI_HELP_LIFECYCLE_ACTIONS,
  ALUMNI_HELP_OUTCOME_STATUSES,
  ALUMNI_HELP_PARTICIPANT_ROLES,
  ALUMNI_HELP_REQUEST_STATUSES,
  ALUMNI_HELP_TRANSITIONS,
  ALUMNI_HELP_TYPES,
  acceptedHelpRequestPurgeAt,
  isActiveAlumniHelpRequestStatus,
  neverAcceptedHelpRequestPurgeAt,
  type AlumniHelpLifecycleAction,
  type AlumniHelpOutcomeStatus,
  type AlumniHelpParticipantRole,
  type AlumniHelpRequestStatus,
  type AlumniHelpType,
} from "../contracts/alumniHelpFlow";
import {
  SHA256_HEX_PATTERN,
  datesEqual,
  isNonNegativeSafeInteger,
} from "../contracts/alumniDirectoryData";

export const ALUMNI_HELP_REQUEST_COLLECTION =
  "alumni_help_requests" as const;

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface AlumniHelpParticipantSnapshot {
  displayName: string;
  avatar?: string | null;
}

export interface AlumniHelpLifecycleEvent {
  _id: mongoose.Types.ObjectId;
  sequence: number;
  action: AlumniHelpLifecycleAction;
  fromStatus?: AlumniHelpRequestStatus | null;
  toStatus: AlumniHelpRequestStatus;
  actorRole: AlumniHelpParticipantRole;
  actorId: mongoose.Types.ObjectId;
  note?: string | null;
  helpType?: AlumniHelpType | null;
  occurredAt: Date;
}

export interface IAlumniHelpRequest extends Document {
  _id: mongoose.Types.ObjectId;
  requesterId: mongoose.Types.ObjectId;
  providerId: mongoose.Types.ObjectId;
  alumniProfileId: mongoose.Types.ObjectId;
  requesterSnapshot: AlumniHelpParticipantSnapshot;
  providerSnapshot: AlumniHelpParticipantSnapshot;
  requestedHelpType: AlumniHelpType;
  proposedHelpType?: AlumniHelpType | null;
  agreedHelpType?: AlumniHelpType | null;
  openingNote?: string | null;
  consentVersion: string;
  consentDocumentHash: string;
  disclaimerVersion: string;
  disclaimerDocumentHash: string;
  termsAcceptedAt: Date;
  status: AlumniHelpRequestStatus;
  hasBeenAccepted: boolean;
  activeUniqueness: boolean;
  acceptedAt?: Date | null;
  declinedAt?: Date | null;
  withdrawnAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  closedAt?: Date | null;
  conversationId?: mongoose.Types.ObjectId | null;
  lifecycleTimeline: AlumniHelpLifecycleEvent[];
  latestOutcomeSubmissionId?: mongoose.Types.ObjectId | null;
  latestOutcomeRevisionNumber?: number | null;
  latestOutcomeStatus?: AlumniHelpOutcomeStatus | null;
  latestOutcomeDueAt?: Date | null;
  purgeAt?: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function normalizeOptionalText(value: unknown): unknown {
  return typeof value === "string" ? normalizeNullableDisplayText(value) : value;
}

function validOptionalNote(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "string" &&
      isValidDisplayText(value, 1, ALUMNI_HELP_FIELD_LIMITS.note) &&
      codePointLength(value) <= ALUMNI_HELP_FIELD_LIMITS.note)
  );
}

const participantSnapshotSchema = new Schema<AlumniHelpParticipantSnapshot>(
  {
    displayName: {
      type: String,
      required: true,
      immutable: true,
      set: (value: unknown) =>
        typeof value === "string" ? normalizeDisplayText(value) : value,
      validate: {
        validator: (value: unknown) => isValidDisplayText(value, 1, 160),
        message: "Participant displayName must contain 1-160 safe characters.",
      },
    },
    avatar: {
      type: String,
      default: null,
      immutable: true,
      maxlength: 2_048,
    },
  },
  { _id: false, strict: "throw", minimize: false },
);

const lifecycleEventSchema = new Schema<AlumniHelpLifecycleEvent>(
  {
    sequence: {
      type: Number,
      required: true,
      immutable: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    action: {
      type: String,
      enum: ALUMNI_HELP_LIFECYCLE_ACTIONS,
      required: true,
      immutable: true,
    },
    fromStatus: {
      type: String,
      enum: ALUMNI_HELP_REQUEST_STATUSES,
      default: null,
      immutable: true,
    },
    toStatus: {
      type: String,
      enum: ALUMNI_HELP_REQUEST_STATUSES,
      required: true,
      immutable: true,
    },
    actorRole: {
      type: String,
      enum: ALUMNI_HELP_PARTICIPANT_ROLES,
      required: true,
      immutable: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    note: {
      type: String,
      default: null,
      immutable: true,
      set: normalizeOptionalText,
      validate: {
        validator: validOptionalNote,
        message: "Lifecycle note must contain 1-4000 safe characters.",
      },
    },
    helpType: {
      type: String,
      enum: ALUMNI_HELP_TYPES,
      default: null,
      immutable: true,
    },
    occurredAt: { type: Date, required: true, immutable: true },
  },
  { _id: true, strict: "throw", minimize: false },
);

const alumniHelpRequestSchema = new Schema<IAlumniHelpRequest>(
  {
    requesterId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    providerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    alumniProfileId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniProfile",
      required: true,
      immutable: true,
    },
    requesterSnapshot: {
      type: participantSnapshotSchema,
      required: true,
      immutable: true,
    },
    providerSnapshot: {
      type: participantSnapshotSchema,
      required: true,
      immutable: true,
    },
    requestedHelpType: {
      type: String,
      enum: ALUMNI_HELP_TYPES,
      required: true,
      immutable: true,
    },
    proposedHelpType: {
      type: String,
      enum: ALUMNI_HELP_TYPES,
      default: null,
    },
    agreedHelpType: {
      type: String,
      enum: ALUMNI_HELP_TYPES,
      default: null,
    },
    openingNote: {
      type: String,
      default: null,
      immutable: true,
      set: normalizeOptionalText,
      validate: {
        validator: validOptionalNote,
        message: "Opening note must contain 1-4000 safe characters.",
      },
    },
    consentVersion: {
      type: String,
      required: true,
      immutable: true,
      match: VERSION_PATTERN,
    },
    consentDocumentHash: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
      select: false,
    },
    disclaimerVersion: {
      type: String,
      required: true,
      immutable: true,
      match: VERSION_PATTERN,
    },
    disclaimerDocumentHash: {
      type: String,
      required: true,
      immutable: true,
      lowercase: true,
      match: SHA256_HEX_PATTERN,
      select: false,
    },
    termsAcceptedAt: {
      type: Date,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ALUMNI_HELP_REQUEST_STATUSES,
      required: true,
      default: "requested",
    },
    hasBeenAccepted: { type: Boolean, required: true, default: false },
    activeUniqueness: { type: Boolean, required: true, default: true },
    acceptedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    lifecycleTimeline: {
      type: [lifecycleEventSchema],
      required: true,
      default: [],
    },
    latestOutcomeSubmissionId: {
      type: Schema.Types.ObjectId,
      ref: "AlumniHelpOutcomeSubmission",
      default: null,
    },
    latestOutcomeRevisionNumber: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: (value: unknown) =>
          value == null || Number.isSafeInteger(value),
      },
    },
    latestOutcomeStatus: {
      type: String,
      enum: ALUMNI_HELP_OUTCOME_STATUSES,
      default: null,
    },
    latestOutcomeDueAt: { type: Date, default: null },
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
    collection: ALUMNI_HELP_REQUEST_COLLECTION,
    timestamps: true,
    strict: "throw",
    minimize: false,
    versionKey: false,
  },
);

alumniHelpRequestSchema.pre("validate", function enforceRequestInvariants(next) {
  const isActive = isActiveAlumniHelpRequestStatus(this.status);
  this.activeUniqueness = isActive;

  if (
    this.requesterId instanceof mongoose.Types.ObjectId &&
    this.providerId instanceof mongoose.Types.ObjectId &&
    this.requesterId.equals(this.providerId)
  ) {
    this.invalidate("providerId", "Requester and provider must be different users.");
  }

  const acceptedState = ["accepted", "in_progress", "completed", "closed"].includes(
    this.status,
  );
  if (this.hasBeenAccepted !== acceptedState) {
    this.invalidate(
      "hasBeenAccepted",
      "hasBeenAccepted must match the accepted request lifecycle.",
    );
  }
  if (acceptedState && (!this.acceptedAt || !this.agreedHelpType)) {
    this.invalidate(
      "acceptedAt",
      "Accepted requests require acceptedAt and agreedHelpType.",
    );
  }
  if (acceptedState && !this.conversationId) {
    this.invalidate(
      "conversationId",
      "Accepted requests require an Alumni Help Room.",
    );
  }
  if (!acceptedState && (this.acceptedAt || this.agreedHelpType || this.conversationId)) {
    this.invalidate(
      "acceptedAt",
      "A request cannot contain accepted-state metadata before acceptance.",
    );
  }
  if (this.status === "alternative_proposed" && !this.proposedHelpType) {
    this.invalidate(
      "proposedHelpType",
      "An alternative proposal requires proposedHelpType.",
    );
  }
  if (
    this.proposedHelpType &&
    this.proposedHelpType === this.requestedHelpType
  ) {
    this.invalidate(
      "proposedHelpType",
      "An alternative help type must differ from the requested help type.",
    );
  }
  if (
    this.agreedHelpType &&
    this.agreedHelpType !== this.requestedHelpType &&
    this.agreedHelpType !== this.proposedHelpType
  ) {
    this.invalidate(
      "agreedHelpType",
      "Agreed help type must match the requested or proposed help type.",
    );
  }

  if ((this.status === "declined") !== Boolean(this.declinedAt)) {
    this.invalidate("declinedAt", "Declined state and declinedAt must match.");
  }
  if ((this.status === "withdrawn") !== Boolean(this.withdrawnAt)) {
    this.invalidate("withdrawnAt", "Withdrawn state and withdrawnAt must match.");
  }
  if ((this.status === "closed") !== Boolean(this.closedAt)) {
    this.invalidate("closedAt", "Closed state and closedAt must match.");
  }
  if (this.startedAt && !["in_progress", "completed", "closed"].includes(this.status)) {
    this.invalidate("startedAt", "startedAt is not valid in this request state.");
  }
  if (this.completedAt && !["completed", "closed"].includes(this.status)) {
    this.invalidate("completedAt", "completedAt is not valid in this request state.");
  }

  const outcomeFields = [
    this.latestOutcomeSubmissionId,
    this.latestOutcomeRevisionNumber,
    this.latestOutcomeStatus,
    this.latestOutcomeDueAt,
  ];
  const outcomeFieldsSet = outcomeFields.filter((value) => value != null).length;
  if (outcomeFieldsSet !== 0 && outcomeFieldsSet !== outcomeFields.length) {
    this.invalidate(
      "latestOutcomeSubmissionId",
      "Latest outcome summary fields must be set together.",
    );
  }
  if (outcomeFieldsSet > 0 && !this.hasBeenAccepted) {
    this.invalidate(
      "latestOutcomeSubmissionId",
      "Only accepted requests may contain outcomes.",
    );
  }

  for (let index = 0; index < this.lifecycleTimeline.length; index += 1) {
    const event = this.lifecycleTimeline[index];
    if (event.sequence !== index + 1) {
      this.invalidate(
        "lifecycleTimeline",
        "Lifecycle event sequences must be contiguous and start at one.",
      );
      break;
    }
    const expectedActorId =
      event.actorRole === "requester" ? this.requesterId : this.providerId;
    if (
      !(event.actorId instanceof mongoose.Types.ObjectId) ||
      !(expectedActorId instanceof mongoose.Types.ObjectId) ||
      !event.actorId.equals(expectedActorId)
    ) {
      this.invalidate(
        "lifecycleTimeline",
        "Lifecycle event actor must match its participant role.",
      );
      break;
    }
    if (index > 0) {
      const previousEvent = this.lifecycleTimeline[index - 1];
      const transition =
        event.action === "create"
          ? null
          : ALUMNI_HELP_TRANSITIONS[event.action];
      if (
        !transition ||
        event.fromStatus !== previousEvent.toStatus ||
        event.fromStatus == null ||
        !(transition.from as readonly AlumniHelpRequestStatus[]).includes(
          event.fromStatus,
        ) ||
        transition.to !== event.toStatus ||
        (transition.actor !== "either" && transition.actor !== event.actorRole) ||
        event.occurredAt < previousEvent.occurredAt
      ) {
        this.invalidate(
          "lifecycleTimeline",
          "Lifecycle timeline contains an invalid transition.",
        );
        break;
      }
    }
  }
  const lastEvent = this.lifecycleTimeline[this.lifecycleTimeline.length - 1];
  if (!lastEvent || lastEvent.toStatus !== this.status) {
    this.invalidate(
      "lifecycleTimeline",
      "Lifecycle timeline must end in the current request status.",
    );
  }
  const firstEvent = this.lifecycleTimeline[0];
  if (
    firstEvent &&
    (firstEvent.action !== "create" ||
      firstEvent.fromStatus != null ||
      firstEvent.toStatus !== "requested" ||
      firstEvent.actorRole !== "requester" ||
      (!(firstEvent.actorId instanceof mongoose.Types.ObjectId) ||
        !(this.requesterId instanceof mongoose.Types.ObjectId) ||
        !firstEvent.actorId.equals(this.requesterId)))
  ) {
    this.invalidate(
      "lifecycleTimeline",
      "Lifecycle timeline must begin with requester creation.",
    );
  }

  let expectedPurgeAt: Date | null = null;
  if (this.status === "declined" && this.declinedAt) {
    expectedPurgeAt = neverAcceptedHelpRequestPurgeAt(this.declinedAt);
  } else if (this.status === "withdrawn" && this.withdrawnAt) {
    expectedPurgeAt = neverAcceptedHelpRequestPurgeAt(this.withdrawnAt);
  } else if (this.status === "closed" && this.closedAt) {
    expectedPurgeAt = acceptedHelpRequestPurgeAt(
      this.closedAt,
      this.latestOutcomeDueAt,
    );
  }
  if (
    (expectedPurgeAt === null && this.purgeAt != null) ||
    (expectedPurgeAt !== null && !datesEqual(this.purgeAt, expectedPurgeAt))
  ) {
    this.invalidate(
      "purgeAt",
      "Help Request purgeAt must match its approved retention clock.",
    );
  }

  next();
});

alumniHelpRequestSchema.index(
  { requesterId: 1, alumniProfileId: 1, requestedHelpType: 1 },
  {
    unique: true,
    name: "uniq_alumni_help_request_active_identity",
    partialFilterExpression: { activeUniqueness: true },
  },
);
alumniHelpRequestSchema.index(
  { requesterId: 1, updatedAt: -1, _id: -1 },
  { name: "idx_alumni_help_request_requester_list" },
);
alumniHelpRequestSchema.index(
  { providerId: 1, updatedAt: -1, _id: -1 },
  { name: "idx_alumni_help_request_provider_list" },
);
alumniHelpRequestSchema.index(
  { requesterId: 1, status: 1, latestOutcomeStatus: 1, _id: 1 },
  { name: "idx_alumni_help_request_requester_actions" },
);
alumniHelpRequestSchema.index(
  { providerId: 1, status: 1, latestOutcomeStatus: 1, _id: 1 },
  { name: "idx_alumni_help_request_provider_actions" },
);
alumniHelpRequestSchema.index(
  { conversationId: 1 },
  {
    unique: true,
    name: "uniq_alumni_help_request_conversation",
    partialFilterExpression: { conversationId: { $type: "objectId" } },
  },
);
alumniHelpRequestSchema.index(
  { alumniProfileId: 1, status: 1, updatedAt: -1 },
  { name: "idx_alumni_help_request_profile_status" },
);
alumniHelpRequestSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: "ttl_alumni_help_request_purge_at" },
);

function removeInternalRequestFields(
  _document: unknown,
  value: IAlumniHelpRequest & { _id?: unknown; __v?: number },
) {
  const mutable = value as unknown as Record<string, unknown>;
  if (mutable._id) mutable.id = mutable._id;
  delete mutable._id;
  delete mutable.consentDocumentHash;
  delete mutable.disclaimerDocumentHash;
  delete mutable.activeUniqueness;
  delete mutable.purgeAt;
  delete mutable.__v;
  return mutable;
}

alumniHelpRequestSchema.set("toJSON", { transform: removeInternalRequestFields });
alumniHelpRequestSchema.set("toObject", { transform: removeInternalRequestFields });

const AlumniHelpRequest: Model<IAlumniHelpRequest> =
  (mongoose.models.AlumniHelpRequest as Model<IAlumniHelpRequest> | undefined) ||
  mongoose.model<IAlumniHelpRequest>(
    "AlumniHelpRequest",
    alumniHelpRequestSchema,
  );

export default AlumniHelpRequest;
