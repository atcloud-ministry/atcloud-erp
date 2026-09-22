import mongoose from "mongoose";
import { ObjectId, type Collection, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acceptedHelpRequestPurgeAt,
  alumniHelpRoomGraceEndsAt,
  helpOutcomeDueAt,
} from "../../src/contracts/alumniHelpFlow";
import { MIGRATION_REGISTRY } from "../../src/migrations/registry";
import type { MigrationDefinition } from "../../src/migrations/types";
import {
  MigrationRunner,
  SCHEMA_MIGRATION_COLLECTION,
} from "../../src/services/migrations/MigrationRunner";
import { SCHEMA_MIGRATION_LOCK_COLLECTION } from "../../src/services/migrations/MigrationLeaseService";
import { ensureIntegrationDB } from "../integration/setup/connect";

const MIGRATION_ID =
  "20260921_001_reconcile-confirmed-alumni-help-closures";
const REQUEST_COLLECTION = "alumni_help_requests";
const OUTCOME_COLLECTION = "alumni_help_outcome_submissions";
const ROOM_COLLECTION = "conversations";

function database() {
  const value = mongoose.connection.db;
  if (!value) throw new Error("Integration database is not connected.");
  return value;
}

function collection(name: string): Collection<Document> {
  return database().collection(name);
}

function objectId(sequence: number): ObjectId {
  return new ObjectId(sequence.toString(16).padStart(24, "0"));
}

function productionMigration(): MigrationDefinition {
  const definition = MIGRATION_REGISTRY.find(
    (candidate) => candidate.id === MIGRATION_ID,
  );
  if (!definition) {
    throw new Error("Confirmed Alumni Help closure migration is missing.");
  }
  return definition;
}

let runnerSequence = 0;

function createRunner(): MigrationRunner {
  runnerSequence += 1;
  return new MigrationRunner({
    connection: mongoose.connection,
    operator: "confirmed-alumni-help-closure-migration-test",
    appVersion: "g1-04-test",
    leaseOwner: `confirmed-alumni-help-closure-runner-${runnerSequence}`,
    registry: [productionMigration()],
    batchSize: 100,
    leaseDurationMs: 60_000,
  });
}

function requireDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

describe("confirmed Alumni Help closure reconciliation migration", () => {
  beforeAll(async () => {
    await ensureIntegrationDB();
  });

  beforeEach(async () => {
    await Promise.all([
      collection(REQUEST_COLLECTION).deleteMany({}),
      collection(OUTCOME_COLLECTION).deleteMany({}),
      collection(ROOM_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      collection(REQUEST_COLLECTION).deleteMany({}),
      collection(OUTCOME_COLLECTION).deleteMany({}),
      collection(ROOM_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_COLLECTION).deleteMany({}),
      collection(SCHEMA_MIGRATION_LOCK_COLLECTION).deleteMany({}),
    ]);
  });

  it("closes a raw legacy confirmed request, preserves retention, begins Room grace, and passes runner verification", async () => {
    const now = Date.now();
    const requestId = objectId(1_001);
    const outcomeId = objectId(1_002);
    const roomId = objectId(1_003);
    const requesterId = objectId(1_004);
    const providerId = objectId(1_005);
    const profileId = objectId(1_006);
    const createdAt = new Date(now - 72 * 60 * 60 * 1_000);
    const acceptedAt = new Date(now - 48 * 60 * 60 * 1_000);
    const completedAt = new Date(now - 24 * 60 * 60 * 1_000);
    const submittedAt = new Date(now - 12 * 60 * 60 * 1_000);
    const dueAt = helpOutcomeDueAt(submittedAt);
    const decidedAt = new Date(now - 60 * 60 * 1_000);

    await collection(REQUEST_COLLECTION).insertOne({
      _id: requestId,
      requesterId,
      providerId,
      alumniProfileId: profileId,
      requesterSnapshot: { displayName: "Requester", avatar: null },
      providerSnapshot: { displayName: "Provider", avatar: null },
      requestedHelpType: "career_advice",
      proposedHelpType: null,
      agreedHelpType: "career_advice",
      openingNote: "Please share career advice.",
      consentVersion: "v1",
      consentDocumentHash: "a".repeat(64),
      disclaimerVersion: "v1",
      disclaimerDocumentHash: "b".repeat(64),
      termsAcceptedAt: createdAt,
      status: "completed",
      hasBeenAccepted: true,
      activeUniqueness: true,
      acceptedAt,
      declinedAt: null,
      withdrawnAt: null,
      startedAt: null,
      completedAt,
      closedAt: null,
      conversationId: roomId,
      lifecycleTimeline: [
        {
          _id: objectId(1_101),
          sequence: 1,
          action: "create",
          fromStatus: null,
          toStatus: "requested",
          actorRole: "requester",
          actorId: requesterId,
          note: null,
          helpType: "career_advice",
          occurredAt: createdAt,
        },
        {
          _id: objectId(1_102),
          sequence: 2,
          action: "accept",
          fromStatus: "requested",
          toStatus: "accepted",
          actorRole: "provider",
          actorId: providerId,
          note: null,
          helpType: "career_advice",
          occurredAt: acceptedAt,
        },
        {
          _id: objectId(1_103),
          sequence: 3,
          action: "complete",
          fromStatus: "accepted",
          toStatus: "completed",
          actorRole: "provider",
          actorId: providerId,
          note: null,
          helpType: "career_advice",
          occurredAt: completedAt,
        },
      ],
      latestOutcomeSubmissionId: outcomeId,
      latestOutcomeRevisionNumber: 1,
      latestOutcomeStatus: "confirmed",
      latestOutcomeDueAt: dueAt,
      purgeAt: null,
      requesterUpdateSequence: 1,
      providerUpdateSequence: 2,
      requesterReadSequence: 0,
      providerReadSequence: 0,
      revision: 6,
      createdAt,
      updatedAt: decidedAt,
    });
    await collection(OUTCOME_COLLECTION).insertOne({
      _id: outcomeId,
      helpRequestId: requestId,
      revisionNumber: 1,
      previousSubmissionId: null,
      submittedBy: requesterId,
      agreedHelpType: "career_advice",
      outcomeCode: "completed",
      status: "confirmed",
      submittedAt,
      dueAt,
      decidedAt,
      decidedBy: providerId,
      confirmationMethod: "provider",
      purgeAt: null,
      revision: 1,
      createdAt: submittedAt,
      updatedAt: decidedAt,
    });
    await collection(ROOM_COLLECTION).insertOne({
      _id: roomId,
      kind: "alumni_help",
      status: "current",
      helpRequestId: requestId,
      programId: null,
      lastSequence: 0,
      lastMessageId: null,
      latestMessagePurgeAt: null,
      writeAccessEndsAt: null,
      archivedAt: null,
      purgeAt: null,
      revision: 3,
      createdAt: acceptedAt,
      updatedAt: decidedAt,
    });

    const applied = await createRunner().apply(MIGRATION_ID);

    expect(applied.entries).toEqual([
      expect.objectContaining({
        id: MIGRATION_ID,
        status: "applied",
        counts: {
          examined: 1,
          matched: 1,
          modified: 1,
          skipped: 0,
          errors: 0,
        },
      }),
    ]);

    const [request, outcome, room] = await Promise.all([
      collection(REQUEST_COLLECTION).findOne({ _id: requestId }),
      collection(OUTCOME_COLLECTION).findOne({ _id: outcomeId }),
      collection(ROOM_COLLECTION).findOne({ _id: roomId }),
    ]);
    if (!request || !outcome || !room) {
      throw new Error("Migration fixture records were not found after apply.");
    }

    const closedAt = requireDate(request.closedAt, "request.closedAt");
    const expectedPurgeAt = acceptedHelpRequestPurgeAt(closedAt, dueAt);
    expect(request).toMatchObject({
      status: "closed",
      hasBeenAccepted: true,
      activeUniqueness: false,
      closedAt,
      purgeAt: expectedPurgeAt,
      updatedAt: closedAt,
      revision: 7,
      requesterUpdateSequence: 8,
      providerUpdateSequence: 8,
    });
    expect(request.lifecycleTimeline).toHaveLength(4);
    expect(request.lifecycleTimeline.at(-1)).toMatchObject({
      _id: requestId,
      sequence: 4,
      action: "outcome_reconcile",
      fromStatus: "completed",
      toStatus: "closed",
      actorRole: "system",
      actorId: null,
      note: null,
      helpType: null,
      occurredAt: closedAt,
    });
    expect(outcome).toMatchObject({
      status: "confirmed",
      purgeAt: expectedPurgeAt,
    });
    expect(room).toMatchObject({
      kind: "alumni_help",
      status: "current",
      helpRequestId: requestId,
      writeAccessEndsAt: alumniHelpRoomGraceEndsAt(closedAt),
      archivedAt: null,
      purgeAt: null,
      revision: 4,
      updatedAt: closedAt,
    });

    // MigrationRunner invokes verify() inside the terminal transaction. A
    // completed apply and healthy status therefore prove the postcondition.
    await expect(createRunner().status()).resolves.toMatchObject({
      healthy: true,
      recoveryRequired: false,
      appliedCount: 1,
      pendingCount: 0,
      issues: [],
      entries: [expect.objectContaining({ id: MIGRATION_ID, status: "applied" })],
    });
  });
});
