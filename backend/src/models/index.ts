// Re-export all models for easy importing
export { default as User, IUser } from "./User";
export {
  default as Event,
  IEvent,
  IEventRole,
  IOrganizerDetail,
} from "./Event";
export {
  default as Registration,
  IRegistration,
  IEventRegistrationStats,
} from "./Registration";
export { default as Message, IMessage, IMessageModel } from "./Message"; // Unified Message System
export {
  default as GuestRegistration,
  IGuestRegistration,
  IGuestRegistrationModel,
} from "./GuestRegistration";
export { default as Program, IProgram } from "./Program";
export {
  default as AnnualMembership,
  IAnnualMembership,
} from "./AnnualMembership";
export { default as ShortLink, IShortLink, IShortLinkModel } from "./ShortLink";
export { default as Purchase, IPurchase } from "./Purchase";
export {
  default as RefundRequest,
  IRefundRequest,
  RefundRequestStatus,
  RefundRequestSource,
  RefundRequestUserDecision,
} from "./RefundRequest";
export { default as PromoCode, IPromoCode } from "./PromoCode"; // Promo Code System
export {
  SystemConfig,
  ISystemConfig,
  IBundleDiscountConfig,
} from "./SystemConfig"; // System Configuration
export { default as AuditLog, IAuditLog } from "./AuditLog";
export {
  default as IdempotencyRecord,
  IIdempotencyRecord,
  IdempotencyRecordState,
  IdempotencyResourceReference,
} from "./IdempotencyRecord";
export {
  default as NotificationOutbox,
  INotificationOutbox,
  NotificationOutboxStatus,
  NOTIFICATION_OUTBOX_STATUSES,
} from "./NotificationOutbox";
export {
  default as SchemaMigration,
  ISanitizedMigrationError,
  ISchemaMigration,
} from "./SchemaMigration";
export {
  default as SchemaMigrationLock,
  ISchemaMigrationLock,
  SCHEMA_MIGRATION_GLOBAL_LOCK_ID,
} from "./SchemaMigrationLock";
export { default as RolesTemplate, IRolesTemplate } from "./RolesTemplate";
export {
  default as FeatureControl,
  FEATURE_CONTROL_COLLECTION,
  FEATURE_CONTROL_SINGLETON_ID,
  IFeatureControl,
} from "./FeatureControl";
export {
  default as AlumniProfile,
  ALUMNI_PROFILE_COLLECTION,
  AlumniHelpOfferings,
  AlumniProfileSearchProjection,
  IAlumniProfile,
} from "./AlumniProfile";
export {
  default as AlumniAffiliation,
  ALUMNI_AFFILIATION_COLLECTION,
  IAlumniAffiliation,
} from "./AlumniAffiliation";
export {
  default as AlumniInvitation,
  ALUMNI_INVITATION_COLLECTION,
  AlumniInvitationAffiliation,
  IAlumniInvitation,
} from "./AlumniInvitation";
export {
  default as AlumniImportBatch,
  ALUMNI_IMPORT_BATCH_COLLECTION,
  AlumniImportBatchCounts,
  AlumniImportRawRow,
  AlumniImportRowError,
  AlumniImportRowResult,
  IAlumniImportBatch,
} from "./AlumniImportBatch";
export {
  default as ConsentRecord,
  CONSENT_RECORD_COLLECTION,
  IConsentRecord,
} from "./ConsentRecord";
export {
  default as AlumniHelpRequest,
  ALUMNI_HELP_REQUEST_COLLECTION,
  AlumniHelpLifecycleEvent,
  AlumniHelpParticipantSnapshot,
  IAlumniHelpRequest,
} from "./AlumniHelpRequest";
export {
  default as AlumniHelpOutcomeSubmission,
  ALUMNI_HELP_OUTCOME_SUBMISSION_COLLECTION,
  IAlumniHelpOutcomeSubmission,
} from "./AlumniHelpOutcomeSubmission";
export {
  default as Conversation,
  CONVERSATION_COLLECTION,
  CONVERSATION_KINDS,
  CONVERSATION_STATUSES,
  ConversationKind,
  ConversationStatus,
  IConversation,
} from "./Conversation";
export {
  default as ConversationMember,
  CONVERSATION_MEMBER_COLLECTION,
  CONVERSATION_MEMBER_ROLES,
  CONVERSATION_MEMBER_STATUSES,
  ConversationAccessWindow,
  ConversationMemberRole,
  ConversationMemberStatus,
  IConversationMember,
} from "./ConversationMember";
export {
  default as ChatMessage,
  CHAT_MESSAGE_COLLECTION,
  CHAT_MESSAGE_FIELD_LIMITS,
  CHAT_MESSAGE_KINDS,
  ChatMessageKind,
  ChatSafeLink,
  ChatSenderSnapshot,
  IChatMessage,
} from "./ChatMessage";
export {
  default as PushSubscription,
  IPushSubscription,
  PUSH_SUBSCRIPTION_COLLECTION,
} from "./PushSubscription";
export {
  default as NotificationPreference,
  INotificationPreference,
  NOTIFICATION_PREFERENCE_COLLECTION,
} from "./NotificationPreference";
export { initializeAlumniDataModels } from "./initializeAlumniDataModels";
export {
  ACCOUNT_DELETION_RETENTION_DAYS,
  ALUMNI_AFFILIATION_VERIFICATION_STATUSES,
  ALUMNI_IMPORT_BATCH_STATUSES,
  ALUMNI_IMPORT_BATCH_TERMINAL_STATUSES,
  ALUMNI_IMPORT_ROW_APPLICATION_STATUSES,
  ALUMNI_IMPORT_ROW_ELIGIBILITY_STATUSES,
  ALUMNI_IMPORT_ROW_MATCH_METHODS,
  ALUMNI_IMPORT_ROW_MATCH_STATUSES,
  ALUMNI_INVITATION_STATUSES,
  ALUMNI_PROFILE_PUBLISH_STATUSES,
  CONSENT_RECORD_PURPOSES,
  CONSENT_RECORD_RETENTION_MONTHS,
  CONSENT_RECORD_STATUSES,
  IMPORT_RAW_DATA_RETENTION_DAYS,
  IMPORT_SUMMARY_RETENTION_MONTHS,
  INVITATION_CONTACT_RETENTION_MONTHS,
  INVITATION_TOKEN_LIFETIME_DAYS,
  type AlumniAffiliationVerificationStatus,
  type AlumniImportBatchStatus,
  type AlumniImportRowApplicationStatus,
  type AlumniImportRowEligibilityStatus,
  type AlumniImportRowMatchMethod,
  type AlumniImportRowMatchStatus,
  type AlumniInvitationStatus,
  type AlumniProfilePublishStatus,
  type ConsentRecordPurpose,
  type ConsentRecordStatus,
} from "../contracts/alumniDirectoryData";

// Database connection helper
import mongoose from "mongoose";
import { MONGODB_CONNECTION_OPTIONS } from "../config/database";

export const connectDatabase = async (): Promise<void> => {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGODB_URI environment variable is not defined");
    }

    await mongoose.connect(mongoUri, MONGODB_CONNECTION_OPTIONS);

    // Handle connection events
    mongoose.connection.on("error", (error) => {
      console.error("❌ MongoDB connection error:", error);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });

    mongoose.connection.on("reconnected", () => {});

    // Graceful shutdown
    process.on("SIGINT", async () => {
      await mongoose.connection.close();
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }
};

// Database health check
export const checkDatabaseHealth = async (): Promise<boolean> => {
  try {
    const state = mongoose.connection.readyState;
    return state === 1; // 1 = connected
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
};

// Get database statistics
export const getDatabaseStats = async () => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("Database not connected");
    }

    const stats = await db.stats();
    const collections = await db.listCollections().toArray();

    return {
      databaseName: db.databaseName,
      collections: collections.length,
      dataSize: stats.dataSize,
      storageSize: stats.storageSize,
      indexes: stats.indexes,
      objects: stats.objects,
      avgObjSize: stats.avgObjSize,
      connected: mongoose.connection.readyState === 1,
    };
  } catch (error) {
    console.error("Failed to get database statistics:", error);
    throw error;
  }
};
