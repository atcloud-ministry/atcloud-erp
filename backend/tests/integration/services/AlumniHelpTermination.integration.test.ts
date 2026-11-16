import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addUtcCalendarMonths } from "../../../src/contracts/alumniDirectoryData";
import AlumniHelpRequest from "../../../src/models/AlumniHelpRequest";
import { terminateActiveHelpRequestsInTransaction } from "../../../src/services/alumni/AlumniHelpTermination";
import { MongoTransactionService } from "../../../src/services/reliability/MongoTransactionService";
import { ensureIntegrationDB } from "../setup/connect";

const NOW = new Date("2032-01-31T20:15:00.000Z");
const CREATED_AT = new Date(NOW.getTime() - 24 * 60 * 60 * 1_000);
const HASH = (character: string) => character.repeat(64);

/** A Help Request that has been made but never accepted. */
async function createPendingRequest(input: {
  readonly requesterId: mongoose.Types.ObjectId;
  readonly providerId: mongoose.Types.ObjectId;
}) {
  const _id = new mongoose.Types.ObjectId();
  await AlumniHelpRequest.create({
    _id,
    requesterId: input.requesterId,
    providerId: input.providerId,
    alumniProfileId: new mongoose.Types.ObjectId(),
    requesterSnapshot: { displayName: "Requester", avatar: null },
    providerSnapshot: { displayName: "Provider", avatar: null },
    requestedHelpType: "career_advice",
    consentVersion: "alumni-help-consent-v2",
    consentDocumentHash: HASH("a"),
    disclaimerVersion: "alumni-help-disclaimer-v2",
    disclaimerDocumentHash: HASH("b"),
    termsAcceptedAt: CREATED_AT,
    status: "requested",
    hasBeenAccepted: false,
    activeUniqueness: true,
    lifecycleTimeline: [
      {
        _id: new mongoose.Types.ObjectId(),
        sequence: 1,
        action: "create",
        fromStatus: null,
        toStatus: "requested",
        actorRole: "requester",
        actorId: input.requesterId,
        note: null,
        helpType: "career_advice",
        occurredAt: CREATED_AT,
      },
    ],
    revision: 0,
  });
  return _id;
}

describe("terminateActiveHelpRequestsInTransaction", () => {
  let transactions: MongoTransactionService;

  beforeAll(async () => {
    await ensureIntegrationDB();
    await AlumniHelpRequest.init();
    transactions = new MongoTransactionService(mongoose.connection);
    await transactions.assertTopologyCapability(true);
  });

  beforeEach(async () => {
    await AlumniHelpRequest.deleteMany({});
  });

  afterAll(async () => {
    await AlumniHelpRequest.deleteMany({});
  });

  function terminate(
    targetUserId: mongoose.Types.ObjectId,
    scope: "any" | "provider",
  ) {
    return transactions.run((session) =>
      terminateActiveHelpRequestsInTransaction({
        targetUserId,
        scope,
        now: NOW,
        session,
        conflictMessage: "Help Request changed during test.",
      }),
    );
  }

  it("leaving the network declines requests made to the member but keeps their own open", async () => {
    const member = new mongoose.Types.ObjectId();
    const peer = new mongoose.Types.ObjectId();
    const madeToMember = await createPendingRequest({
      requesterId: peer,
      providerId: member,
    });
    const madeByMember = await createPendingRequest({
      requesterId: member,
      providerId: peer,
    });

    await expect(terminate(member, "provider")).resolves.toEqual({
      requests: 1,
      rooms: 0,
    });

    const [declined, untouched] = await Promise.all([
      AlumniHelpRequest.findById(madeToMember),
      AlumniHelpRequest.findById(madeByMember),
    ]);
    expect(declined).toMatchObject({
      status: "declined",
      declinedAt: NOW,
      activeUniqueness: false,
      purgeAt: addUtcCalendarMonths(NOW, 2),
      revision: 1,
    });
    expect(declined?.lifecycleTimeline.at(-1)).toMatchObject({
      sequence: 2,
      action: "decline",
      fromStatus: "requested",
      toStatus: "declined",
      actorRole: "provider",
    });
    expect(untouched).toMatchObject({
      status: "requested",
      activeUniqueness: true,
      revision: 0,
    });
  });

  it("with scope any, withdraws the user's own requests and declines ones made to them", async () => {
    const user = new mongoose.Types.ObjectId();
    const peer = new mongoose.Types.ObjectId();
    const madeToUser = await createPendingRequest({
      requesterId: peer,
      providerId: user,
    });
    const madeByUser = await createPendingRequest({
      requesterId: user,
      providerId: peer,
    });

    await expect(terminate(user, "any")).resolves.toEqual({
      requests: 2,
      rooms: 0,
    });

    const [declined, withdrawn] = await Promise.all([
      AlumniHelpRequest.findById(madeToUser),
      AlumniHelpRequest.findById(madeByUser),
    ]);
    expect(declined).toMatchObject({ status: "declined", declinedAt: NOW });
    expect(withdrawn).toMatchObject({ status: "withdrawn", withdrawnAt: NOW });
  });

  it("leaves requests that are already finished alone", async () => {
    const member = new mongoose.Types.ObjectId();
    const requestId = await createPendingRequest({
      requesterId: new mongoose.Types.ObjectId(),
      providerId: member,
    });
    await AlumniHelpRequest.updateOne(
      { _id: requestId },
      { $set: { status: "declined", activeUniqueness: false, declinedAt: CREATED_AT } },
    );

    await expect(terminate(member, "provider")).resolves.toEqual({
      requests: 0,
      rooms: 0,
    });
    expect(await AlumniHelpRequest.findById(requestId)).toMatchObject({
      declinedAt: CREATED_AT,
      revision: 0,
    });
  });
});
