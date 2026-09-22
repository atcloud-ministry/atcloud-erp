import { timingSafeEqual } from "crypto";
import mongoose, { type ClientSession } from "mongoose";
import {
  ALUMNI_CONTACT_LOOKUP_VERSION,
  ALUMNI_INVITATION_TOKEN_VERSION,
} from "../../config/alumniInvitationSecurity";
import {
  ALUMNI_INVITATION_STATUSES,
  INVITATION_CONTACT_RETENTION_MONTHS,
  INVITATION_TOKEN_LIFETIME_DAYS,
  addFixedDays,
  addUtcCalendarMonths,
  deriveAlumniAffiliationKey,
  deriveAlumniProgramAffiliationKey,
} from "../../contracts/alumniDirectoryData";
import {
  ALUMNI_INVITATION_LIST_MAX_LIMIT,
  buildAlumniInvitationAdminListPageDTO,
  type AlumniInvitationAdminListPageDTO,
  type AlumniInvitationListQuery,
} from "../../contracts/alumniRosterFlow";
import type { IdempotencyReplayResponseDto } from "../reliability/IdempotencyResponseContract";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import AlumniImportBatch from "../../models/AlumniImportBatch";
import AlumniInvitation, {
  type AlumniInvitationAffiliation,
  type IAlumniInvitation,
} from "../../models/AlumniInvitation";
import AlumniProfile from "../../models/AlumniProfile";
import User from "../../models/User";
import { AuditLogService } from "../AuditLogService";
import {
  IdempotencyService,
  idempotencyService,
} from "../reliability/IdempotencyService";
import {
  NotificationOutboxService,
  notificationOutboxService,
} from "../reliability/NotificationOutboxService";
import {
  deriveAlumniContactLookupHash,
  deriveAlumniInvitationToken,
  hashAlumniInvitationToken,
  normalizeAlumniContactEmail,
} from "./AlumniInvitationSecurity";
import {
  ALUMNI_INVITATION_EMAIL_PAYLOAD_VERSION,
  ALUMNI_INVITATION_EMAIL_TOPIC,
} from "./AlumniInvitationEmailDeliveryHandler";
import {
  AlumniFlowError,
  alumniInputError,
  alumniInvitationUnavailable,
} from "./AlumniFlowErrors";
import {
  ALUMNI_PROFILE_SEARCH_USER_PROJECTION,
  buildAlumniProfileSearchProjection,
} from "./AlumniProfileProjectionService";

const INVITATION_PRIVATE_SELECTION = [
  "+contactEmail",
  "+contactFirstName",
  "+contactLastName",
  "+contactLookupHash",
  "+activeContactLookupHash",
  "+matchedUserId",
  "+claimedByUserId",
  "+tokenHash",
].join(" ");

const INVITATION_ADMIN_LIST_SELECTION = [
  "+contactEmail",
  "+contactFirstName",
  "+contactLastName",
  "status",
  "contactPurgeAt",
  "contactPurgedAt",
  "issueCount",
  "tokenExpiresAt",
  "lastInvitationSentAt",
  "claimedAt",
  "revision",
].join(" ");
const MAX_INVITATION_AFFILIATIONS = 50;
const MAX_INVITATION_SOURCE_BATCHES = 50;

export interface AlumniFlowActor {
  readonly id: string;
  readonly role: string;
}

export interface ApprovedRosterAffiliation {
  readonly programId?: mongoose.Types.ObjectId;
  readonly programName: string;
  readonly cohortLabel?: string | null;
  readonly sourceImportBatchId: mongoose.Types.ObjectId;
  readonly sourceRowNumber: number;
  readonly reviewedAt: Date;
  readonly reviewedBy: mongoose.Types.ObjectId;
}

export interface IssueRosterInvitationInput {
  readonly contactEmail: string;
  readonly contactFirstName?: string;
  readonly contactLastName?: string;
  readonly matchedUserId?: mongoose.Types.ObjectId;
  readonly affiliations: readonly ApprovedRosterAffiliation[];
  readonly actor: AlumniFlowActor;
  readonly correlationId?: string;
  readonly session: ClientSession;
}

export interface IssueRosterInvitationResult {
  readonly invitationId: string;
  readonly issueCount: number;
  readonly created: boolean;
}

interface ReissueResponse extends IdempotencyReplayResponseDto {
  readonly invitationId: string;
  readonly issueCount: number;
  readonly tokenExpiresAt: string;
  readonly lastInvitationSentAt: string;
  readonly revision: number;
  readonly status: "active";
}

interface ClaimResponse extends IdempotencyReplayResponseDto {
  readonly invitationId: string;
  readonly alumniProfileId: string;
  readonly affiliationIds: readonly string[];
  readonly claimedAt: string;
  readonly status: "claimed";
}

export interface ReissueAlumniInvitationInput {
  readonly invitationId: string;
  readonly expectedRevision: number;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface ClaimAlumniInvitationInput {
  readonly token: string;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

interface InvitationServiceDependencies {
  readonly now?: () => Date;
  readonly idempotency?: IdempotencyService;
  readonly outbox?: NotificationOutboxService;
}

function sameHexDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function asObjectId(value: string, unavailable = false): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    if (unavailable) throw alumniInvitationUnavailable();
    throw alumniInputError();
  }
  return new mongoose.Types.ObjectId(value);
}

function documentObjectId(document: { readonly _id: unknown }): mongoose.Types.ObjectId {
  if (document._id instanceof mongoose.Types.ObjectId) return document._id;
  const value = String(document._id);
  if (!mongoose.Types.ObjectId.isValid(value)) throw alumniInputError();
  return new mongoose.Types.ObjectId(value);
}

function documentId(document: { readonly _id: unknown }): string {
  return documentObjectId(document).toString();
}

function copyAffiliation(
  input: ApprovedRosterAffiliation,
): AlumniInvitationAffiliation {
  return {
    ...(input.programId ? { programId: input.programId } : {}),
    programName: input.programName,
    cohortLabel: input.cohortLabel ?? null,
    affiliationKey: deriveAlumniAffiliationKey(input),
    sourceImportBatchId: input.sourceImportBatchId,
    sourceRowNumber: input.sourceRowNumber,
    reviewedAt: new Date(input.reviewedAt),
    reviewedBy: input.reviewedBy,
  };
}

function affiliationIdentity(value: AlumniInvitationAffiliation): string {
  return value.programId
    ? `program:${deriveAlumniProgramAffiliationKey({
        programId: value.programId.toString(),
        cohortLabel: value.cohortLabel,
      })}`
    : `name:${value.affiliationKey}`;
}

function mergeAffiliations(
  existing: readonly AlumniInvitationAffiliation[],
  additions: readonly ApprovedRosterAffiliation[],
): AlumniInvitationAffiliation[] {
  const merged = existing.map<AlumniInvitationAffiliation>((affiliation) => ({
      ...(affiliation.programId ? { programId: affiliation.programId } : {}),
      programName: affiliation.programName,
      cohortLabel: affiliation.cohortLabel ?? null,
      affiliationKey: affiliation.affiliationKey,
      sourceImportBatchId: affiliation.sourceImportBatchId,
      sourceRowNumber: affiliation.sourceRowNumber,
      reviewedAt: new Date(affiliation.reviewedAt),
      reviewedBy: affiliation.reviewedBy,
    }));
  for (const addition of additions) {
    const candidate = copyAffiliation(addition);
    const candidateIdentity = affiliationIdentity(candidate);
    const index = merged.findIndex(
      (value) => affiliationIdentity(value) === candidateIdentity,
    );
    if (index >= 0) merged[index] = candidate;
    else merged.push(candidate);
  }
  return merged;
}

function uniqueSourceBatchIds(
  existing: readonly mongoose.Types.ObjectId[],
  affiliations: readonly ApprovedRosterAffiliation[],
): mongoose.Types.ObjectId[] {
  const values = new Map<string, mongoose.Types.ObjectId>();
  for (const id of existing) values.set(id.toString(), id);
  for (const affiliation of affiliations) {
    values.set(
      affiliation.sourceImportBatchId.toString(),
      affiliation.sourceImportBatchId,
    );
  }
  return [...values.values()];
}

function invitationTokenMaterial(invitation: IAlumniInvitation) {
  return {
    invitationId: documentId(invitation),
    issueCount: invitation.issueCount,
    issuedAt: invitation.issuedAt,
    tokenVersion: invitation.tokenVersion,
  };
}

function makeIssueFields(invitationId: string, issueCount: number, now: Date) {
  const token = deriveAlumniInvitationToken({
    invitationId,
    issueCount,
    issuedAt: now,
    tokenVersion: ALUMNI_INVITATION_TOKEN_VERSION,
  });
  return {
    issueCount,
    issuedAt: now,
    tokenExpiresAt: addFixedDays(now, INVITATION_TOKEN_LIFETIME_DAYS),
    lastInvitationSentAt: now,
    contactPurgeAt: addUtcCalendarMonths(
      now,
      INVITATION_CONTACT_RETENTION_MONTHS,
    ),
    tokenHash: hashAlumniInvitationToken(token),
  };
}

async function validateInvitation(document: IAlumniInvitation): Promise<void> {
  await document.validate();
}

export class AlumniInvitationService {
  private readonly now: () => Date;
  private readonly idempotency: IdempotencyService;
  private readonly outbox: NotificationOutboxService;

  constructor(dependencies: InvitationServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.outbox = dependencies.outbox ?? notificationOutboxService;
  }

  async listInvitations(
    input: AlumniInvitationListQuery,
  ): Promise<AlumniInvitationAdminListPageDTO> {
    const { page, limit } = input;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > ALUMNI_INVITATION_LIST_MAX_LIMIT
    ) {
      throw alumniInputError();
    }
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip)) throw alumniInputError();
    if (
      input.status !== undefined &&
      !(ALUMNI_INVITATION_STATUSES as readonly string[]).includes(input.status)
    ) {
      throw alumniInputError();
    }

    const filter: {
      status?: typeof input.status;
      sourceImportBatchIds?: mongoose.Types.ObjectId;
    } = {};
    if (input.status) filter.status = input.status;
    if (input.batchId !== undefined) {
      if (!/^[a-fA-F0-9]{24}$/.test(input.batchId)) throw alumniInputError();
      filter.sourceImportBatchIds = new mongoose.Types.ObjectId(input.batchId);
    }

    const [invitations, totalInvitations] = await Promise.all([
      AlumniInvitation.find(filter)
        .select(INVITATION_ADMIN_LIST_SELECTION)
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AlumniInvitation.countDocuments(filter),
    ]);
    const now = this.now();
    return buildAlumniInvitationAdminListPageDTO(
      {
        page,
        limit,
        totalInvitations,
        invitations: invitations.map((invitation) => ({
          id: String(invitation._id),
          status: invitation.status,
          contactEmail: invitation.contactEmail ?? null,
          contactFirstName: invitation.contactFirstName ?? null,
          contactLastName: invitation.contactLastName ?? null,
          contactPurgeAt: invitation.contactPurgeAt,
          contactPurgedAt: invitation.contactPurgedAt ?? null,
          issueCount: invitation.issueCount,
          tokenExpiresAt: invitation.tokenExpiresAt,
          lastInvitationSentAt: invitation.lastInvitationSentAt,
          claimedAt: invitation.claimedAt ?? null,
          revision: invitation.revision,
        })),
      },
      now,
    );
  }

  async issueForApprovedRoster(
    input: IssueRosterInvitationInput,
  ): Promise<IssueRosterInvitationResult> {
    if (!input.session?.inTransaction() || input.affiliations.length === 0) {
      throw alumniInputError();
    }
    let contactEmail: string;
    try {
      contactEmail = normalizeAlumniContactEmail(input.contactEmail);
    } catch {
      throw alumniInputError();
    }
    const contactLookupHash = deriveAlumniContactLookupHash(
      contactEmail,
      ALUMNI_CONTACT_LOOKUP_VERSION,
    );
    const now = this.now();
    let invitation = await AlumniInvitation.findOne({
      status: "active",
      activeContactLookupHash: contactLookupHash,
    })
      .select(INVITATION_PRIVATE_SELECTION)
      .session(input.session);

    if (
      invitation &&
      invitation.contactPurgeAt instanceof Date &&
      invitation.contactPurgeAt.getTime() <= now.getTime()
    ) {
      const expiredInvitation = invitation;
      const expectedRevision = expiredInvitation.revision;
      expiredInvitation.set({
        status: "invalidated",
        invalidatedAt: now,
        contactPurgedAt: now,
        contactEmail: undefined,
        contactFirstName: undefined,
        contactLastName: undefined,
        contactLookupHash: undefined,
        activeContactLookupHash: undefined,
        tokenHash: undefined,
        matchedUserId: undefined,
        revision: expectedRevision + 1,
      });
      await validateInvitation(expiredInvitation);
      const purged = await AlumniInvitation.updateOne(
        {
          _id: expiredInvitation._id,
          revision: expectedRevision,
          status: "active",
          activeContactLookupHash: contactLookupHash,
          contactPurgeAt: { $lte: now },
        },
        {
          $set: {
            status: "invalidated",
            invalidatedAt: now,
            contactPurgedAt: now,
            revision: expectedRevision + 1,
          },
          $unset: {
            contactEmail: "",
            contactFirstName: "",
            contactLastName: "",
            contactLookupHash: "",
            activeContactLookupHash: "",
            tokenHash: "",
            matchedUserId: "",
          },
        },
        { session: input.session, runValidators: false },
      );
      if (purged.matchedCount !== 1) {
        throw new AlumniFlowError(
          "ALUMNI_INVITATION_REVISION_CONFLICT",
          409,
          "The alumni invitation revision has changed.",
        );
      }
      await AuditLogService.recordRequiredInTransaction(
        {
          action: "alumni_invitation.contact_retention_purged",
          actor: { type: "user", id: input.actor.id, role: input.actor.role },
          source: "http",
          outcome: "success",
          target: {
            model: "AlumniInvitation",
            id: documentId(expiredInvitation),
          },
          correlationId: input.correlationId,
          details: {
            reason: "retention_expired_before_new_issue",
            fromRevision: expectedRevision,
            toRevision: expectedRevision + 1,
          },
        },
        input.session,
      );
      invitation = null;
    }

    let created = false;
    if (!invitation) {
      const invitationId = new mongoose.Types.ObjectId();
      const issueFields = makeIssueFields(invitationId.toString(), 1, now);
      invitation = new AlumniInvitation({
        _id: invitationId,
        sourceImportBatchIds: uniqueSourceBatchIds([], input.affiliations),
        contactEmail,
        contactFirstName: input.contactFirstName,
        contactLastName: input.contactLastName,
        contactLookupHash,
        activeContactLookupHash: contactLookupHash,
        contactLookupVersion: ALUMNI_CONTACT_LOOKUP_VERSION,
        ...(input.matchedUserId ? { matchedUserId: input.matchedUserId } : {}),
        affiliations: input.affiliations.map(copyAffiliation),
        status: "active",
        tokenVersion: ALUMNI_INVITATION_TOKEN_VERSION,
        ...issueFields,
        revision: 0,
      });
      await invitation.save({ session: input.session });
      created = true;
    } else {
      if (
        !invitation.contactEmail ||
        invitation.contactEmail !== contactEmail ||
        !invitation.contactLookupHash ||
        !sameHexDigest(invitation.contactLookupHash, contactLookupHash)
      ) {
        throw new AlumniFlowError(
          "ALUMNI_IMPORT_APPLICATION_CONFLICT",
          409,
          "The roster contact conflicts with an active invitation.",
        );
      }
      if (
        invitation.matchedUserId &&
        (!input.matchedUserId ||
          !invitation.matchedUserId.equals(input.matchedUserId))
      ) {
        throw new AlumniFlowError(
          "ALUMNI_IMPORT_APPLICATION_CONFLICT",
          409,
          "The roster match conflicts with an active invitation.",
        );
      }

      const expectedRevision = invitation.revision;
      const issueFields = makeIssueFields(
        documentId(invitation),
        invitation.issueCount + 1,
        now,
      );
      const sourceImportBatchIds = uniqueSourceBatchIds(
        invitation.sourceImportBatchIds,
        input.affiliations,
      );
      const affiliations = mergeAffiliations(
        invitation.affiliations,
        input.affiliations,
      );
      if (
        affiliations.length > MAX_INVITATION_AFFILIATIONS ||
        sourceImportBatchIds.length > MAX_INVITATION_SOURCE_BATCHES
      ) {
        throw new AlumniFlowError(
          "ALUMNI_IMPORT_APPLICATION_CONFLICT",
          409,
          "The active alumni invitation cannot accept more roster affiliations.",
        );
      }
      invitation.set({
        sourceImportBatchIds,
        contactFirstName:
          input.contactFirstName ?? invitation.contactFirstName,
        contactLastName: input.contactLastName ?? invitation.contactLastName,
        ...(input.matchedUserId && !invitation.matchedUserId
          ? { matchedUserId: input.matchedUserId }
          : {}),
        affiliations,
        ...issueFields,
        revision: expectedRevision + 1,
      });
      await validateInvitation(invitation);
      const update = await AlumniInvitation.updateOne(
        {
          _id: invitation._id,
          revision: expectedRevision,
          status: "active",
          activeContactLookupHash: contactLookupHash,
          contactPurgeAt: { $gt: now },
        },
        {
          $set: {
            sourceImportBatchIds: invitation.sourceImportBatchIds,
            contactFirstName: invitation.contactFirstName,
            contactLastName: invitation.contactLastName,
            matchedUserId: invitation.matchedUserId,
            affiliations: invitation.affiliations,
            ...issueFields,
            revision: expectedRevision + 1,
          },
        },
        { session: input.session, runValidators: false },
      );
      if (update.matchedCount !== 1) {
        throw new AlumniFlowError(
          "ALUMNI_INVITATION_REVISION_CONFLICT",
          409,
          "The alumni invitation revision has changed.",
        );
      }
    }

    await this.enqueueInvitationEmail(invitation, input.session, input.correlationId);
    await AuditLogService.recordRequiredInTransaction(
      {
        action: created
          ? "alumni_invitation.issued"
          : "alumni_invitation.reissued",
        actor: { type: "user", id: input.actor.id, role: input.actor.role },
        source: "http",
        outcome: "success",
        target: { model: "AlumniInvitation", id: documentId(invitation) },
        correlationId: input.correlationId,
        details: {
          issueCount: invitation.issueCount,
          affiliationCount: invitation.affiliations.length,
          sourceBatchCount: invitation.sourceImportBatchIds.length,
        },
      },
      input.session,
    );
    return {
      invitationId: documentId(invitation),
      issueCount: invitation.issueCount,
      created,
    };
  }

  async reissue(input: ReissueAlumniInvitationInput) {
    const invitationId = asObjectId(input.invitationId);
    const execution = await this.idempotency.execute<ReissueResponse>({
      scope: "alumni.invitation.reissue",
      actorKey: input.actor.id,
      key: input.idempotencyKey,
      requestPayload: {
        invitationId: invitationId.toString(),
        expectedRevision: input.expectedRevision,
      },
      execute: async (session) => {
        const invitation = await AlumniInvitation.findById(invitationId)
          .select(INVITATION_PRIVATE_SELECTION)
          .session(session);
        const now = this.now();
        if (!invitation) {
          throw new AlumniFlowError(
            "ALUMNI_INVITATION_NOT_FOUND",
            404,
            "The alumni invitation was not found.",
          );
        }
        if (
          invitation.status !== "active" ||
          invitation.contactPurgedAt ||
          invitation.contactPurgeAt.getTime() <= now.getTime() ||
          !invitation.contactEmail ||
          !invitation.contactLookupHash ||
          !invitation.activeContactLookupHash
        ) {
          throw alumniInvitationUnavailable();
        }
        if (invitation.revision !== input.expectedRevision) {
          throw new AlumniFlowError(
            "ALUMNI_INVITATION_REVISION_CONFLICT",
            409,
            "The alumni invitation revision has changed.",
          );
        }

        const expectedRevision = invitation.revision;
        const issueFields = makeIssueFields(
          documentId(invitation),
          invitation.issueCount + 1,
          now,
        );
        invitation.set({ ...issueFields, revision: expectedRevision + 1 });
        await validateInvitation(invitation);
        const updated = await AlumniInvitation.findOneAndUpdate(
          {
            _id: invitation._id,
            revision: expectedRevision,
            status: "active",
            activeContactLookupHash: invitation.activeContactLookupHash,
            contactPurgedAt: null,
            contactPurgeAt: { $gt: now },
          },
          {
            $set: { ...issueFields, revision: expectedRevision + 1 },
          },
          {
            new: true,
            session,
            runValidators: false,
          },
        ).select(INVITATION_PRIVATE_SELECTION);
        if (!updated) {
          throw new AlumniFlowError(
            "ALUMNI_INVITATION_REVISION_CONFLICT",
            409,
            "The alumni invitation revision has changed.",
          );
        }
        await validateInvitation(updated);
        await this.enqueueInvitationEmail(updated, session, input.correlationId);
        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_invitation.reissued",
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniInvitation",
              id: documentId(updated),
            },
            correlationId: input.correlationId,
            details: {
              issueCount: updated.issueCount,
              revision: updated.revision,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: {
            invitationId: documentId(updated),
            issueCount: updated.issueCount,
            tokenExpiresAt: updated.tokenExpiresAt.toISOString(),
            lastInvitationSentAt: updated.lastInvitationSentAt.toISOString(),
            revision: updated.revision,
            status: "active",
          },
          resource: {
            type: "AlumniInvitation",
            id: documentId(updated),
          },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  async claim(input: ClaimAlumniInvitationInput) {
    let submittedTokenHash: string;
    try {
      submittedTokenHash = hashAlumniInvitationToken(input.token);
    } catch {
      throw alumniInvitationUnavailable();
    }
    const actorId = asObjectId(input.actor.id, true);
    const execution = await this.idempotency.execute<ClaimResponse>({
      scope: "alumni.invitation.claim",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: { claimDigest: submittedTokenHash },
      execute: async (session) => {
        const now = this.now();
        const actor = await User.findOne({
          _id: actorId,
          isActive: true,
          isVerified: true,
        })
          .select(
            `_id email isActive isVerified ${ALUMNI_PROFILE_SEARCH_USER_PROJECTION}`,
          )
          .session(session);
        if (!actor) throw alumniInvitationUnavailable();

        const invitation = await AlumniInvitation.findOne({
          status: "active",
          tokenHash: submittedTokenHash,
          tokenExpiresAt: { $gt: now },
        })
          .select(INVITATION_PRIVATE_SELECTION)
          .session(session);
        if (
          !invitation ||
          !invitation.tokenHash ||
          !invitation.contactLookupHash ||
          !invitation.activeContactLookupHash ||
          !invitation.contactEmail ||
          !sameHexDigest(invitation.tokenHash, submittedTokenHash)
        ) {
          throw alumniInvitationUnavailable();
        }
        const reconstructedToken = deriveAlumniInvitationToken(
          invitationTokenMaterial(invitation),
        );
        if (
          !sameHexDigest(
            hashAlumniInvitationToken(reconstructedToken),
            submittedTokenHash,
          )
        ) {
          throw alumniInvitationUnavailable();
        }

        const actorContactLookupHash = deriveAlumniContactLookupHash(
          actor.email,
          invitation.contactLookupVersion,
        );
        const wasMatchedInvitation = Boolean(invitation.matchedUserId);
        const matchedIdentity = wasMatchedInvitation
          ? invitation.matchedUserId!.equals(actorId)
          : sameHexDigest(
              actorContactLookupHash,
              invitation.contactLookupHash,
            );
        if (!matchedIdentity) throw alumniInvitationUnavailable();
        const claimIdentityFilter = wasMatchedInvitation
          ? { matchedUserId: actorId }
          : {
              matchedUserId: { $exists: false },
              contactLookupHash: actorContactLookupHash,
              activeContactLookupHash: actorContactLookupHash,
            };

        const expectedRevision = invitation.revision;
        invitation.set({
          status: "claimed",
          claimedAt: now,
          claimedByUserId: actorId,
          contactPurgedAt: now,
          contactEmail: undefined,
          contactFirstName: undefined,
          contactLastName: undefined,
          contactLookupHash: undefined,
          activeContactLookupHash: undefined,
          tokenHash: undefined,
          matchedUserId: undefined,
          revision: expectedRevision + 1,
        });
        await validateInvitation(invitation);
        const claimed = await AlumniInvitation.findOneAndUpdate(
          {
            _id: invitation._id,
            revision: expectedRevision,
            status: "active",
            tokenHash: submittedTokenHash,
            tokenExpiresAt: { $gt: now },
            ...claimIdentityFilter,
          },
          {
            $set: {
              status: "claimed",
              claimedAt: now,
              claimedByUserId: actorId,
              contactPurgedAt: now,
              revision: expectedRevision + 1,
            },
            $unset: {
              contactEmail: "",
              contactFirstName: "",
              contactLastName: "",
              contactLookupHash: "",
              activeContactLookupHash: "",
              tokenHash: "",
              matchedUserId: "",
            },
          },
          { new: true, session, runValidators: false },
        ).select(INVITATION_PRIVATE_SELECTION);
        if (!claimed) throw alumniInvitationUnavailable();
        await validateInvitation(claimed);

        const profile = await this.ensureDraftProfile(actorId, session);
        const profileId = documentObjectId(profile);
        const createdByBatch = new Map<string, number>();
        let affiliationsCreated = 0;
        const affiliationIds: string[] = [];
        for (const candidate of claimed.affiliations) {
          const result = await this.upsertVerifiedAffiliation(
            profileId,
            candidate,
            session,
          );
          affiliationIds.push(result.id);
          if (!result.created) continue;
          affiliationsCreated += 1;
          const batchId = candidate.sourceImportBatchId.toString();
          createdByBatch.set(batchId, (createdByBatch.get(batchId) ?? 0) + 1);
        }
        for (const [batchId, count] of createdByBatch) {
          await AlumniImportBatch.updateOne(
            { _id: batchId },
            {
              $inc: {
                "counts.affiliationsCreated": count,
                revision: 1,
              },
            },
            { session, runValidators: false },
          );
        }

        const verifiedAffiliations = await AlumniAffiliation.find({
          alumniProfileId: profileId,
          verificationStatus: "verified",
          accountDeletionApprovedAt: null,
        })
          .select("programName cohortLabel")
          .sort({ programName: 1, cohortLabel: 1, _id: 1 })
          .session(session)
          .lean();
        const expectedProfileRevision = profile.revision;
        profile.searchProjection = buildAlumniProfileSearchProjection({
          user: actor,
          profile,
          affiliations: verifiedAffiliations,
        });
        profile.revision = expectedProfileRevision + 1;
        await profile.validate();
        const projected = await AlumniProfile.updateOne(
          { _id: profileId, userId: actorId, revision: expectedProfileRevision },
          {
            $set: {
              searchProjection: profile.searchProjection,
              revision: profile.revision,
            },
          },
          { session, runValidators: false },
        );
        if (projected.modifiedCount !== 1) {
          throw new AlumniFlowError(
            "ALUMNI_PROFILE_REVISION_CONFLICT",
            409,
            "The alumni profile revision has changed.",
          );
        }

        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_invitation.claimed",
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniInvitation",
              id: documentId(claimed),
            },
            correlationId: input.correlationId,
            details: {
              profileId: profileId.toString(),
              affiliationsCreated,
              affiliationCount: claimed.affiliations.length,
              profileRevision: profile.revision,
              revision: claimed.revision,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: {
            invitationId: documentId(claimed),
            alumniProfileId: profileId.toString(),
            affiliationIds,
            claimedAt: now.toISOString(),
            status: "claimed",
          },
          resource: {
            type: "AlumniProfile",
            id: profileId.toString(),
          },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  private async ensureDraftProfile(
    userId: mongoose.Types.ObjectId,
    session: ClientSession,
  ) {
    let profile = await AlumniProfile.findOne({ userId })
      .select("+searchProjection")
      .session(session);
    if (profile) return profile;
    profile = new AlumniProfile({ userId, publishStatus: "draft", revision: 0 });
    await profile.save({ session });
    return profile;
  }

  private async upsertVerifiedAffiliation(
    profileId: mongoose.Types.ObjectId,
    candidate: AlumniInvitationAffiliation,
    session: ClientSession,
  ): Promise<{ readonly id: string; readonly created: boolean }> {
    const affiliationKey = deriveAlumniAffiliationKey(candidate);
    const programAffiliationKey = candidate.programId
      ? deriveAlumniProgramAffiliationKey({
          programId: candidate.programId.toString(),
          cohortLabel: candidate.cohortLabel,
        })
      : undefined;
    const identity = programAffiliationKey
      ? { alumniProfileId: profileId, programAffiliationKey }
      : {
          alumniProfileId: profileId,
          programId: { $exists: false },
          affiliationKey,
        };
    const existing = await AlumniAffiliation.findOne(identity)
      .select("+programAffiliationKey")
      .session(session);
    if (!existing) {
      const affiliation = new AlumniAffiliation({
        alumniProfileId: profileId,
        ...(candidate.programId ? { programId: candidate.programId } : {}),
        programName: candidate.programName,
        cohortLabel: candidate.cohortLabel ?? null,
        affiliationKey,
        ...(programAffiliationKey ? { programAffiliationKey } : {}),
        verificationStatus: "verified",
        reviewedAt: candidate.reviewedAt,
        reviewedBy: candidate.reviewedBy,
        sourceImportBatchId: candidate.sourceImportBatchId,
        sourceRowNumber: candidate.sourceRowNumber,
        revision: 0,
      });
      await affiliation.save({ session });
      return { id: documentId(affiliation), created: true };
    }
    if (existing.verificationStatus === "verified") {
      return { id: documentId(existing), created: false };
    }
    const expectedRevision = existing.revision;
    existing.set({
      verificationStatus: "verified",
      reviewedAt: candidate.reviewedAt,
      reviewedBy: candidate.reviewedBy,
      revision: expectedRevision + 1,
    });
    await existing.validate();
    const updated = await AlumniAffiliation.updateOne(
      { _id: existing._id, revision: expectedRevision },
      {
        $set: {
          verificationStatus: "verified",
          reviewedAt: candidate.reviewedAt,
          reviewedBy: candidate.reviewedBy,
          revision: expectedRevision + 1,
        },
      },
      { session, runValidators: false },
    );
    if (updated.matchedCount !== 1) {
      throw new AlumniFlowError(
        "ALUMNI_IMPORT_APPLICATION_CONFLICT",
        409,
        "The alumni affiliation revision has changed.",
      );
    }
    return { id: documentId(existing), created: false };
  }

  private async enqueueInvitationEmail(
    invitation: IAlumniInvitation,
    session: ClientSession,
    correlationId?: string,
  ): Promise<void> {
    await this.outbox.enqueueInTransaction({
      topic: ALUMNI_INVITATION_EMAIL_TOPIC,
      dedupeKey: `alumni-invitation:${documentId(invitation)}:${invitation.issueCount}`,
      payloadVersion: ALUMNI_INVITATION_EMAIL_PAYLOAD_VERSION,
      payload: {
        invitationId: documentId(invitation),
        issueCount: invitation.issueCount,
      },
      correlationId,
      session,
    });
  }
}

export const alumniInvitationService = new AlumniInvitationService();
