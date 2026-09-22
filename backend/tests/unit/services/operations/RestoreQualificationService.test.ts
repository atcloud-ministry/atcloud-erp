import type { Connection } from "mongoose";
import { describe, expect, it } from "vitest";
import AlumniAffiliation from "../../../../src/models/AlumniAffiliation";
import AlumniHelpOutcomeSubmission from "../../../../src/models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest from "../../../../src/models/AlumniHelpRequest";
import AlumniImportBatch from "../../../../src/models/AlumniImportBatch";
import AlumniInvitation from "../../../../src/models/AlumniInvitation";
import AlumniProfile from "../../../../src/models/AlumniProfile";
import AuditLog from "../../../../src/models/AuditLog";
import ChatMessage from "../../../../src/models/ChatMessage";
import ConsentRecord from "../../../../src/models/ConsentRecord";
import Conversation from "../../../../src/models/Conversation";
import ConversationMember from "../../../../src/models/ConversationMember";
import IdempotencyRecord from "../../../../src/models/IdempotencyRecord";
import NotificationOutbox from "../../../../src/models/NotificationOutbox";
import Program from "../../../../src/models/Program";
import ProgramCommunitySettings from "../../../../src/models/ProgramCommunitySettings";
import Purchase from "../../../../src/models/Purchase";
import SchemaMigration from "../../../../src/models/SchemaMigration";
import User from "../../../../src/models/User";
import {
  RestoreQualificationService,
  type RestoreQualificationReport,
} from "../../../../src/services/operations/RestoreQualificationService";
import type { MigrationStatusResult } from "../../../../src/services/migrations/MigrationRunner";

const NOW = new Date("2030-09-19T12:00:00.000Z");

const RESTORE_MODELS = [
  User,
  Program,
  Purchase,
  AlumniProfile,
  AlumniAffiliation,
  AlumniInvitation,
  AlumniImportBatch,
  ConsentRecord,
  AlumniHelpRequest,
  AlumniHelpOutcomeSubmission,
  Conversation,
  ConversationMember,
  ChatMessage,
  ProgramCommunitySettings,
  NotificationOutbox,
  IdempotencyRecord,
  AuditLog,
  SchemaMigration,
] as const;

type PlainRecord = Record<string, unknown>;

const HEALTHY_MIGRATION_STATUS: MigrationStatusResult = Object.freeze({
  healthy: true,
  recoveryRequired: false,
  appliedCount: 10,
  pendingCount: 0,
  entries: [],
  issues: [],
});

function indexName(key: PlainRecord, options: PlainRecord): string {
  if (typeof options.name === "string" && options.name.length > 0) {
    return options.name;
  }
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join("_");
}

function cursor(records: readonly PlainRecord[]) {
  const values = [...records];
  return {
    sort: () => cursor(values),
    toArray: async () => [...values],
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

interface QualificationHarness {
  readonly service: RestoreQualificationService;
  readonly indexes: Map<string, PlainRecord[]>;
}

function createHarness(
  documents: Readonly<Record<string, readonly PlainRecord[]>> = {},
  transactionSupported = true,
): QualificationHarness {
  const indexes = new Map<string, PlainRecord[]>(
    RESTORE_MODELS.map((model) => [
      model.collection.name,
      model.schema.indexes().map(([key, options]) => ({
        key,
        ...options,
        name: indexName(key, options),
      })),
    ]),
  );
  const database = {
    collection: (name: string) => ({
      find: () => cursor(documents[name] ?? []),
      aggregate: () => ({ toArray: async () => [] }),
      countDocuments: async () => 0,
      listIndexes: () => ({ toArray: async () => indexes.get(name) ?? [] }),
    }),
  };
  const service = new RestoreQualificationService(
    { db: database } as unknown as Connection,
    {
      now: () => new Date(NOW),
      migrationStatus: async () => HEALTHY_MIGRATION_STATUS,
      transactionCapability: async () => ({
        supported: transactionSupported,
        topology: transactionSupported ? "replica_set" : "standalone",
      }),
    },
  );
  return { service, indexes };
}

function changedManifest(
  report: RestoreQualificationReport,
): RestoreQualificationReport {
  return {
    ...report,
    collections: {
      ...report.collections,
      users: {
        ...report.collections.users,
        digest: "0".repeat(64),
      },
    },
  };
}

describe("RestoreQualificationService report contract", () => {
  it("returns a read-only, PII-free fingerprint report", async () => {
    const privateEmail = "restored-person@example.invalid";
    const user = {
      _id: "507f1f77bcf86cd799439011",
      email: privateEmail,
      username: "private-user",
      legalName: "Private Person",
      isActive: true,
      isVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const documents = {
      [User.collection.name]: [user],
    };
    const { service } = createHarness(documents);

    const report = await service.inspect();

    expect(report.status).toBe("passed");
    expect(report.collections.users.count).toBe(1);
    expect(report.collections.chat_messages.count).toBe(0);
    expect(report).not.toHaveProperty("records");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(privateEmail);
    expect(documents[User.collection.name]?.[0]).toBe(user);
  });

  it("accepts an archived retained Alumni Help room after its request has expired", async () => {
    const { service } = createHarness({
      [Conversation.collection.name]: [
        {
          _id: "507f1f77bcf86cd799439021",
          kind: "alumni_help",
          helpRequestId: "507f1f77bcf86cd799439022",
          programId: null,
          status: "archived",
          archivedAt: NOW,
          purgeAt: new Date("2032-09-19T12:00:00.000Z"),
        },
      ],
    });

    const report = await service.inspect();

    expect(report.integrity.help.invalidRoomLinkage).toBe(0);
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: "RESTORE_HELP_INTEGRITY_INVALID" }),
    );
  });

  it("requires exact schema index metadata and detects a changed restore manifest", async () => {
    const healthy = createHarness();
    const baseline = await healthy.service.inspect();

    expect(baseline.status).toBe("passed");
    expect(baseline.indexes).toMatchObject({
      expected: expect.any(Number),
      missing: 0,
      mismatched: 0,
    });
    expect(baseline.indexes.expected).toBeGreaterThan(0);
    await expect(healthy.service.verify(baseline)).resolves.toMatchObject({
      status: "passed",
      comparison: { manifestProvided: true, mismatchedCollections: 0 },
    });

    const missing = createHarness();
    const conversationIndexes = missing.indexes.get(Conversation.collection.name)!;
    missing.indexes.set(
      Conversation.collection.name,
      conversationIndexes.filter(
        (index) => index.name !== "uniq_conversation_program",
      ),
    );
    await expect(missing.service.inspect()).resolves.toMatchObject({
      status: "failed",
      indexes: { missing: 1, mismatched: 0 },
      issues: expect.arrayContaining([
        { code: "RESTORE_INDEX_MISSING", count: 1 },
      ]),
    });

    const mismatched = createHarness();
    const mismatchedIndexes = mismatched.indexes.get(Conversation.collection.name)!;
    mismatched.indexes.set(
      Conversation.collection.name,
      mismatchedIndexes.map((index) =>
        index.name === "uniq_conversation_program"
          ? {
              ...index,
              partialFilterExpression: { programId: { $exists: true } },
            }
          : index,
      ),
    );
    await expect(mismatched.service.inspect()).resolves.toMatchObject({
      status: "failed",
      indexes: { missing: 0, mismatched: 1 },
      issues: expect.arrayContaining([
        { code: "RESTORE_INDEX_MISMATCH", count: 1 },
      ]),
    });

    await expect(healthy.service.verify(changedManifest(baseline))).resolves.toMatchObject({
      status: "failed",
      comparison: { manifestProvided: true, mismatchedCollections: 1 },
      issues: expect.arrayContaining([
        { code: "RESTORE_MANIFEST_MISMATCH", count: 1 },
      ]),
    });
  });

  it("fails closed when the restored database cannot support transactions", async () => {
    const { service } = createHarness({}, false);

    await expect(service.inspect()).resolves.toMatchObject({
      status: "failed",
      transaction: { supported: false, topology: "standalone" },
      issues: expect.arrayContaining([
        { code: "RESTORE_TRANSACTION_TOPOLOGY_UNSUPPORTED", count: 1 },
      ]),
    });
  });
});
