import mongoose, { type ClientSession } from "mongoose";
import {
  ALUMNI_PROFILE_PUBLICATION_CONSENT,
  findAlumniProfilePublicationConsent,
} from "../../config/alumniProfilePublicationConsent";
import {
  addUtcCalendarMonths,
  CONSENT_RECORD_RETENTION_MONTHS,
} from "../../contracts/alumniDirectoryData";
import {
  buildDirectoryDetailDTO,
  buildOwnAlumniProfileDTO,
  type AlumniProfileFieldsInput,
} from "../../contracts/alumniProfileFlow";
import type {
  AlumniProfilePublishReadinessIssueDTO,
  DirectoryAffiliationDTO,
  DirectoryDetailDTO,
  OwnAlumniProfileDTO,
} from "../../contracts/userReadContracts";
import AlumniAffiliation from "../../models/AlumniAffiliation";
import AlumniProfile, { type IAlumniProfile } from "../../models/AlumniProfile";
import ConsentRecord, { type IConsentRecord } from "../../models/ConsentRecord";
import User, { type IUser } from "../../models/User";
import {
  getRegistrationProfileReadiness,
  REGISTRATION_PROFILE_READ_PROJECTION,
} from "../RegistrationProfileService";
import { AuditLogService } from "../AuditLogService";
import type { IdempotencyReplayResponseDto } from "../reliability/IdempotencyResponseContract";
import {
  IdempotencyService,
  idempotencyService,
} from "../reliability/IdempotencyService";
import {
  AlumniFlowError,
  AlumniProfileNotPublishableError,
  alumniInputError,
} from "./AlumniFlowErrors";
import type { AlumniFlowActor } from "./AlumniInvitationService";
import {
  alumniDisplayName,
  alumniGeneralLocation,
  buildAlumniProfileSearchProjection,
} from "./AlumniProfileProjectionService";
import { ensurePrivateAlumniDraft } from "./AlumniDraftProfileService";

const OWNER_USER_PROJECTION = [
  REGISTRATION_PROFILE_READ_PROJECTION,
  "username",
  "firstName",
  "lastName",
  "avatar",
  "isActive",
  "isVerified",
].join(" ");

interface AlumniProfileMutationResponse extends IdempotencyReplayResponseDto {
  readonly profileId: string;
  readonly publishStatus: "draft" | "published" | "withdrawn";
  readonly revision: number;
}

export interface AlumniProfileMutationResult
  extends AlumniProfileMutationResponse {
  readonly replayed: boolean;
}

export interface UpdateOwnAlumniProfileInput extends AlumniProfileFieldsInput {
  readonly expectedRevision: number;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface PublishOwnAlumniProfileInput {
  readonly expectedRevision: number;
  readonly consentVersion: string;
  readonly consentAccepted: true;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface WithdrawOwnAlumniProfileInput {
  readonly expectedRevision: number;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

interface AlumniProfileServiceDependencies {
  readonly now?: () => Date;
  readonly idempotency?: IdempotencyService;
}

interface OwnerAggregate {
  readonly user: IUser;
  readonly profile: IAlumniProfile;
  readonly affiliations: readonly {
    readonly _id: mongoose.Types.ObjectId;
    readonly programName: string;
    readonly cohortLabel?: string | null;
  }[];
  readonly consent: IConsentRecord | null;
}

function objectId(value: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) throw alumniInputError();
  return new mongoose.Types.ObjectId(value);
}

function profileId(profile: IAlumniProfile): string {
  return String(profile._id);
}

function profileNotFound(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_PROFILE_NOT_FOUND",
    404,
    "The alumni profile was not found.",
  );
}

function profileRevisionConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_PROFILE_REVISION_CONFLICT",
    409,
    "The alumni profile revision has changed.",
  );
}

function profileStateConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_PROFILE_STATE_CONFLICT",
    409,
    "The alumni profile is not in the required state.",
  );
}

function consentVersionConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_PROFILE_CONSENT_VERSION_INVALID",
    409,
    "The publication consent version is no longer current.",
  );
}

function directoryAffiliations(
  affiliations: OwnerAggregate["affiliations"],
): DirectoryAffiliationDTO[] {
  return affiliations.map((affiliation) => ({
    id: String(affiliation._id),
    programName: affiliation.programName,
    cohortLabel: affiliation.cohortLabel ?? null,
  }));
}

function publishReadiness(
  user: IUser,
  now = new Date(),
): {
  readonly ready: boolean;
  readonly issues: readonly AlumniProfilePublishReadinessIssueDTO[];
} {
  const registration = getRegistrationProfileReadiness(user, now);
  const issues: AlumniProfilePublishReadinessIssueDTO[] = registration.issues.map(
    (issue) => ({
      field: issue.field,
      code: issue.code,
      message: issue.message,
    }),
  );
  if (!user.isActive || !user.isVerified) {
    issues.push({
      field: "account",
      code: "account_ineligible",
      message: "An active, verified account is required.",
    });
  }
  return Object.freeze({ ready: issues.length === 0, issues: Object.freeze(issues) });
}

function toDirectorySource(aggregate: OwnerAggregate) {
  return {
    id: profileId(aggregate.profile),
    displayName: alumniDisplayName(aggregate.user),
    avatar: aggregate.user.avatar ?? null,
    professionalHeadline: aggregate.profile.professionalHeadline ?? null,
    company: aggregate.user.company ?? null,
    occupation: aggregate.user.occupation ?? null,
    generalLocation: alumniGeneralLocation(aggregate.user),
    affiliations: directoryAffiliations(aggregate.affiliations),
    helpOfferings: {
      careerAdvice: aggregate.profile.helpOfferings.careerAdvice,
      warmIntroduction: aggregate.profile.helpOfferings.warmIntroduction,
      formalEmployeeReferral:
        aggregate.profile.helpOfferings.formalEmployeeReferral,
    },
    industry: aggregate.profile.industry ?? null,
    skills: [...aggregate.profile.skills],
    bio: aggregate.profile.bio ?? null,
  };
}

function toOwnDto(aggregate: OwnerAggregate): OwnAlumniProfileDTO {
  const pointedActiveConsent =
    aggregate.profile.publishStatus === "published" &&
    aggregate.consent?.status === "active" &&
    aggregate.profile.currentPublicationConsentId?.equals(
      String(aggregate.consent._id),
    )
      ? aggregate.consent
      : null;
  const acceptedDocument = pointedActiveConsent
    ? findAlumniProfilePublicationConsent(pointedActiveConsent.consentVersion)
    : undefined;
  if (
    pointedActiveConsent &&
    (!acceptedDocument ||
      pointedActiveConsent.documentHash !== acceptedDocument.documentHash)
  ) {
    throw new AlumniFlowError(
      "ALUMNI_PROFILE_CONSENT_EVIDENCE_INVALID",
      500,
      "The publication consent evidence is invalid.",
    );
  }
  const hasCurrentPublicationConsent = Boolean(
    pointedActiveConsent?.consentVersion ===
      ALUMNI_PROFILE_PUBLICATION_CONSENT.version &&
      pointedActiveConsent.documentHash ===
        ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
  );
  return buildOwnAlumniProfileDTO({
    ...toDirectorySource(aggregate),
    publishStatus: aggregate.profile.publishStatus,
    consentVersion: pointedActiveConsent?.consentVersion ?? null,
    hasCurrentPublicationConsent,
    acceptedPublicationConsent:
      pointedActiveConsent && acceptedDocument
        ? {
            version: acceptedDocument.version,
            text: acceptedDocument.text,
            documentHash: acceptedDocument.documentHash,
            effectiveAt: acceptedDocument.effectiveAt,
            acceptedAt: pointedActiveConsent.acceptedAt,
          }
        : null,
    publishReadiness: publishReadiness(aggregate.user),
    revision: aggregate.profile.revision,
    publishedAt: aggregate.profile.publishedAt ?? null,
    withdrawnAt: aggregate.profile.withdrawnAt ?? null,
    updatedAt: aggregate.profile.updatedAt ?? null,
  });
}

function responseFor(profile: IAlumniProfile): AlumniProfileMutationResponse {
  return Object.freeze({
    profileId: profileId(profile),
    publishStatus: profile.publishStatus,
    revision: profile.revision,
  });
}

export class AlumniProfileService {
  private readonly now: () => Date;
  private readonly idempotency: IdempotencyService;

  constructor(dependencies: AlumniProfileServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.idempotency = dependencies.idempotency ?? idempotencyService;
  }

  async getOwn(userId: string): Promise<OwnAlumniProfileDTO> {
    return toOwnDto(await this.loadOwnerAggregate(objectId(userId)));
  }

  async ensureOwnDraft(userId: string): Promise<OwnAlumniProfileDTO> {
    const id = objectId(userId);
    const user = await User.findOne({ _id: id, isActive: true, isVerified: true })
      .select(OWNER_USER_PROJECTION);
    if (!user) throw profileNotFound();
    const readiness = publishReadiness(user);
    if (!readiness.ready) throw new AlumniProfileNotPublishableError(readiness.issues);
    await ensurePrivateAlumniDraft(user);
    return this.getOwn(userId);
  }

  async previewOwn(userId: string): Promise<DirectoryDetailDTO> {
    return buildDirectoryDetailDTO(
      toDirectorySource(await this.loadOwnerAggregate(objectId(userId))),
    );
  }

  async updateOwn(
    input: UpdateOwnAlumniProfileInput,
  ): Promise<AlumniProfileMutationResult> {
    const actorId = objectId(input.actor.id);
    const fields = this.profileFields(input);
    const execution = await this.idempotency.execute<AlumniProfileMutationResponse>({
      scope: "alumni.profile.update",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: { expectedRevision: input.expectedRevision, fields },
      execute: async (session) => {
        const aggregate = await this.loadOwnerAggregate(actorId, session);
        const profile = aggregate.profile;
        if (profile.revision !== input.expectedRevision) {
          throw profileRevisionConflict();
        }

        profile.set(fields);
        profile.searchProjection = buildAlumniProfileSearchProjection({
          user: aggregate.user,
          profile,
          affiliations: aggregate.affiliations,
        });
        profile.revision = input.expectedRevision + 1;
        await profile.validate();

        const updated = await AlumniProfile.findOneAndUpdate(
          {
            _id: profile._id,
            userId: actorId,
            revision: input.expectedRevision,
          },
          {
            $set: {
              professionalHeadline: profile.professionalHeadline ?? null,
              industry: profile.industry ?? null,
              skills: [...profile.skills],
              bio: profile.bio ?? null,
              helpOfferings: { ...profile.helpOfferings },
              searchProjection: profile.searchProjection,
              revision: profile.revision,
            },
          },
          { new: true, session, runValidators: false },
        ).select("+searchProjection");
        if (!updated) throw profileRevisionConflict();

        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_profile.updated",
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: { model: "AlumniProfile", id: profileId(updated) },
            correlationId: input.correlationId,
            details: {
              changedFields: Object.keys(fields).sort(),
              fromRevision: input.expectedRevision,
              toRevision: updated.revision,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: responseFor(updated),
          resource: { type: "AlumniProfile", id: profileId(updated) },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  async publishOwn(
    input: PublishOwnAlumniProfileInput,
  ): Promise<AlumniProfileMutationResult> {
    const actorId = objectId(input.actor.id);
    if (
      input.consentAccepted !== true ||
      input.consentVersion !== ALUMNI_PROFILE_PUBLICATION_CONSENT.version
    ) {
      throw consentVersionConflict();
    }
    const execution = await this.idempotency.execute<AlumniProfileMutationResponse>({
      scope: "alumni.profile.publish",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: {
        expectedRevision: input.expectedRevision,
        consentVersion: input.consentVersion,
        consentAccepted: true,
      },
      execute: async (session) => {
        const aggregate = await this.loadOwnerAggregate(actorId, session);
        const profile = aggregate.profile;
        if (profile.revision !== input.expectedRevision) {
          throw profileRevisionConflict();
        }
        const now = this.now();
        const readiness = publishReadiness(aggregate.user, now);
        if (!readiness.ready) {
          throw new AlumniProfileNotPublishableError(readiness.issues);
        }
        if (profile.accountDeletionApprovedAt || profile.purgeAt) {
          throw new AlumniProfileNotPublishableError([
            {
              field: "account",
              code: "account_deletion_scheduled",
              message: "A profile scheduled for deletion cannot be published.",
            },
          ]);
        }

        if (
          profile.publishStatus === "published" &&
          aggregate.consent?.status === "active" &&
          aggregate.consent.consentVersion ===
            ALUMNI_PROFILE_PUBLICATION_CONSENT.version &&
          aggregate.consent.documentHash ===
            ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash &&
          profile.currentPublicationConsentId?.equals(
            String(aggregate.consent._id),
          )
        ) {
          return {
            httpStatus: 200,
            response: responseFor(profile),
            resource: { type: "AlumniProfile", id: profileId(profile) },
          };
        }

        const replacement = new ConsentRecord({
          _id: new mongoose.Types.ObjectId(),
          subjectUserId: actorId,
          alumniProfileId: profile._id,
          purpose: "alumni_profile_publication",
          consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
          documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
          status: "active",
          acceptedAt: now,
          revision: 0,
        });

        if (aggregate.consent) {
          const prior = aggregate.consent;
          const priorRevision = prior.revision;
          prior.set({
            status: "superseded",
            supersededAt: now,
            supersededByConsentId: replacement._id,
            purgeAt: addUtcCalendarMonths(
              now,
              CONSENT_RECORD_RETENTION_MONTHS,
            ),
            revision: priorRevision + 1,
          });
          await prior.validate();
          const ended = await ConsentRecord.updateOne(
            { _id: prior._id, status: "active", revision: priorRevision },
            {
              $set: {
                status: prior.status,
                supersededAt: prior.supersededAt,
                supersededByConsentId: prior.supersededByConsentId,
                purgeAt: prior.purgeAt,
                revision: prior.revision,
              },
            },
            { session, runValidators: false },
          );
          if (ended.modifiedCount !== 1) throw profileRevisionConflict();
        }
        await replacement.save({ session });

        profile.set({
          publishStatus: "published",
          currentPublicationConsentId: replacement._id,
          publishedAt:
            profile.publishStatus === "published" && profile.publishedAt
              ? profile.publishedAt
              : now,
          withdrawnAt: null,
          searchProjection: buildAlumniProfileSearchProjection({
            user: aggregate.user,
            profile,
            affiliations: aggregate.affiliations,
          }),
          revision: input.expectedRevision + 1,
        });
        await profile.validate();
        const updated = await AlumniProfile.findOneAndUpdate(
          {
            _id: profile._id,
            userId: actorId,
            revision: input.expectedRevision,
          },
          {
            $set: {
              publishStatus: profile.publishStatus,
              currentPublicationConsentId: profile.currentPublicationConsentId,
              publishedAt: profile.publishedAt,
              withdrawnAt: null,
              searchProjection: profile.searchProjection,
              revision: profile.revision,
            },
          },
          { new: true, session, runValidators: false },
        ).select("+searchProjection");
        if (!updated) throw profileRevisionConflict();

        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_profile.published",
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: { model: "AlumniProfile", id: profileId(updated) },
            correlationId: input.correlationId,
            details: {
              consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
              fromRevision: input.expectedRevision,
              toRevision: updated.revision,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: responseFor(updated),
          resource: { type: "AlumniProfile", id: profileId(updated) },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  async withdrawOwn(
    input: WithdrawOwnAlumniProfileInput,
  ): Promise<AlumniProfileMutationResult> {
    const actorId = objectId(input.actor.id);
    const execution = await this.idempotency.execute<AlumniProfileMutationResponse>({
      scope: "alumni.profile.withdraw",
      actorKey: actorId.toString(),
      key: input.idempotencyKey,
      requestPayload: { expectedRevision: input.expectedRevision },
      execute: async (session) => {
        const aggregate = await this.loadOwnerAggregate(actorId, session);
        const profile = aggregate.profile;
        if (profile.revision !== input.expectedRevision) {
          throw profileRevisionConflict();
        }
        if (profile.publishStatus === "withdrawn") {
          return {
            httpStatus: 200,
            response: responseFor(profile),
            resource: { type: "AlumniProfile", id: profileId(profile) },
          };
        }
        if (profile.publishStatus !== "published") throw profileStateConflict();

        const now = this.now();
        if (aggregate.consent) {
          const consent = aggregate.consent;
          const consentRevision = consent.revision;
          consent.set({
            status: "withdrawn",
            withdrawnAt: now,
            purgeAt: addUtcCalendarMonths(
              now,
              CONSENT_RECORD_RETENTION_MONTHS,
            ),
            revision: consentRevision + 1,
          });
          await consent.validate();
          const withdrawn = await ConsentRecord.updateOne(
            { _id: consent._id, status: "active", revision: consentRevision },
            {
              $set: {
                status: consent.status,
                withdrawnAt: consent.withdrawnAt,
                purgeAt: consent.purgeAt,
                revision: consent.revision,
              },
            },
            { session, runValidators: false },
          );
          if (withdrawn.modifiedCount !== 1) throw profileRevisionConflict();
        }

        profile.set({
          publishStatus: "withdrawn",
          currentPublicationConsentId: undefined,
          withdrawnAt: now,
          revision: input.expectedRevision + 1,
        });
        await profile.validate();
        const updated = await AlumniProfile.findOneAndUpdate(
          {
            _id: profile._id,
            userId: actorId,
            revision: input.expectedRevision,
          },
          {
            $set: {
              publishStatus: profile.publishStatus,
              withdrawnAt: profile.withdrawnAt,
              revision: profile.revision,
            },
            $unset: { currentPublicationConsentId: 1 },
          },
          { new: true, session, runValidators: false },
        ).select("+searchProjection");
        if (!updated) throw profileRevisionConflict();

        await AuditLogService.recordRequiredInTransaction(
          {
            action: "alumni_profile.withdrawn",
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: { model: "AlumniProfile", id: profileId(updated) },
            correlationId: input.correlationId,
            details: {
              consentTerminated: Boolean(aggregate.consent),
              fromRevision: input.expectedRevision,
              toRevision: updated.revision,
            },
          },
          session,
        );
        return {
          httpStatus: 200,
          response: responseFor(updated),
          resource: { type: "AlumniProfile", id: profileId(updated) },
        };
      },
    });
    return Object.freeze({ replayed: execution.replayed, ...execution.response! });
  }

  private profileFields(input: AlumniProfileFieldsInput): AlumniProfileFieldsInput {
    const fields: {
      professionalHeadline?: string | null;
      industry?: string | null;
      skills?: readonly string[];
      bio?: string | null;
      helpOfferings?: AlumniProfileFieldsInput["helpOfferings"];
    } = {};
    if (Object.prototype.hasOwnProperty.call(input, "professionalHeadline")) {
      fields.professionalHeadline = input.professionalHeadline;
    }
    if (Object.prototype.hasOwnProperty.call(input, "industry")) {
      fields.industry = input.industry;
    }
    if (Object.prototype.hasOwnProperty.call(input, "skills")) {
      fields.skills = input.skills ? [...input.skills] : [];
    }
    if (Object.prototype.hasOwnProperty.call(input, "bio")) {
      fields.bio = input.bio;
    }
    if (Object.prototype.hasOwnProperty.call(input, "helpOfferings")) {
      fields.helpOfferings = input.helpOfferings
        ? { ...input.helpOfferings }
        : undefined;
    }
    return Object.freeze(fields);
  }

  private async loadOwnerAggregate(
    userId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<OwnerAggregate> {
    const userQuery = User.findOne({
      _id: userId,
      isActive: true,
      isVerified: true,
    }).select(OWNER_USER_PROJECTION);
    const profileQuery = AlumniProfile.findOne({ userId }).select(
      "+searchProjection",
    );
    let user: IUser | null;
    let profile: IAlumniProfile | null;
    if (session) {
      // MongoDB does not support parallel operations on one transaction session.
      user = await userQuery.session(session);
      profile = await profileQuery.session(session);
    } else {
      [user, profile] = await Promise.all([userQuery, profileQuery]);
    }
    if (!user || !profile) throw profileNotFound();

    const affiliationQuery = AlumniAffiliation.find({
      alumniProfileId: profile._id,
      verificationStatus: "verified",
      accountDeletionApprovedAt: null,
    })
      .select("programName cohortLabel")
      .sort({ programName: 1, cohortLabel: 1, _id: 1 });
    if (session) affiliationQuery.session(session);
    const affiliations = await affiliationQuery.lean<OwnerAggregate["affiliations"]>();

    const consentQuery = ConsentRecord.findOne({
      subjectUserId: userId,
      alumniProfileId: profile._id,
      purpose: "alumni_profile_publication",
      status: "active",
    });
    if (session) consentQuery.session(session);
    const consent: IConsentRecord | null = await consentQuery;
    return { user, profile, affiliations, consent };
  }
}

export const alumniProfileService = new AlumniProfileService();
