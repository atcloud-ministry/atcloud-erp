import { createHash } from "node:crypto";
import type { Connection } from "mongoose";
import mongoose from "mongoose";
import { addUtcCalendarMonths } from "../../contracts/alumniDirectoryData";
import {
  ALUMNI_HELP_REQUEST_STATUSES,
  ALUMNI_HELP_TRANSITIONS,
  acceptedHelpRequestPurgeAt,
  helpOutcomeDueAt,
  isAlumniHelpOutcomeCodeForType,
  isAlumniHelpType,
  neverAcceptedHelpRequestPurgeAt,
} from "../../contracts/alumniHelpFlow";
import {
  chatMessagePurgeAt,
  conversationPurgeAt,
  isValidChatMessagePayload,
} from "../../contracts/chatRooms";
import { MIGRATION_REGISTRY } from "../../migrations/registry";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import AlumniHelpOutcomeSubmission from "../../models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest from "../../models/AlumniHelpRequest";
import AlumniImportBatch from "../../models/AlumniImportBatch";
import AlumniInvitation from "../../models/AlumniInvitation";
import AlumniProfile from "../../models/AlumniProfile";
import AuditLog from "../../models/AuditLog";
import ChatMessage from "../../models/ChatMessage";
import ConsentRecord from "../../models/ConsentRecord";
import Conversation from "../../models/Conversation";
import ConversationMember from "../../models/ConversationMember";
import IdempotencyRecord from "../../models/IdempotencyRecord";
import NotificationOutbox from "../../models/NotificationOutbox";
import Program from "../../models/Program";
import ProgramCommunitySettings from "../../models/ProgramCommunitySettings";
import Purchase from "../../models/Purchase";
import SchemaMigration from "../../models/SchemaMigration";
import User from "../../models/User";
import {
  MigrationRunner,
  type MigrationStatusResult,
} from "../migrations/MigrationRunner";
import {
  MongoTransactionService,
  type MongoTransactionTopologyCapability,
} from "../reliability/MongoTransactionService";

const REPORT_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_COLLECTIONS = 32;
const MAX_MANIFEST_ISSUES = 100;

type PlainRecord = Readonly<Record<string, unknown>>;

interface RestoreIndexModel {
  readonly collection: { readonly name: string };
  readonly schema: {
    indexes(): Array<[Record<string, unknown>, Record<string, unknown>]>;
  };
}

interface RestoreCollectionDefinition {
  readonly key: string;
  readonly collectionName: string;
  readonly model: RestoreIndexModel;
  readonly projection: Readonly<Record<string, 0 | 1>>;
}

export interface RestoreTtlDefinition {
  readonly collectionName: string;
  readonly field: string;
}

const RESTORE_COLLECTIONS: readonly RestoreCollectionDefinition[] = Object.freeze([
  {
    key: "users",
    collectionName: User.collection.name,
    model: User as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, isActive: 1, isVerified: 1, createdAt: 1, updatedAt: 1 }),
  },
  {
    key: "programs",
    collectionName: Program.collection.name,
    model: Program as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, mentors: 1, adminEnrollments: 1, programRoles: 1, createdAt: 1, updatedAt: 1 }),
  },
  {
    key: "purchases",
    collectionName: Purchase.collection.name,
    model: Purchase as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, userId: 1, programId: 1, purchaseType: 1, status: 1, studentRoleId: 1, purchaseDate: 1 }),
  },
  {
    key: "alumni_profiles",
    collectionName: AlumniProfile.collection.name,
    model: AlumniProfile as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, userId: 1, publishStatus: 1, currentPublicationConsentId: 1, publishedAt: 1, withdrawnAt: 1, accountDeletionApprovedAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "alumni_affiliations",
    collectionName: AlumniAffiliation.collection.name,
    model: AlumniAffiliation as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, alumniProfileId: 1, programId: 1, programName: 1, affiliationKey: 1, verificationStatus: 1, accountDeletionApprovedAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "alumni_invitations",
    collectionName: AlumniInvitation.collection.name,
    model: AlumniInvitation as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, status: 1, affiliations: 1, lastInvitedAt: 1, contactPurgeAt: 1, contactPurgedAt: 1, revision: 1 }),
  },
  {
    key: "alumni_import_batches",
    collectionName: AlumniImportBatch.collection.name,
    model: AlumniImportBatch as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, schemaVersion: 1, checksum: 1, status: 1, counts: 1, terminalAt: 1, rawDataPurgeAt: 1, rawDataPurgedAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "consent_records",
    collectionName: ConsentRecord.collection.name,
    model: ConsentRecord as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, subjectUserId: 1, alumniProfileId: 1, purpose: 1, status: 1, acceptedAt: 1, withdrawnAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "alumni_help_requests",
    collectionName: AlumniHelpRequest.collection.name,
    model: AlumniHelpRequest as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, requesterId: 1, providerId: 1, alumniProfileId: 1, requestedHelpType: 1, proposedHelpType: 1, agreedHelpType: 1, status: 1, hasBeenAccepted: 1, acceptedAt: 1, declinedAt: 1, withdrawnAt: 1, startedAt: 1, completedAt: 1, closedAt: 1, conversationId: 1, "lifecycleTimeline.sequence": 1, "lifecycleTimeline.action": 1, "lifecycleTimeline.fromStatus": 1, "lifecycleTimeline.toStatus": 1, "lifecycleTimeline.actorRole": 1, "lifecycleTimeline.actorId": 1, "lifecycleTimeline.helpType": 1, "lifecycleTimeline.occurredAt": 1, latestOutcomeSubmissionId: 1, latestOutcomeRevisionNumber: 1, latestOutcomeStatus: 1, latestOutcomeDueAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "alumni_help_outcome_submissions",
    collectionName: AlumniHelpOutcomeSubmission.collection.name,
    model: AlumniHelpOutcomeSubmission as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, helpRequestId: 1, revisionNumber: 1, previousSubmissionId: 1, submittedBy: 1, agreedHelpType: 1, outcomeCode: 1, status: 1, submittedAt: 1, dueAt: 1, decidedAt: 1, decidedBy: 1, confirmationMethod: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "conversations",
    collectionName: Conversation.collection.name,
    model: Conversation as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, kind: 1, status: 1, helpRequestId: 1, programId: 1, lastSequence: 1, lastMessageId: 1, latestMessagePurgeAt: 1, writeAccessEndsAt: 1, archivedAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "conversation_members",
    collectionName: ConversationMember.collection.name,
    model: ConversationMember as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, conversationId: 1, userId: 1, role: 1, status: 1, joinedAt: 1, accessWindows: 1, lastReadSequence: 1, unreadCount: 1, unreadReconciledThroughSequence: 1, unreadReconciledAt: 1, muted: 1, mutedAt: 1, purgeAt: 1, revision: 1 }),
  },
  {
    key: "chat_messages",
    collectionName: ChatMessage.collection.name,
    model: ChatMessage as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, conversationId: 1, sequence: 1, senderId: 1, clientMessageId: 1, kind: 1, createdAt: 1, purgeAt: 1 }),
  },
  {
    key: "program_community_settings",
    collectionName: ProgramCommunitySettings.collection.name,
    model: ProgramCommunitySettings as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, programId: 1, enabled: 1, opensAt: 1, closesAt: 1, archivedAt: 1, studentRoleMappings: 1, membershipFenceRevision: 1, membershipProjectionRevision: 1, membershipProjectionState: 1, revision: 1 }),
  },
  {
    key: "notification_outboxes",
    collectionName: NotificationOutbox.collection.name,
    model: NotificationOutbox as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, eventId: 1, topic: 1, dedupeKeyHash: 1, payloadVersion: 1, payloadHash: 1, status: 1, attemptCount: 1, maxAttempts: 1, nextAttemptAt: 1, leaseExpiresAt: 1, deliveredAt: 1, deadAt: 1, purgeAt: 1, lastErrorCode: 1, revision: 1 }),
  },
  {
    key: "idempotency_records",
    collectionName: IdempotencyRecord.collection.name,
    model: IdempotencyRecord as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, scope: 1, actorKey: 1, key: 1, requestHash: 1, state: 1, responseStatus: 1, createdAt: 1, completedAt: 1, purgeAt: 1 }),
  },
  {
    key: "audit_logs",
    collectionName: AuditLog.collection.name,
    model: AuditLog as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, action: 1, version: 1, actorType: 1, source: 1, outcome: 1, reasonCode: 1, targetModel: 1, createdAt: 1 }),
  },
  {
    key: "schema_migrations",
    collectionName: SchemaMigration.collection.name,
    model: SchemaMigration as unknown as RestoreIndexModel,
    projection: Object.freeze({ _id: 1, migrationId: 1, checksum: 1, status: 1, direction: 1, attempt: 1, appliedAt: 1, rolledBackAt: 1, revision: 1 }),
  },
]);

/**
 * TTL indexes within the restore qualification scope.  Their field names are
 * derived from the schema so an `expiresAt` index cannot accidentally be
 * checked as though it were a `purgeAt` index.
 */
export const RESTORE_TTL_DEFINITIONS: readonly RestoreTtlDefinition[] =
  Object.freeze(
    RESTORE_COLLECTIONS.flatMap((definition) =>
      definition.model.schema.indexes().flatMap(([key, options]) => {
        if (options.expireAfterSeconds !== 0) return [];
        const fields = Object.keys(key);
        return fields.length === 1
          ? [
              Object.freeze({
                collectionName: definition.collectionName,
                field: fields[0]!,
              }),
            ]
          : [];
      }),
    ),
  );

export interface RestoreCollectionFingerprint {
  readonly count: number;
  readonly digest: string;
}

export interface RestoreQualificationIssue {
  readonly code:
    | "RESTORE_MIGRATION_NOT_READY"
    | "RESTORE_TRANSACTION_TOPOLOGY_UNSUPPORTED"
    | "RESTORE_INDEX_MISSING"
    | "RESTORE_INDEX_MISMATCH"
    | "RESTORE_MANIFEST_MISMATCH"
    | "RESTORE_CHAT_INTEGRITY_INVALID"
    | "RESTORE_HELP_INTEGRITY_INVALID"
    | "RESTORE_MEMBERSHIP_INTEGRITY_INVALID"
    | "RESTORE_RETENTION_CLEANUP_REQUIRED"
    | "RESTORE_ACCOUNT_DELETION_RECONCILIATION_REQUIRED";
  readonly count: number;
}

export interface RestoreQualificationManifest {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly kind: "restore_qualification";
  readonly generatedAt: string;
  readonly collections: Readonly<Record<string, RestoreCollectionFingerprint>>;
}

export interface RestoreQualificationReport extends RestoreQualificationManifest {
  readonly status: "passed" | "failed";
  readonly migration: {
    readonly healthy: boolean;
    readonly recoveryRequired: boolean;
    readonly applied: number;
    readonly pending: number;
    readonly issues: number;
  };
  readonly transaction: {
    readonly supported: boolean;
    readonly topology: MongoTransactionTopologyCapability["topology"];
  };
  readonly indexes: {
    readonly expected: number;
    readonly missing: number;
    readonly mismatched: number;
  };
  readonly integrity: {
    readonly chat: {
      readonly orphanMessages: number;
      readonly messagesBeyondConversationSequence: number;
      readonly orphanMembers: number;
      readonly invalidAccessWindows: number;
      readonly invalidConversationMetadata: number;
      readonly invalidMessageRetention: number;
      readonly invalidMemberState: number;
      readonly messagesOutsideMemberAccess: number;
      readonly invalidMessagePayload: number;
    };
    readonly help: {
      readonly orphanOutcomes: number;
      readonly inconsistentLatestOutcomes: number;
      readonly invalidOutcomeAncestry: number;
      readonly invalidLifecycleTimelines: number;
      readonly invalidRoomLinkage: number;
    };
    readonly membership: {
      readonly settingsMissingProgram: number;
      readonly enabledSettingsMissingRoom: number;
      readonly reconciliationRequired: number;
      readonly roomsMissingProgram: number;
    };
    readonly retention: {
      readonly expiredRawImportData: number;
      readonly expiredInvitationContacts: number;
      readonly expiredTtlRecords: number;
      readonly expiredAuditLogs: number;
    };
    readonly accountDeletion: {
      readonly unscheduledProfiles: number;
      readonly unscheduledAffiliations: number;
      readonly unscheduledConsents: number;
    };
  };
  readonly comparison: {
    readonly manifestProvided: boolean;
    readonly mismatchedCollections: number;
  };
  readonly issues: readonly RestoreQualificationIssue[];
}

export interface RestoreQualificationDependencies {
  readonly now?: () => Date;
  readonly migrationStatus?: () => Promise<MigrationStatusResult>;
  readonly transactionCapability?: () => Promise<MongoTransactionTopologyCapability>;
}

function asRecord(value: unknown): PlainRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PlainRecord)
    : null;
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function objectIdText(value: unknown): string | null {
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (
    value &&
    typeof value === "object" &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  ) {
    const text = value.toHexString();
    return typeof text === "string" && /^[a-f0-9]{24}$/i.test(text)
      ? text.toLowerCase()
      : null;
  }
  return null;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (isDate(value)) return value.toISOString();
  const objectId = objectIdText(value);
  if (objectId) return objectId;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = asRecord(value);
  if (!record) return null;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    normalized[key] = canonicalValue(record[key]);
  }
  return normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function expectedIndexName(
  key: Readonly<Record<string, unknown>>,
  options: Readonly<Record<string, unknown>>,
): string {
  if (typeof options.name === "string" && options.name.length > 0) {
    return options.name;
  }
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join("_");
}

function indexSignature(value: Readonly<Record<string, unknown>>): string {
  const key = asRecord(value.key);
  const schemaTextFields = key
    ? Object.entries(key).filter(([, direction]) => direction === "text")
    : [];
  const nativeTextIndex = key?._fts === "text" && key._ftsx === 1;
  if (schemaTextFields.length > 0 || nativeTextIndex) {
    const weights = asRecord(value.weights) ?? Object.fromEntries(
      schemaTextFields.map(([field]) => [field, 1]),
    );
    return stableJson({
      kind: "text",
      weights,
      default_language:
        typeof value.default_language === "string"
          ? value.default_language
          : "english",
      language_override:
        typeof value.language_override === "string"
          ? value.language_override
          : "language",
      unique: value.unique === true,
      sparse: value.sparse === true,
      partialFilterExpression: value.partialFilterExpression ?? null,
      collation: value.collation ?? null,
    });
  }
  return stableJson({
    key,
    unique: value.unique === true,
    sparse: value.sparse === true,
    expireAfterSeconds:
      typeof value.expireAfterSeconds === "number"
        ? value.expireAfterSeconds
        : null,
    partialFilterExpression: value.partialFilterExpression ?? null,
    collation: value.collation ?? null,
  });
}

function accessWindowIsValid(value: unknown): boolean {
  const window = asRecord(value);
  if (!window) return false;
  const from = window.visibleFromSequence;
  const through = window.visibleThroughSequence;
  const openedAt = window.openedAt;
  const closedAt = window.closedAt;
  if (!Number.isSafeInteger(from) || Number(from) < 1 || !isDate(openedAt)) {
    return false;
  }
  if (through === null || through === undefined) return closedAt === null || closedAt === undefined;
  return (
    Number.isSafeInteger(through) &&
    Number(through) >= Number(from) - 1 &&
    isDate(closedAt) &&
    closedAt.getTime() >= openedAt.getTime()
  );
}

function openWindowCount(windows: readonly unknown[]): number {
  return windows.filter((value) => {
    const window = asRecord(value);
    return window?.visibleThroughSequence === null || window?.visibleThroughSequence === undefined;
  }).length;
}

function accessWindowsAreOrdered(windows: readonly unknown[]): boolean {
  let previous: PlainRecord | undefined;
  for (const value of windows) {
    const window = asRecord(value);
    if (!window) return false;
    if (previous) {
      const previousThrough = previous.visibleThroughSequence;
      const previousClosedAt = previous.closedAt;
      const currentFrom = window.visibleFromSequence;
      const currentOpenedAt = window.openedAt;
      if (
        !Number.isSafeInteger(previousThrough) ||
        !isDate(previousClosedAt) ||
        !Number.isSafeInteger(currentFrom) ||
        !isDate(currentOpenedAt) ||
        Number(currentFrom) <= Number(previousThrough) ||
        currentOpenedAt.getTime() < previousClosedAt.getTime()
      ) {
        return false;
      }
    }
    previous = window;
  }
  return true;
}

function sameInstant(left: unknown, right: unknown): boolean {
  return isDate(left) && isDate(right) && left.getTime() === right.getTime();
}

function isNonNegativeIntegerAtMost(value: unknown, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum
  );
}

function conversationMetadataIsValid(record: PlainRecord): boolean {
  const kind = record.kind;
  const status = record.status;
  const helpRequestId = record.helpRequestId;
  const programId = record.programId;
  const lastSequence = record.lastSequence;
  if (!Number.isSafeInteger(lastSequence) || Number(lastSequence) < 0) {
    return false;
  }
  if (
    (kind === "alumni_help" &&
      (objectIdText(helpRequestId) === null || programId != null)) ||
    (kind === "program" &&
      (objectIdText(programId) === null || helpRequestId != null)) ||
    (kind !== "alumni_help" && kind !== "program")
  ) {
    return false;
  }
  const messageSummaryValid =
    Number(lastSequence) === 0
      ? record.lastMessageId == null && record.latestMessagePurgeAt == null
      : objectIdText(record.lastMessageId) !== null &&
        isDate(record.latestMessagePurgeAt);
  if (!messageSummaryValid) return false;
  if (
    (kind !== "alumni_help" && record.writeAccessEndsAt != null) ||
    (record.writeAccessEndsAt != null && !isDate(record.writeAccessEndsAt))
  ) {
    return false;
  }
  if (status === "current") {
    return record.archivedAt == null && record.purgeAt == null;
  }
  return (
    status === "archived" &&
    isDate(record.archivedAt) &&
    isDate(record.purgeAt) &&
    sameInstant(
      record.purgeAt,
      conversationPurgeAt(record.archivedAt, record.latestMessagePurgeAt as Date | null),
    )
  );
}

function accessWindowsFitConversation(
  windows: readonly unknown[],
  lastSequence: number,
): boolean {
  return windows.every((value) => {
    const window = asRecord(value);
    if (!window || !Number.isSafeInteger(window.visibleFromSequence)) {
      return false;
    }
    if (Number(window.visibleFromSequence) > lastSequence + 1) return false;
    return (
      window.visibleThroughSequence == null ||
      (Number.isSafeInteger(window.visibleThroughSequence) &&
        Number(window.visibleThroughSequence) <= lastSequence)
    );
  });
}

function conversationMemberStateIsValid(
  record: PlainRecord,
  lastSequence: number,
): boolean {
  const windows = Array.isArray(record.accessWindows) ? record.accessWindows : [];
  const openWindows = openWindowCount(windows);
  const statusValid =
    (record.status === "active" && openWindows === 1) ||
    (record.status === "history_only" && openWindows === 0);
  if (
    !statusValid ||
    windows.length === 0 ||
    !windows.every(accessWindowIsValid) ||
    !accessWindowsAreOrdered(windows) ||
    !accessWindowsFitConversation(windows, lastSequence) ||
    !isNonNegativeIntegerAtMost(record.lastReadSequence, lastSequence) ||
    !isNonNegativeIntegerAtMost(
      record.unreadReconciledThroughSequence,
      lastSequence,
    ) ||
    !Number.isSafeInteger(record.unreadCount) ||
    Number(record.unreadCount) < 0 ||
    objectIdText(record.userId) === null
  ) {
    return false;
  }
  if (record.status === "history_only" && record.unreadCount !== 0) {
    return false;
  }
  return record.muted === Boolean(record.mutedAt);
}

function messagePayloadIsValid(record: PlainRecord): boolean {
  const content = record.content;
  const safeLinkRecord = asRecord(record.safeLink);
  if (
    (content != null && typeof content !== "string") ||
    (record.safeLink != null &&
      (!safeLinkRecord ||
        typeof safeLinkRecord.url !== "string" ||
        typeof safeLinkRecord.label !== "string"))
  ) {
    return false;
  }
  return isValidChatMessagePayload({
    content: typeof content === "string" ? content : null,
    safeLink:
      safeLinkRecord &&
      typeof safeLinkRecord.url === "string" &&
      typeof safeLinkRecord.label === "string"
        ? { url: safeLinkRecord.url, label: safeLinkRecord.label }
        : null,
  });
}

function helpRequestLifecycleIsValid(record: PlainRecord): boolean {
  const requesterId = objectIdText(record.requesterId);
  const providerId = objectIdText(record.providerId);
  const status = record.status;
  if (
    !requesterId ||
    !providerId ||
    requesterId === providerId ||
    typeof status !== "string" ||
    !(ALUMNI_HELP_REQUEST_STATUSES as readonly string[]).includes(status)
  ) {
    return false;
  }
  const timeline = Array.isArray(record.lifecycleTimeline)
    ? record.lifecycleTimeline
    : [];
  if (timeline.length === 0) return false;
  let previous: PlainRecord | undefined;
  for (const [index, value] of timeline.entries()) {
    const event = asRecord(value);
    if (
      !event ||
      event.sequence !== index + 1 ||
      typeof event.action !== "string" ||
      typeof event.toStatus !== "string" ||
      typeof event.actorRole !== "string" ||
      !isDate(event.occurredAt)
    ) {
      return false;
    }
    const actorId = objectIdText(event.actorId);
    const expectedActor =
      event.actorRole === "requester"
        ? requesterId
        : event.actorRole === "provider"
          ? providerId
          : null;
    if (
      event.actorRole === "system"
        ? event.actorId !== null
        : !actorId ||
          actorId !== expectedActor ||
          (event.actorRole !== "requester" && event.actorRole !== "provider")
    ) {
      return false;
    }
    if (index === 0) {
      if (
        event.action !== "create" ||
        event.fromStatus != null ||
        event.toStatus !== "requested" ||
        event.actorRole !== "requester"
      ) {
        return false;
      }
    } else {
      const transition = (ALUMNI_HELP_TRANSITIONS as Readonly<
        Record<
          string,
          {
            readonly from: readonly string[];
            readonly to: string;
            readonly actor: "requester" | "provider" | "system" | "either";
          }
        >
      >)[event.action];
      if (
        !previous ||
        !transition ||
        event.fromStatus !== previous.toStatus ||
        event.fromStatus == null ||
        !transition.from.includes(event.fromStatus as string) ||
        transition.to !== event.toStatus ||
        (transition.actor !== "either" && transition.actor !== event.actorRole) ||
        event.occurredAt.getTime() < (previous.occurredAt as Date).getTime()
      ) {
        return false;
      }
    }
    previous = event;
  }
  return previous?.toStatus === status;
}

function helpRequestStateIsValid(record: PlainRecord): boolean {
  const status = record.status;
  const acceptedState =
    status === "accepted" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "closed";
  const acceptedMetadataValid = acceptedState
    ? isDate(record.acceptedAt) &&
      isAlumniHelpType(record.agreedHelpType) &&
      objectIdText(record.conversationId) !== null
    : record.acceptedAt == null &&
      record.agreedHelpType == null &&
      record.conversationId == null;
  if (record.hasBeenAccepted !== acceptedState || !acceptedMetadataValid) {
    return false;
  }
  if (
    (status === "declined") !== isDate(record.declinedAt) ||
    (status === "withdrawn") !== isDate(record.withdrawnAt) ||
    (status === "closed") !== isDate(record.closedAt) ||
    (record.startedAt != null &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "closed") ||
    (record.completedAt != null && status !== "completed" && status !== "closed")
  ) {
    return false;
  }
  const outcomeSummary = [
    record.latestOutcomeSubmissionId,
    record.latestOutcomeRevisionNumber,
    record.latestOutcomeStatus,
    record.latestOutcomeDueAt,
  ];
  const summaryFields = outcomeSummary.filter((value) => value != null).length;
  if (
    (summaryFields !== 0 && summaryFields !== outcomeSummary.length) ||
    (summaryFields > 0 && !acceptedState)
  ) {
    return false;
  }
  let expectedPurgeAt: Date | null = null;
  if (status === "declined" && isDate(record.declinedAt)) {
    expectedPurgeAt = neverAcceptedHelpRequestPurgeAt(record.declinedAt);
  } else if (status === "withdrawn" && isDate(record.withdrawnAt)) {
    expectedPurgeAt = neverAcceptedHelpRequestPurgeAt(record.withdrawnAt);
  } else if (status === "closed" && isDate(record.closedAt)) {
    expectedPurgeAt = acceptedHelpRequestPurgeAt(
      record.closedAt,
      isDate(record.latestOutcomeDueAt) ? record.latestOutcomeDueAt : null,
    );
  }
  return (
    (expectedPurgeAt === null && record.purgeAt == null) ||
    (expectedPurgeAt !== null && sameInstant(record.purgeAt, expectedPurgeAt))
  );
}

function helpOutcomeStateIsValid(
  record: PlainRecord,
  request: PlainRecord,
): boolean {
  const submittedAt = record.submittedAt;
  const status = record.status;
  const agreedHelpType = record.agreedHelpType;
  const requesterId = objectIdText(request.requesterId);
  if (
    !Number.isSafeInteger(record.revisionNumber) ||
    Number(record.revisionNumber) < 1 ||
    !requesterId ||
    objectIdText(record.submittedBy) !== requesterId ||
    !isDate(submittedAt) ||
    !sameInstant(record.dueAt, helpOutcomeDueAt(submittedAt)) ||
    !isAlumniHelpType(agreedHelpType) ||
    agreedHelpType !== request.agreedHelpType ||
    !isAlumniHelpOutcomeCodeForType(agreedHelpType, record.outcomeCode)
  ) {
    return false;
  }
  if (status === "pending") {
    if (
      record.decidedAt != null ||
      record.decidedBy != null ||
      record.confirmationMethod != null
    ) {
      return false;
    }
  } else if (status === "confirmed") {
    if (
      !isDate(record.decidedAt) ||
      (record.confirmationMethod !== "provider" &&
        record.confirmationMethod !== "automatic_20_day") ||
      (record.confirmationMethod === "provider" &&
        objectIdText(record.decidedBy) === null) ||
      (record.confirmationMethod === "automatic_20_day" &&
        record.decidedBy != null)
    ) {
      return false;
    }
  } else if (
    status !== "denied" ||
    !isDate(record.decidedAt) ||
    objectIdText(record.decidedBy) === null ||
    record.confirmationMethod != null
  ) {
    return false;
  }
  return (
    (record.purgeAt == null && request.purgeAt == null) ||
    sameInstant(record.purgeAt, request.purgeAt)
  );
}

function addIssue(
  issues: RestoreQualificationIssue[],
  code: RestoreQualificationIssue["code"],
  count: number,
): void {
  if (count > 0 && issues.length < MAX_MANIFEST_ISSUES) {
    issues.push(Object.freeze({ code, count }));
  }
}

function validateManifest(value: unknown): RestoreQualificationManifest {
  const manifest = asRecord(value);
  if (
    !manifest ||
    manifest.schemaVersion !== REPORT_SCHEMA_VERSION ||
    manifest.kind !== "restore_qualification" ||
    typeof manifest.generatedAt !== "string" ||
    !isDate(new Date(manifest.generatedAt))
  ) {
    throw new RestoreQualificationInputError();
  }
  const collections = asRecord(manifest.collections);
  if (!collections || Object.keys(collections).length > MAX_MANIFEST_COLLECTIONS) {
    throw new RestoreQualificationInputError();
  }
  const normalized: Record<string, RestoreCollectionFingerprint> = {};
  for (const definition of RESTORE_COLLECTIONS) {
    const candidate = asRecord(collections[definition.key]);
    if (
      !candidate ||
      !Number.isSafeInteger(candidate.count) ||
      Number(candidate.count) < 0 ||
      typeof candidate.digest !== "string" ||
      !SHA256_PATTERN.test(candidate.digest)
    ) {
      throw new RestoreQualificationInputError();
    }
    normalized[definition.key] = Object.freeze({
      count: Number(candidate.count),
      digest: candidate.digest,
    });
  }
  return Object.freeze({
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "restore_qualification",
    generatedAt: manifest.generatedAt,
    collections: Object.freeze(normalized),
  });
}

export class RestoreQualificationInputError extends Error {
  readonly name = "RestoreQualificationInputError";
  readonly code = "RESTORE_QUALIFICATION_INPUT_INVALID";

  constructor() {
    super("The restore qualification manifest is invalid.");
  }
}

/**
 * Read-only integrity qualification for an isolated restored database. It
 * never initializes models, starts workers, or exposes source record data.
 */
export class RestoreQualificationService {
  private readonly now: () => Date;
  private readonly migrationStatus: () => Promise<MigrationStatusResult>;
  private readonly transactionCapability: () => Promise<MongoTransactionTopologyCapability>;

  constructor(
    private readonly connection: Connection,
    dependencies: RestoreQualificationDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.migrationStatus = dependencies.migrationStatus ?? (() =>
      new MigrationRunner({
        connection: this.connection,
        registry: MIGRATION_REGISTRY,
        operator: "restore-qualification",
        appVersion: "restore-qualification",
        leaseOwner: "restore-qualification",
      }).status());
    this.transactionCapability = dependencies.transactionCapability ?? (() =>
      new MongoTransactionService(this.connection).assertTopologyCapability(true));
  }

  async inspect(): Promise<RestoreQualificationReport> {
    return this.buildReport(undefined);
  }

  async verify(manifest: unknown): Promise<RestoreQualificationReport> {
    return this.buildReport(validateManifest(manifest));
  }

  private database() {
    const database = this.connection.db;
    if (!database) throw new Error("The restore database connection is unavailable.");
    return database;
  }

  private requireNow(): Date {
    const value = this.now();
    if (!isDate(value)) throw new Error("Restore qualification requires a valid clock.");
    return new Date(value);
  }

  private async readTransactionCapability(): Promise<MongoTransactionTopologyCapability> {
    try {
      return await this.transactionCapability();
    } catch {
      return Object.freeze({ supported: false, topology: "unknown" });
    }
  }

  private async fingerprint(
    definition: RestoreCollectionDefinition,
  ): Promise<RestoreCollectionFingerprint> {
    const hash = createHash("sha256");
    hash.update(`restore-qualification-v1:${definition.key}\n`);
    const cursor = this.database()
      .collection(definition.collectionName)
      .find({}, { projection: definition.projection })
      .sort({ _id: 1 });
    let count = 0;
    for await (const record of cursor) {
      hash.update(stableJson(record));
      hash.update("\n");
      count += 1;
    }
    return Object.freeze({ count, digest: hash.digest("hex") });
  }

  private async inspectIndexes(): Promise<{
    readonly expected: number;
    readonly missing: number;
    readonly mismatched: number;
  }> {
    let expected = 0;
    let missing = 0;
    let mismatched = 0;
    for (const definition of RESTORE_COLLECTIONS) {
      let actualIndexes: readonly PlainRecord[] = [];
      try {
        actualIndexes = await this.database()
          .collection(definition.collectionName)
          .listIndexes()
          .toArray() as readonly PlainRecord[];
      } catch {
        actualIndexes = [];
      }
      const actualByName = new Map(
        actualIndexes
          .filter((index) => typeof index.name === "string")
          .map((index) => [index.name as string, index]),
      );
      for (const [key, options] of definition.model.schema.indexes()) {
        expected += 1;
        const name = expectedIndexName(key, options);
        const actual = actualByName.get(name);
        if (!actual) {
          missing += 1;
          continue;
        }
        if (
          indexSignature({ key, ...options }) !== indexSignature(actual)
        ) {
          mismatched += 1;
        }
      }
    }
    return Object.freeze({ expected, missing, mismatched });
  }

  private async countDocuments(
    collectionName: string,
    filter: PlainRecord,
  ): Promise<number> {
    return this.database().collection(collectionName).countDocuments(filter);
  }

  private async chatIntegrity(
    now: Date,
  ): Promise<RestoreQualificationReport["integrity"]["chat"]> {
    const database = this.database();
    const conversationDocuments = await database
      .collection(Conversation.collection.name)
      .find(
        {},
        {
          projection: {
            _id: 1,
            kind: 1,
            status: 1,
            helpRequestId: 1,
            programId: 1,
            lastSequence: 1,
            lastMessageId: 1,
            latestMessagePurgeAt: 1,
            writeAccessEndsAt: 1,
            archivedAt: 1,
            purgeAt: 1,
          },
        },
      )
      .toArray();
    const conversationsById = new Map<string, PlainRecord>();
    let invalidConversationMetadata = 0;
    for (const document of conversationDocuments) {
      const record = document as PlainRecord;
      const id = objectIdText(record._id);
      if (!id || !conversationMetadataIsValid(record)) {
        invalidConversationMetadata += 1;
      }
      if (id) conversationsById.set(id, record);
    }

    const memberWindowsByConversation = new Map<
      string,
      Map<string, readonly unknown[]>
    >();
    let orphanMembers = 0;
    let invalidAccessWindows = 0;
    let invalidMemberState = 0;
    const memberCursor = database.collection(ConversationMember.collection.name).find(
      {},
      {
        projection: {
          conversationId: 1,
          userId: 1,
          role: 1,
          status: 1,
          accessWindows: 1,
          lastReadSequence: 1,
          unreadCount: 1,
          unreadReconciledThroughSequence: 1,
          muted: 1,
          mutedAt: 1,
        },
      },
    );
    for await (const document of memberCursor) {
      const record = asRecord(document);
      const conversationId = objectIdText(record?.conversationId);
      const userId = objectIdText(record?.userId);
      const conversation = conversationId
        ? conversationsById.get(conversationId)
        : undefined;
      if (!record || !conversationId || !conversation) {
        orphanMembers += 1;
        continue;
      }
      const windows = Array.isArray(record.accessWindows)
        ? record.accessWindows
        : [];
      const accessWindowsValid =
        windows.length > 0 &&
        windows.every(accessWindowIsValid) &&
        accessWindowsAreOrdered(windows);
      if (!accessWindowsValid) invalidAccessWindows += 1;
      const lastSequence = Number.isSafeInteger(conversation.lastSequence)
        ? Number(conversation.lastSequence)
        : -1;
      if (
        lastSequence < 0 ||
        !conversationMemberStateIsValid(record, lastSequence)
      ) {
        invalidMemberState += 1;
      }
      if (userId && accessWindowsValid) {
        let users = memberWindowsByConversation.get(conversationId);
        if (!users) {
          users = new Map();
          memberWindowsByConversation.set(conversationId, users);
        }
        users.set(userId, windows);
      }
    }

    const latestRetainedMessageByConversation = new Map<
      string,
      PlainRecord
    >();
    let orphanMessages = 0;
    let messagesBeyondConversationSequence = 0;
    let invalidMessageRetention = 0;
    let messagesOutsideMemberAccess = 0;
    let invalidMessagePayload = 0;
    const messageCursor = database.collection(ChatMessage.collection.name).find(
      {},
      {
        projection: {
          _id: 1,
          conversationId: 1,
          sequence: 1,
          senderId: 1,
          content: 1,
          safeLink: 1,
          createdAt: 1,
          purgeAt: 1,
        },
      },
    );
    for await (const document of messageCursor) {
      const record = asRecord(document);
      const conversationId = objectIdText(record?.conversationId);
      const conversation = conversationId
        ? conversationsById.get(conversationId)
        : undefined;
      if (!record || !conversationId || !conversation) {
        orphanMessages += 1;
        continue;
      }
      const sequence = record.sequence;
      const lastSequence = conversation.lastSequence;
      if (
        !Number.isSafeInteger(sequence) ||
        Number(sequence) < 1 ||
        !Number.isSafeInteger(lastSequence) ||
        Number(sequence) > Number(lastSequence)
      ) {
        messagesBeyondConversationSequence += 1;
      }
      if (
        !isDate(record.createdAt) ||
        !sameInstant(record.purgeAt, chatMessagePurgeAt(record.createdAt))
      ) {
        invalidMessageRetention += 1;
      }
      if (!messagePayloadIsValid(record)) invalidMessagePayload += 1;
      const senderId = objectIdText(record.senderId);
      const windows = senderId
        ? memberWindowsByConversation.get(conversationId)?.get(senderId)
        : undefined;
      const senderCanSeeSequence =
        Number.isSafeInteger(sequence) &&
        windows?.some((window) => {
          const candidate = asRecord(window);
          if (!candidate || !accessWindowIsValid(candidate)) return false;
          const from = Number(candidate.visibleFromSequence);
          const through = candidate.visibleThroughSequence;
          return (
            Number(sequence) >= from &&
            (through == null || Number(sequence) <= Number(through))
          );
        });
      if (!senderCanSeeSequence) messagesOutsideMemberAccess += 1;
      const existing = latestRetainedMessageByConversation.get(conversationId);
      if (
        Number.isSafeInteger(sequence) &&
        (!existing || Number(sequence) > Number(existing.sequence))
      ) {
        latestRetainedMessageByConversation.set(conversationId, record);
      }
    }

    for (const [conversationId, conversation] of conversationsById) {
      const lastSequence = conversation.lastSequence;
      const summaryPurgeAt = conversation.latestMessagePurgeAt;
      const latest = latestRetainedMessageByConversation.get(conversationId);
      const retainedSummaryMustResolve =
        Number.isSafeInteger(lastSequence) &&
        Number(lastSequence) > 0 &&
        isDate(summaryPurgeAt) &&
        summaryPurgeAt.getTime() > now.getTime();
      if (
        retainedSummaryMustResolve &&
        (!latest ||
          Number(latest.sequence) !== Number(lastSequence) ||
          objectIdText(latest._id) !== objectIdText(conversation.lastMessageId) ||
          !sameInstant(latest.purgeAt, summaryPurgeAt))
      ) {
        invalidConversationMetadata += 1;
      }
    }

    return Object.freeze({
      orphanMessages,
      messagesBeyondConversationSequence,
      orphanMembers,
      invalidAccessWindows,
      invalidConversationMetadata,
      invalidMessageRetention,
      invalidMemberState,
      messagesOutsideMemberAccess,
      invalidMessagePayload,
    });
  }

  private async helpIntegrity(): Promise<RestoreQualificationReport["integrity"]["help"]> {
    const database = this.database();
    const [requests, outcomes, conversations, members] = await Promise.all([
      database.collection(AlumniHelpRequest.collection.name).find(
        {},
        {
          projection: {
            _id: 1,
            requesterId: 1,
            providerId: 1,
            requestedHelpType: 1,
            proposedHelpType: 1,
            agreedHelpType: 1,
            status: 1,
            hasBeenAccepted: 1,
            acceptedAt: 1,
            declinedAt: 1,
            withdrawnAt: 1,
            startedAt: 1,
            completedAt: 1,
            closedAt: 1,
            conversationId: 1,
            "lifecycleTimeline.sequence": 1,
            "lifecycleTimeline.action": 1,
            "lifecycleTimeline.fromStatus": 1,
            "lifecycleTimeline.toStatus": 1,
            "lifecycleTimeline.actorRole": 1,
            "lifecycleTimeline.actorId": 1,
            "lifecycleTimeline.helpType": 1,
            "lifecycleTimeline.occurredAt": 1,
            latestOutcomeSubmissionId: 1,
            latestOutcomeRevisionNumber: 1,
            latestOutcomeStatus: 1,
            latestOutcomeDueAt: 1,
            purgeAt: 1,
          },
        },
      ).toArray(),
      database.collection(AlumniHelpOutcomeSubmission.collection.name).find(
        {},
        {
          projection: {
            _id: 1,
            helpRequestId: 1,
            revisionNumber: 1,
            previousSubmissionId: 1,
            submittedBy: 1,
            agreedHelpType: 1,
            outcomeCode: 1,
            status: 1,
            submittedAt: 1,
            dueAt: 1,
            decidedAt: 1,
            decidedBy: 1,
            confirmationMethod: 1,
            purgeAt: 1,
          },
        },
      ).toArray(),
      database.collection(Conversation.collection.name).find(
        { kind: "alumni_help" },
        {
          projection: {
            _id: 1,
            kind: 1,
            helpRequestId: 1,
            programId: 1,
            status: 1,
            archivedAt: 1,
            purgeAt: 1,
          },
        },
      ).toArray(),
      database.collection(ConversationMember.collection.name).find(
        {},
        { projection: { conversationId: 1, userId: 1, role: 1 } },
      ).toArray(),
    ]);
    const requestsById = new Map(
      requests
        .map((document) => {
          const id = objectIdText((document as PlainRecord)._id);
          return id ? [id, document as PlainRecord] as const : null;
        })
        .filter((entry): entry is readonly [string, PlainRecord] => entry !== null),
    );
    const conversationsById = new Map(
      conversations
        .map((document) => {
          const record = document as PlainRecord;
          const id = objectIdText(record._id);
          return id ? [id, record] as const : null;
        })
        .filter((entry): entry is readonly [string, PlainRecord] => entry !== null),
    );
    const membersByConversation = new Map<string, PlainRecord[]>();
    for (const document of members) {
      const record = document as PlainRecord;
      const conversationId = objectIdText(record.conversationId);
      if (!conversationId) continue;
      const roomMembers = membersByConversation.get(conversationId) ?? [];
      roomMembers.push(record);
      membersByConversation.set(conversationId, roomMembers);
    }
    const outcomesById = new Map<string, PlainRecord>();
    const outcomesByRequest = new Map<string, PlainRecord[]>();
    let orphanOutcomes = 0;
    for (const document of outcomes) {
      const record = document as PlainRecord;
      const id = objectIdText(record._id);
      const requestId = objectIdText(record.helpRequestId);
      if (id) outcomesById.set(id, record);
      if (!requestId || !requestsById.has(requestId)) {
        orphanOutcomes += 1;
      } else {
        const requestOutcomes = outcomesByRequest.get(requestId) ?? [];
        requestOutcomes.push(record);
        outcomesByRequest.set(requestId, requestOutcomes);
      }
    }

    let inconsistentLatestOutcomes = 0;
    let invalidOutcomeAncestry = 0;
    let invalidLifecycleTimelines = 0;
    let invalidRoomLinkage = 0;
    for (const [requestId, request] of requestsById) {
      if (
        !helpRequestLifecycleIsValid(request) ||
        !helpRequestStateIsValid(request)
      ) {
        invalidLifecycleTimelines += 1;
      }
      const latestOutcomeId = objectIdText(request.latestOutcomeSubmissionId);
      const requestOutcomes = outcomesByRequest.get(requestId) ?? [];
      const hasOutcomes = requestOutcomes.length > 0;
      if (!latestOutcomeId) {
        if (hasOutcomes) inconsistentLatestOutcomes += 1;
        continue;
      }
      const outcome = outcomesById.get(latestOutcomeId);
      if (
        !outcome ||
        objectIdText(outcome.helpRequestId) !== requestId ||
        outcome.revisionNumber !== request.latestOutcomeRevisionNumber ||
        outcome.status !== request.latestOutcomeStatus ||
        stableJson(outcome.dueAt) !== stableJson(request.latestOutcomeDueAt)
      ) {
        inconsistentLatestOutcomes += 1;
      }

      const outcomesByRevision = new Map<number, PlainRecord>();
      for (const outcome of requestOutcomes) {
        const revision = outcome.revisionNumber;
        if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
          invalidOutcomeAncestry += 1;
          continue;
        }
        outcomesByRevision.set(Number(revision), outcome);
      }
      for (const outcome of requestOutcomes) {
        const revision = outcome.revisionNumber;
        const previousId = objectIdText(outcome.previousSubmissionId);
        const expectedPrevious =
          Number.isSafeInteger(revision) && Number(revision) > 1
            ? outcomesByRevision.get(Number(revision) - 1)
            : undefined;
        const ancestryValid =
          Number(revision) === 1
            ? previousId === null
            : !!expectedPrevious &&
              previousId === objectIdText(expectedPrevious._id);
        if (!ancestryValid || !helpOutcomeStateIsValid(outcome, request)) {
          invalidOutcomeAncestry += 1;
        }
      }

      const conversationId = objectIdText(request.conversationId);
      if (request.hasBeenAccepted === true) {
        const room = conversationId
          ? conversationsById.get(conversationId)
          : undefined;
        const roomMembers = conversationId
          ? membersByConversation.get(conversationId) ?? []
          : [];
        const requesterId = objectIdText(request.requesterId);
        const providerId = objectIdText(request.providerId);
        const hasExactParticipants =
          roomMembers.length === 2 &&
          roomMembers.some(
            (member) =>
              member.role === "requester" &&
              objectIdText(member.userId) === requesterId,
          ) &&
          roomMembers.some(
            (member) =>
              member.role === "provider" &&
              objectIdText(member.userId) === providerId,
          );
        if (
          !room ||
          room.kind !== "alumni_help" ||
          objectIdText(room.helpRequestId) !== requestId ||
          room.programId != null ||
          !hasExactParticipants
        ) {
          invalidRoomLinkage += 1;
        }
      }
    }
    for (const [conversationId, room] of conversationsById) {
      const requestId = objectIdText(room.helpRequestId);
      const request = requestId ? requestsById.get(requestId) : undefined;
      const archivedRetentionRoomWithoutRequest =
        !request &&
        room.status === "archived" &&
        isDate(room.archivedAt) &&
        isDate(room.purgeAt);
      if (
        (!request && !archivedRetentionRoomWithoutRequest) ||
        (request && objectIdText(request.conversationId) !== conversationId)
      ) {
        invalidRoomLinkage += 1;
      }
    }
    return Object.freeze({
      orphanOutcomes,
      inconsistentLatestOutcomes,
      invalidOutcomeAncestry,
      invalidLifecycleTimelines,
      invalidRoomLinkage,
    });
  }

  private async membershipIntegrity(): Promise<RestoreQualificationReport["integrity"]["membership"]> {
    const database = this.database();
    const [programs, rooms, settings] = await Promise.all([
      database.collection(Program.collection.name).find({}, { projection: { _id: 1 } }).toArray(),
      database.collection(Conversation.collection.name).find(
        { kind: "program" },
        { projection: { programId: 1 } },
      ).toArray(),
      database.collection(ProgramCommunitySettings.collection.name).find(
        {},
        { projection: { programId: 1, enabled: 1, archivedAt: 1, membershipProjectionState: 1, membershipProjectionRevision: 1, revision: 1 } },
      ).toArray(),
    ]);
    const programIds = new Set(
      programs.map((document) => objectIdText((document as PlainRecord)._id)).filter(
        (value): value is string => value !== null,
      ),
    );
    const roomProgramIds = new Set(
      rooms.map((document) => objectIdText((document as PlainRecord).programId)).filter(
        (value): value is string => value !== null,
      ),
    );
    let settingsMissingProgram = 0;
    let enabledSettingsMissingRoom = 0;
    let reconciliationRequired = 0;
    let roomsMissingProgram = 0;
    for (const document of rooms) {
      const programId = objectIdText((document as PlainRecord).programId);
      if (!programId || !programIds.has(programId)) roomsMissingProgram += 1;
    }
    for (const document of settings) {
      const record = document as PlainRecord;
      const programId = objectIdText(record.programId);
      if (!programId || !programIds.has(programId)) {
        settingsMissingProgram += 1;
        continue;
      }
      if (record.enabled === true && record.archivedAt == null && !roomProgramIds.has(programId)) {
        enabledSettingsMissingRoom += 1;
      }
      if (
        record.membershipProjectionState === "pending" ||
        record.membershipProjectionRevision !== record.revision
      ) {
        reconciliationRequired += 1;
      }
    }
    return Object.freeze({
      settingsMissingProgram,
      enabledSettingsMissingRoom,
      reconciliationRequired,
      roomsMissingProgram,
    });
  }

  private async retentionIntegrity(now: Date): Promise<RestoreQualificationReport["integrity"]["retention"]> {
    const expiredTtlCounts = await Promise.all(
      RESTORE_TTL_DEFINITIONS.map((definition) =>
        this.countDocuments(definition.collectionName, {
          [definition.field]: { $lte: now },
        }),
      ),
    );
    const [expiredRawImportData, expiredInvitationContacts, expiredAuditLogs] = await Promise.all([
      this.countDocuments(AlumniImportBatch.collection.name, {
        rawDataPurgeAt: { $lte: now },
        rawDataPurgedAt: null,
      }),
      this.countDocuments(AlumniInvitation.collection.name, {
        contactPurgeAt: { $lte: now },
        contactPurgedAt: null,
      }),
      this.countDocuments(AuditLog.collection.name, {
        createdAt: { $lt: addUtcCalendarMonths(now, -12) },
      }),
    ]);
    return Object.freeze({
      expiredRawImportData,
      expiredInvitationContacts,
      expiredTtlRecords: expiredTtlCounts.reduce((total, value) => total + value, 0),
      expiredAuditLogs,
    });
  }

  private async accountDeletionIntegrity(): Promise<RestoreQualificationReport["integrity"]["accountDeletion"]> {
    const [unscheduledProfiles, unscheduledAffiliations, unscheduledConsents] =
      await Promise.all([
        this.countDocuments(AlumniProfile.collection.name, {
          accountDeletionApprovedAt: { $ne: null },
          purgeAt: null,
        }),
        this.countDocuments(AlumniAffiliation.collection.name, {
          accountDeletionApprovedAt: { $ne: null },
          purgeAt: null,
        }),
        this.countDocuments(ConsentRecord.collection.name, {
          status: "account_deleted",
          purgeAt: null,
        }),
      ]);
    return Object.freeze({
      unscheduledProfiles,
      unscheduledAffiliations,
      unscheduledConsents,
    });
  }

  private async buildReport(
    manifest: RestoreQualificationManifest | undefined,
  ): Promise<RestoreQualificationReport> {
    const now = this.requireNow();
    const [migration, transaction, indexes, fingerprints, chat, help, membership, retention, accountDeletion] =
      await Promise.all([
        this.migrationStatus(),
        this.readTransactionCapability(),
        this.inspectIndexes(),
        Promise.all(RESTORE_COLLECTIONS.map((definition) => this.fingerprint(definition))),
        this.chatIntegrity(now),
        this.helpIntegrity(),
        this.membershipIntegrity(),
        this.retentionIntegrity(now),
        this.accountDeletionIntegrity(),
      ]);
    const collections: Record<string, RestoreCollectionFingerprint> = {};
    let mismatchedCollections = 0;
    for (const [index, definition] of RESTORE_COLLECTIONS.entries()) {
      const fingerprint = fingerprints[index]!;
      collections[definition.key] = fingerprint;
      const expected = manifest?.collections[definition.key];
      if (
        expected &&
        (expected.count !== fingerprint.count || expected.digest !== fingerprint.digest)
      ) {
        mismatchedCollections += 1;
      }
    }

    const issues: RestoreQualificationIssue[] = [];
    const migrationNotReady =
      !migration.healthy || migration.recoveryRequired || migration.pendingCount > 0;
    addIssue(issues, "RESTORE_MIGRATION_NOT_READY", migrationNotReady ? 1 : 0);
    addIssue(
      issues,
      "RESTORE_TRANSACTION_TOPOLOGY_UNSUPPORTED",
      transaction.supported ? 0 : 1,
    );
    addIssue(issues, "RESTORE_INDEX_MISSING", indexes.missing);
    addIssue(issues, "RESTORE_INDEX_MISMATCH", indexes.mismatched);
    addIssue(issues, "RESTORE_MANIFEST_MISMATCH", mismatchedCollections);
    addIssue(
      issues,
      "RESTORE_CHAT_INTEGRITY_INVALID",
      chat.orphanMessages +
        chat.messagesBeyondConversationSequence +
        chat.orphanMembers +
        chat.invalidAccessWindows +
        chat.invalidConversationMetadata +
        chat.invalidMessageRetention +
        chat.invalidMemberState +
        chat.messagesOutsideMemberAccess +
        chat.invalidMessagePayload,
    );
    addIssue(
      issues,
      "RESTORE_HELP_INTEGRITY_INVALID",
      help.orphanOutcomes +
        help.inconsistentLatestOutcomes +
        help.invalidOutcomeAncestry +
        help.invalidLifecycleTimelines +
        help.invalidRoomLinkage,
    );
    addIssue(
      issues,
      "RESTORE_MEMBERSHIP_INTEGRITY_INVALID",
      membership.settingsMissingProgram +
        membership.enabledSettingsMissingRoom +
        membership.reconciliationRequired +
        membership.roomsMissingProgram,
    );
    addIssue(
      issues,
      "RESTORE_RETENTION_CLEANUP_REQUIRED",
      retention.expiredRawImportData +
        retention.expiredInvitationContacts +
        retention.expiredTtlRecords +
        retention.expiredAuditLogs,
    );
    addIssue(
      issues,
      "RESTORE_ACCOUNT_DELETION_RECONCILIATION_REQUIRED",
      accountDeletion.unscheduledProfiles + accountDeletion.unscheduledAffiliations + accountDeletion.unscheduledConsents,
    );

    return Object.freeze({
      schemaVersion: REPORT_SCHEMA_VERSION,
      kind: "restore_qualification",
      generatedAt: now.toISOString(),
      status: issues.length === 0 ? "passed" : "failed",
      collections: Object.freeze(collections),
      migration: Object.freeze({
        healthy: migration.healthy,
        recoveryRequired: migration.recoveryRequired,
        applied: migration.appliedCount,
        pending: migration.pendingCount,
        issues: migration.issues.length,
      }),
      transaction: Object.freeze({
        supported: transaction.supported,
        topology: transaction.topology,
      }),
      indexes,
      integrity: Object.freeze({ chat, help, membership, retention, accountDeletion }),
      comparison: Object.freeze({
        manifestProvided: manifest !== undefined,
        mismatchedCollections,
      }),
      issues: Object.freeze(issues),
    });
  }
}

export const restoreQualificationService = new RestoreQualificationService(
  mongoose.connection,
);
