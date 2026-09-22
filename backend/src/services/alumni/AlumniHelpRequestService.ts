import mongoose, { type ClientSession } from "mongoose";
import {
  ALUMNI_HELP_TERMS,
  findAlumniHelpConsent,
  findAlumniHelpDisclaimer,
  type AlumniHelpTermDocument,
} from "../../config/alumniHelpTerms";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../config/alumniProfilePublicationConsent";
import {
  ALUMNI_HELP_TRANSITIONS,
  ALUMNI_HELP_TYPES,
  acceptedHelpRequestPurgeAt,
  alumniHelpRoomGraceEndsAt,
  buildAlumniHelpTermsDTO,
  helpOutcomeDueAt,
  isAlumniHelpOutcomeCodeForType,
  neverAcceptedHelpRequestPurgeAt,
  type AlumniHelpActionRequiredCountDTO,
  type AlumniHelpAvailableAction,
  type AlumniHelpLifecycleEventDTO,
  type AlumniHelpOutcomeCode,
  type AlumniHelpOutcomeDTO,
  type AlumniHelpParticipantRole,
  type AlumniHelpRequestDataDTO,
  type AlumniHelpRequestDTO,
  type AlumniHelpRequestListDataDTO,
  type AlumniHelpRequestSummaryDTO,
  type AlumniHelpTermsDTO,
  type AlumniHelpType,
  type CreateHelpRequestBody,
  type HelpRequestListQuery,
  type HelpTransitionAction,
} from "../../contracts/alumniHelpFlow";
import AlumniHelpOutcomeSubmission, {
  type IAlumniHelpOutcomeSubmission,
} from "../../models/AlumniHelpOutcomeSubmission";
import AlumniHelpRequest, {
  type AlumniHelpLifecycleEvent,
  type IAlumniHelpRequest,
} from "../../models/AlumniHelpRequest";
import AlumniProfile, { type IAlumniProfile } from "../../models/AlumniProfile";
import ConsentRecord from "../../models/ConsentRecord";
import User, { type IUser } from "../../models/User";
import { AuditLogService } from "../AuditLogService";
import type { IdempotencyReplayResponseDto } from "../reliability/IdempotencyResponseContract";
import {
  IdempotencyService,
  idempotencyService,
} from "../reliability/IdempotencyService";
import {
  buildAlumniHelpActionRequiredFilter,
} from "./AlumniHelpActionCountService";
import {
  alumniHelpNotificationCountService,
  buildAlumniHelpNotificationFilter,
  hasUnreadHelpUpdate,
  helpUpdateMarkers,
  type AlumniHelpNotificationCountsReader,
} from "./AlumniHelpNotificationCountService";
import {
  enqueueAlumniHelpWorkflowNotifications,
  type AlumniHelpWorkflowEventType,
} from "./AlumniHelpWorkflowDeliveryHandler";
import {
  AlumniFlowError,
  alumniInputError,
  isAlumniFlowError,
} from "./AlumniFlowErrors";
import type { AlumniFlowActor } from "./AlumniFlowActor";
import {
  alumniDisplayName,
} from "./AlumniProfileProjectionService";
import {
  AlumniHelpRoomProvisioner,
  alumniHelpRoomProvisioner,
} from "./AlumniHelpRoomProvisioner";

interface HelpMutationReceipt extends IdempotencyReplayResponseDto {
  readonly requestId: string;
}

export interface CreateAlumniHelpRequestInput extends CreateHelpRequestBody {
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface TransitionAlumniHelpRequestInput {
  readonly requestId: string;
  readonly action: HelpTransitionAction;
  readonly expectedRevision: number;
  readonly note?: string;
  readonly proposedHelpType?: AlumniHelpType;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface SubmitAlumniHelpOutcomeInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly outcomeCode: AlumniHelpOutcomeCode;
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

export interface DecideAlumniHelpOutcomeInput {
  readonly requestId: string;
  readonly outcomeId: string;
  readonly expectedRevision: number;
  readonly decision: "confirm" | "deny";
  readonly actor: AlumniFlowActor;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

interface AlumniHelpRequestServiceDependencies {
  readonly now?: () => Date;
  readonly idempotency?: IdempotencyService;
  readonly notificationCounts?: AlumniHelpNotificationCountsReader;
  readonly roomProvisioner?: AlumniHelpRoomProvisioner;
}

interface EligibleProvider {
  readonly profile: IAlumniProfile;
  readonly user: IUser;
}

interface ArchivedHelpTerms {
  readonly consent: AlumniHelpTermDocument;
  readonly disclaimer: AlumniHelpTermDocument;
}

function requestNotFound(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_REQUEST_NOT_FOUND",
    404,
    "The alumni help request was not found.",
  );
}

function requestRevisionConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_REQUEST_REVISION_CONFLICT",
    409,
    "The alumni help request revision changed.",
  );
}

function requestStateConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_REQUEST_STATE_CONFLICT",
    409,
    "The alumni help request is not in the required state.",
  );
}

function duplicateRequest(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_REQUEST_DUPLICATE",
    409,
    "An active request for this help offering already exists.",
  );
}

function offeringUnavailable(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_OFFERING_UNAVAILABLE",
    409,
    "The selected alumni help offering is unavailable.",
  );
}

function termsVersionInvalid(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_TERMS_VERSION_INVALID",
    409,
    "The alumni help terms are no longer current.",
  );
}

function outcomeNotFound(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_OUTCOME_NOT_FOUND",
    404,
    "The reported alumni help outcome was not found.",
  );
}

function outcomeRevisionConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_OUTCOME_REVISION_CONFLICT",
    409,
    "The reported alumni help outcome revision changed.",
  );
}

function outcomeStateConflict(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_OUTCOME_STATE_CONFLICT",
    409,
    "The reported alumni help outcome is not in the required state.",
  );
}

function outcomeDeadlinePassed(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_HELP_OUTCOME_DEADLINE_PASSED",
    409,
    "The provider confirmation deadline has passed.",
  );
}

function toObjectId(value: string, missing = false): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    if (missing) throw requestNotFound();
    throw alumniInputError();
  }
  return new mongoose.Types.ObjectId(value);
}

function toOutcomeObjectId(value: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) throw outcomeNotFound();
  return new mongoose.Types.ObjectId(value);
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000,
  );
}

function offeringEnabled(profile: IAlumniProfile, type: AlumniHelpType): boolean {
  const key = {
    career_advice: "careerAdvice",
    warm_introduction: "warmIntroduction",
    formal_employee_referral: "formalEmployeeReferral",
  }[type] as keyof IAlumniProfile["helpOfferings"];
  return profile.helpOfferings[key] === true;
}

function enabledOfferings(profile: IAlumniProfile): AlumniHelpType[] {
  return ALUMNI_HELP_TYPES.filter((type) => offeringEnabled(profile, type));
}

function participantRole(
  request: IAlumniHelpRequest,
  actorId: mongoose.Types.ObjectId,
): AlumniHelpParticipantRole {
  if (request.requesterId.equals(actorId)) return "requester";
  if (request.providerId.equals(actorId)) return "provider";
  throw requestNotFound();
}

function actionRequiredFor(
  request: IAlumniHelpRequest,
  role: AlumniHelpParticipantRole,
): boolean {
  return (
    (role === "provider" && request.status === "requested") ||
    (role === "requester" && request.status === "needs_information") ||
    (role === "requester" && request.status === "alternative_proposed") ||
    (role === "provider" && request.latestOutcomeStatus === "pending") ||
    (role === "requester" && request.latestOutcomeStatus === "denied")
  );
}

function availableActions(
  request: IAlumniHelpRequest,
  role: AlumniHelpParticipantRole,
): AlumniHelpAvailableAction[] {
  const actions: AlumniHelpAvailableAction[] = [];
  if (role === "provider" && request.status === "requested") {
    actions.push("request_information", "propose_alternative", "accept", "decline");
  }
  if (role === "requester" && request.status === "needs_information") {
    actions.push("provide_information");
  }
  if (role === "requester" && request.status === "alternative_proposed") {
    actions.push("confirm_alternative", "reject_alternative");
  }
  if (
    role === "requester" &&
    ["requested", "needs_information", "alternative_proposed"].includes(
      request.status,
    )
  ) {
    actions.push("withdraw");
  }
  if (role === "provider" && request.status === "accepted") {
    actions.push("start", "complete");
  }
  if (role === "provider" && request.status === "in_progress") {
    actions.push("complete");
  }
  if (["accepted", "in_progress", "completed"].includes(request.status)) {
    actions.push("close");
  }
  if (request.hasBeenAccepted) {
    if (role === "requester" && !request.latestOutcomeStatus) {
      actions.push("submit_outcome");
    } else if (role === "requester" && request.latestOutcomeStatus === "denied") {
      actions.push("resubmit_outcome");
    } else if (role === "provider" && request.latestOutcomeStatus === "pending") {
      actions.push("confirm_outcome", "deny_outcome");
    }
  }
  return actions;
}

function outcomeDto(outcome: IAlumniHelpOutcomeSubmission): AlumniHelpOutcomeDTO {
  return Object.freeze({
    id: String(outcome._id),
    revisionNumber: outcome.revisionNumber,
    previousSubmissionId: outcome.previousSubmissionId
      ? String(outcome.previousSubmissionId)
      : null,
    agreedHelpType: outcome.agreedHelpType,
    outcomeCode: outcome.outcomeCode,
    status: outcome.status,
    submittedAt: outcome.submittedAt.toISOString(),
    dueAt: outcome.dueAt.toISOString(),
    decidedAt: outcome.decidedAt?.toISOString() ?? null,
    confirmationMethod: outcome.confirmationMethod ?? null,
    revision: outcome.revision,
  });
}

function timelineDto(event: AlumniHelpLifecycleEvent): AlumniHelpLifecycleEventDTO {
  return Object.freeze({
    id: String(event._id),
    sequence: event.sequence,
    action: event.action,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus,
    actorRole: event.actorRole,
    note: event.note ?? null,
    helpType: event.helpType ?? null,
    occurredAt: event.occurredAt.toISOString(),
  });
}

function summaryDto(
  request: IAlumniHelpRequest,
  actorId: mongoose.Types.ObjectId,
  latestOutcome: IAlumniHelpOutcomeSubmission | null,
): AlumniHelpRequestSummaryDTO {
  const role = participantRole(request, actorId);
  return Object.freeze({
    id: String(request._id),
    requester: Object.freeze({
      id: String(request.requesterId),
      displayName: request.requesterSnapshot.displayName,
      avatar: request.requesterSnapshot.avatar ?? null,
    }),
    provider: Object.freeze({
      id: String(request.providerId),
      displayName: request.providerSnapshot.displayName,
      avatar: request.providerSnapshot.avatar ?? null,
    }),
    status: request.status,
    requestedHelpType: request.requestedHelpType,
    proposedHelpType: request.proposedHelpType ?? null,
    agreedHelpType: request.agreedHelpType ?? null,
    conversationId: request.conversationId ? String(request.conversationId) : null,
    viewerRole: role,
    actionRequiredForViewer: actionRequiredFor(request, role),
    hasUnreadUpdate: hasUnreadHelpUpdate(request, role),
    availableActions: availableActions(request, role),
    latestOutcome: latestOutcome ? outcomeDto(latestOutcome) : null,
    revision: request.revision,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    closedAt: request.closedAt?.toISOString() ?? null,
  });
}

export class AlumniHelpRequestService {
  private readonly now: () => Date;
  private readonly idempotency: IdempotencyService;
  private readonly notificationCounts: AlumniHelpNotificationCountsReader;
  private readonly roomProvisioner: AlumniHelpRoomProvisioner;

  constructor(dependencies: AlumniHelpRequestServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.idempotency = dependencies.idempotency ?? idempotencyService;
    this.notificationCounts =
      dependencies.notificationCounts ?? alumniHelpNotificationCountService;
    this.roomProvisioner = dependencies.roomProvisioner ?? alumniHelpRoomProvisioner;
  }

  terms(): AlumniHelpTermsDTO {
    return buildAlumniHelpTermsDTO();
  }

  async actionRequiredCount(userId: string): Promise<AlumniHelpActionRequiredCountDTO> {
    return this.notificationCounts.countsForUser(userId);
  }

  async markRead(
    userId: string,
    requestId: string,
    observedRevision: number,
  ): Promise<AlumniHelpActionRequiredCountDTO> {
    if (
      !Number.isSafeInteger(observedRevision) ||
      observedRevision < 0 ||
      observedRevision >= Number.MAX_SAFE_INTEGER
    ) throw alumniInputError();
    const actorId = toObjectId(userId);
    const request = await this.loadParticipantRequest(
      toObjectId(requestId, true), actorId,
    );
    if (observedRevision > request.revision) throw requestRevisionConflict();
    const role = participantRole(request, actorId);
    const updated = await AlumniHelpRequest.updateOne(
      {
        _id: request._id,
        [`${role}Id`]: actorId,
        revision: { $gte: observedRevision },
        $or: [{ purgeAt: null }, { purgeAt: { $gt: this.requireNow() } }],
      },
      { $max: { [`${role}ReadSequence`]: observedRevision + 1 } },
      // Viewing an update must not reorder requests or change its business revision.
      { timestamps: false },
    );
    if (updated.matchedCount !== 1) throw requestNotFound();
    return this.actionRequiredCount(userId);
  }

  async list(
    userId: string,
    query: HelpRequestListQuery,
  ): Promise<AlumniHelpRequestListDataDTO> {
    const actorId = toObjectId(userId);
    const now = this.requireNow();
    const participantFilter = {
      $or: [{ requesterId: actorId }, { providerId: actorId }],
    };
    const retainedFilter = {
      $or: [{ purgeAt: null }, { purgeAt: { $gt: now } }],
    };
    const filter: Record<string, unknown> = (() => {
      if (query.view === "updates") {
        return { ...buildAlumniHelpNotificationFilter(userId, now) };
      }
      if (query.view === "action_required") {
        return {
          $and: [
            participantFilter,
            retainedFilter,
            buildAlumniHelpActionRequiredFilter(userId, now),
          ],
        };
      }
      if (query.view === "received") {
        return { $and: [{ providerId: actorId }, retainedFilter] };
      }
      if (query.view === "sent") {
        return { $and: [{ requesterId: actorId }, retainedFilter] };
      }
      return {
        $and: [
          participantFilter,
          retainedFilter,
          { status: { $in: ["declined", "withdrawn", "completed", "closed"] } },
        ],
      };
    })();
    const skip = (query.page - 1) * query.limit;
    const [requests, totalCount, counts] = await Promise.all([
      AlumniHelpRequest.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.limit)
        .exec(),
      AlumniHelpRequest.countDocuments(filter),
      this.actionRequiredCount(userId),
    ]);
    const outcomeIds = requests.flatMap((request) =>
      request.latestOutcomeSubmissionId ? [request.latestOutcomeSubmissionId] : [],
    );
    const latestOutcomes = outcomeIds.length
      ? await AlumniHelpOutcomeSubmission.find({
          _id: { $in: outcomeIds },
          $or: [{ purgeAt: null }, { purgeAt: { $gt: now } }],
        }).exec()
      : [];
    const outcomesById = new Map(
      latestOutcomes.map((outcome) => [String(outcome._id), outcome]),
    );
    const totalPages = Math.ceil(totalCount / query.limit);
    return Object.freeze({
      requests: requests.map((request) =>
        summaryDto(
          request,
          actorId,
          request.latestOutcomeSubmissionId
            ? outcomesById.get(String(request.latestOutcomeSubmissionId)) ?? null
            : null,
        ),
      ),
      pagination: Object.freeze({
        currentPage: query.page,
        totalPages,
        totalCount,
        hasNext: query.page < totalPages,
        hasPrev: query.page > 1,
      }),
      ...counts,
    });
  }

  async get(userId: string, requestId: string): Promise<AlumniHelpRequestDataDTO> {
    const actorId = toObjectId(userId);
    const request = await this.loadParticipantRequest(
      toObjectId(requestId, true),
      actorId,
      undefined,
      true,
    );
    const outcomes = await AlumniHelpOutcomeSubmission.find({
      helpRequestId: request._id,
      $or: [
        { purgeAt: null },
        { purgeAt: { $gt: this.requireNow() } },
      ],
    })
      .sort({ revisionNumber: 1, _id: 1 })
      .exec();
    const latest = request.latestOutcomeSubmissionId
      ? outcomes.find((outcome) =>
          outcome._id.equals(request.latestOutcomeSubmissionId!),
        ) ?? null
      : null;
    const role = participantRole(request, actorId);
    const actions = availableActions(request, role);
    let availableAlternativeHelpTypes: AlumniHelpType[] = [];
    if (role === "provider" && actions.includes("propose_alternative")) {
      try {
        const provider = await this.loadEligibleProvider(request.alumniProfileId);
        availableAlternativeHelpTypes = enabledOfferings(provider.profile).filter(
          (type) => type !== request.requestedHelpType,
        );
      } catch (error) {
        if (
          isAlumniFlowError(error) &&
          error.code === "ALUMNI_HELP_OFFERING_UNAVAILABLE"
        ) {
          availableAlternativeHelpTypes = [];
        } else {
          throw error;
        }
      }
    }
    const summary = summaryDto(request, actorId, latest);
    const acceptedTerms = this.assertRequestTermsKnown(request);
    const dto: AlumniHelpRequestDTO = Object.freeze({
      ...summary,
      alumniProfileId: String(request.alumniProfileId),
      openingNote: request.openingNote ?? null,
      lifecycleTimeline: request.lifecycleTimeline.map(timelineDto),
      outcomes: outcomes.map(outcomeDto),
      availableAlternativeHelpTypes,
      acceptedAt: request.acceptedAt?.toISOString() ?? null,
      declinedAt: request.declinedAt?.toISOString() ?? null,
      withdrawnAt: request.withdrawnAt?.toISOString() ?? null,
      startedAt: request.startedAt?.toISOString() ?? null,
      completedAt: request.completedAt?.toISOString() ?? null,
      closedAt: request.closedAt?.toISOString() ?? null,
      termsAcceptedAt: request.termsAcceptedAt.toISOString(),
      acceptedTerms: Object.freeze({
        consent: Object.freeze({
          version: acceptedTerms.consent.version,
          text: acceptedTerms.consent.text,
          effectiveAt: acceptedTerms.consent.effectiveAt,
        }),
        disclaimer: Object.freeze({
          version: acceptedTerms.disclaimer.version,
          text: acceptedTerms.disclaimer.text,
          effectiveAt: acceptedTerms.disclaimer.effectiveAt,
        }),
      }),
    });
    return Object.freeze({
      request: dto,
      ...(await this.actionRequiredCount(userId)),
    });
  }

  async create(input: CreateAlumniHelpRequestInput): Promise<AlumniHelpRequestDataDTO> {
    const requesterId = toObjectId(input.actor.id);
    let execution;
    try {
      execution = await this.idempotency.execute<HelpMutationReceipt>({
        scope: "alumni.help.create",
        actorKey: input.actor.id,
        key: input.idempotencyKey,
        requestPayload: {
          alumniProfileId: input.alumniProfileId,
          requestedHelpType: input.requestedHelpType,
          openingNote: input.openingNote ?? null,
          consentVersion: input.consentVersion,
          consentAccepted: input.consentAccepted,
          disclaimerVersion: input.disclaimerVersion,
          disclaimerAccepted: input.disclaimerAccepted,
        },
        execute: async (session) => {
          // Keep time-varying policy checks inside the idempotent callback. A
          // retry of an already-committed request must replay its receipt even
          // if a later deployment has advanced the current terms version.
          this.assertCurrentTerms(
            input.consentVersion,
            input.disclaimerVersion,
          );
          const now = this.requireNow();
          const provider = await this.loadEligibleProvider(
            toObjectId(input.alumniProfileId),
            session,
          );
          if (!offeringEnabled(provider.profile, input.requestedHelpType)) {
            throw offeringUnavailable();
          }
          if (provider.profile.userId.equals(requesterId)) throw alumniInputError();
          const requester = await User.findOne({
            _id: requesterId,
            isActive: true,
            isVerified: true,
          })
            .select("_id username firstName lastName avatar")
            .session(session);
          if (!requester) throw alumniInputError();
          const requestId = new mongoose.Types.ObjectId();
          const timelineEventId = new mongoose.Types.ObjectId();
          const request = new AlumniHelpRequest({
            _id: requestId,
            requesterId,
            providerId: provider.profile.userId,
            alumniProfileId: provider.profile._id,
            requesterSnapshot: {
              displayName: alumniDisplayName(requester),
              avatar: requester.avatar ?? null,
            },
            providerSnapshot: {
              displayName: alumniDisplayName(provider.user),
              avatar: provider.user.avatar ?? null,
            },
            requestedHelpType: input.requestedHelpType,
            proposedHelpType: null,
            agreedHelpType: null,
            openingNote: input.openingNote ?? null,
            consentVersion: ALUMNI_HELP_TERMS.consent.version,
            consentDocumentHash: ALUMNI_HELP_TERMS.consent.documentHash,
            disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
            disclaimerDocumentHash: ALUMNI_HELP_TERMS.disclaimer.documentHash,
            termsAcceptedAt: now,
            status: "requested",
            hasBeenAccepted: false,
            activeUniqueness: true,
            lifecycleTimeline: [
              {
                _id: timelineEventId,
                sequence: 1,
                action: "create",
                fromStatus: null,
                toStatus: "requested",
                actorRole: "requester",
                actorId: requesterId,
                note: null,
                helpType: input.requestedHelpType,
                occurredAt: now,
              },
            ],
            revision: 0,
            ...helpUpdateMarkers(0, "requester"),
          });
          await request.save({ session });
          await AuditLogService.recordRequiredInTransaction(
            {
              action: "alumni_help.request_created",
              actor: { type: "user", id: input.actor.id, role: input.actor.role },
              source: "http",
              outcome: "success",
              target: { model: "AlumniHelpRequest", id: requestId.toString() },
              correlationId: input.correlationId,
              details: {
                requestedHelpType: input.requestedHelpType,
                resultingRevision: 0,
              },
            },
            session,
          );
          await enqueueAlumniHelpWorkflowNotifications({
            requestId: requestId.toString(),
            requestRevision: 0,
            timelineEventId: timelineEventId.toString(),
            eventType: "create",
            actorUserId: requesterId.toString(),
            requesterId: requesterId.toString(),
            providerId: provider.profile.userId.toString(),
            occurredAt: now,
            session,
            correlationId: input.correlationId,
          });
          return {
            httpStatus: 201,
            response: { requestId: requestId.toString() },
            resource: { type: "AlumniHelpRequest", id: requestId.toString() },
          };
        },
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw duplicateRequest();
      throw error;
    }
    return this.get(input.actor.id, execution.response!.requestId as string);
  }

  async transition(
    input: TransitionAlumniHelpRequestInput,
  ): Promise<AlumniHelpRequestDataDTO> {
    const actorId = toObjectId(input.actor.id);
    const requestId = toObjectId(input.requestId, true);
    let execution;
    try {
      execution = await this.idempotency.execute<HelpMutationReceipt>({
        scope: `alumni.help.${input.action}`,
        actorKey: input.actor.id,
        key: input.idempotencyKey,
        requestPayload: {
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          note: input.note ?? null,
          proposedHelpType: input.proposedHelpType ?? null,
        },
        execute: async (session) => {
          const now = this.requireNow();
          const request = await this.loadParticipantRequest(
            requestId,
            actorId,
            session,
            true,
          );
          if (request.revision !== input.expectedRevision) {
            throw requestRevisionConflict();
          }
          const role = participantRole(request, actorId);
          const transition = ALUMNI_HELP_TRANSITIONS[input.action];
          if (
            (transition.actor !== "either" && transition.actor !== role) ||
            !(transition.from as readonly string[]).includes(request.status)
          ) {
            throw requestStateConflict();
          }

          if (input.action === "propose_alternative") {
            if (
              !input.proposedHelpType ||
              input.proposedHelpType === request.requestedHelpType
            ) {
              throw offeringUnavailable();
            }
            await this.assertEligibleOffering(
              request.alumniProfileId,
              input.proposedHelpType,
              session,
            );
          }
          if (input.action === "accept" || input.action === "confirm_alternative") {
            this.assertRequestTermsKnown(request);
            const agreedType =
              input.action === "accept"
                ? request.requestedHelpType
                : request.proposedHelpType;
            if (!agreedType) throw requestStateConflict();
            await this.assertEligibleOffering(
              request.alumniProfileId,
              agreedType,
              session,
            );
            request.agreedHelpType = agreedType;
            request.acceptedAt = now;
            request.hasBeenAccepted = true;
            request.conversationId = await this.roomProvisioner.ensureInTransaction({
              helpRequestId: request._id,
              requesterId: request.requesterId,
              providerId: request.providerId,
              acceptedAt: now,
              session,
            });
          }

          const fromStatus = request.status;
          request.status = transition.to;
          if (input.action === "propose_alternative") {
            request.proposedHelpType = input.proposedHelpType!;
          } else if (input.action === "reject_alternative") {
            request.proposedHelpType = null;
          } else if (input.action === "decline") {
            request.declinedAt = now;
            request.purgeAt = neverAcceptedHelpRequestPurgeAt(now);
          } else if (input.action === "withdraw") {
            request.withdrawnAt = now;
            request.purgeAt = neverAcceptedHelpRequestPurgeAt(now);
          } else if (input.action === "start") {
            request.startedAt = now;
          } else if (input.action === "complete") {
            request.completedAt = now;
          } else if (input.action === "close") {
            request.closedAt = now;
            request.purgeAt = acceptedHelpRequestPurgeAt(
              now,
              request.latestOutcomeDueAt,
            );
          }
          const timelineEventId = new mongoose.Types.ObjectId();
          const event: AlumniHelpLifecycleEvent = {
            _id: timelineEventId,
            sequence: request.lifecycleTimeline.length + 1,
            action: input.action,
            fromStatus,
            toStatus: transition.to,
            actorRole: role,
            actorId,
            note: input.note ?? null,
            helpType:
              input.action === "propose_alternative"
                ? input.proposedHelpType ?? null
                : input.action === "accept" || input.action === "confirm_alternative"
                  ? request.agreedHelpType ?? null
                  : null,
            occurredAt: now,
          };
          request.lifecycleTimeline.push(event);
          request.revision = input.expectedRevision + 1;
          await request.validate();
          const roomGraceEndsAt =
            input.action === "close" ? alumniHelpRoomGraceEndsAt(now) : null;

          const updated = await AlumniHelpRequest.updateOne(
            {
              _id: request._id,
              revision: input.expectedRevision,
              status: fromStatus,
            },
            {
              $set: {
                status: request.status,
                proposedHelpType: request.proposedHelpType ?? null,
                agreedHelpType: request.agreedHelpType ?? null,
                hasBeenAccepted: request.hasBeenAccepted,
                activeUniqueness: request.activeUniqueness,
                acceptedAt: request.acceptedAt ?? null,
                declinedAt: request.declinedAt ?? null,
                withdrawnAt: request.withdrawnAt ?? null,
                startedAt: request.startedAt ?? null,
                completedAt: request.completedAt ?? null,
                closedAt: request.closedAt ?? null,
                conversationId: request.conversationId ?? null,
                purgeAt: request.purgeAt ?? null,
                revision: request.revision,
              },
              $push: { lifecycleTimeline: event },
              $max: helpUpdateMarkers(request.revision, role),
            },
            { session, runValidators: false },
          );
          if (updated.modifiedCount !== 1) throw requestRevisionConflict();
          if (input.action === "close" && request.purgeAt && roomGraceEndsAt) {
            await AlumniHelpOutcomeSubmission.updateMany(
              { helpRequestId: request._id },
              { $set: { purgeAt: request.purgeAt } },
              { session, runValidators: false },
            );
            if (!request.conversationId) throw requestStateConflict();
            await this.roomProvisioner.startGraceInTransaction({
              conversationId: request.conversationId,
              helpRequestId: request._id,
              occurredAt: now,
              writeAccessEndsAt: roomGraceEndsAt,
              session,
            });
          }
          await AuditLogService.recordRequiredInTransaction(
            {
              action: `alumni_help.${input.action}`,
              actor: { type: "user", id: input.actor.id, role: input.actor.role },
              source: "http",
              outcome: "success",
              target: { model: "AlumniHelpRequest", id: request._id.toString() },
              correlationId: input.correlationId,
              details: {
                fromStatus,
                toStatus: request.status,
                fromRevision: input.expectedRevision,
                toRevision: request.revision,
              },
            },
            session,
          );
          await enqueueAlumniHelpWorkflowNotifications({
            requestId: request._id.toString(),
            requestRevision: request.revision,
            timelineEventId: timelineEventId.toString(),
            eventType: input.action,
            actorUserId: actorId.toString(),
            requesterId: request.requesterId.toString(),
            providerId: request.providerId.toString(),
            occurredAt: now,
            session,
            correlationId: input.correlationId,
            ...(roomGraceEndsAt && request.conversationId
              ? {
                  roomGraceStarted: {
                    conversationId: request.conversationId.toString(),
                    writeAccessEndsAt: roomGraceEndsAt,
                  },
                }
              : {}),
          });
          return {
            httpStatus: 200,
            response: { requestId: request._id.toString() },
            resource: { type: "AlumniHelpRequest", id: request._id.toString() },
          };
        },
      });
    } catch (error) {
      // Concurrent acceptance may race on the room/member unique indexes before
      // the request CAS observes the winner. Present the same refreshable CAS
      // conflict in either ordering and let the transaction roll back fully.
      if (isDuplicateKey(error)) throw requestRevisionConflict();
      throw error;
    }
    return this.get(input.actor.id, execution.response!.requestId as string);
  }

  async submitOutcome(
    input: SubmitAlumniHelpOutcomeInput,
  ): Promise<AlumniHelpRequestDataDTO> {
    const actorId = toObjectId(input.actor.id);
    const requestId = toObjectId(input.requestId, true);
    let execution;
    try {
      execution = await this.idempotency.execute<HelpMutationReceipt>({
        scope: "alumni.help.outcome.submit",
        actorKey: input.actor.id,
        key: input.idempotencyKey,
        requestPayload: {
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          outcomeCode: input.outcomeCode,
        },
        execute: async (session) => {
          const now = this.requireNow();
          const request = await this.loadParticipantRequest(
            requestId,
            actorId,
            session,
            true,
          );
          if (!request.requesterId.equals(actorId)) throw requestNotFound();
          if (request.revision !== input.expectedRevision) {
            throw requestRevisionConflict();
          }
          if (!request.hasBeenAccepted || !request.agreedHelpType) {
            throw outcomeStateConflict();
          }
          if (request.purgeAt && request.purgeAt.getTime() <= now.getTime()) {
            throw requestNotFound();
          }
          if (
            request.latestOutcomeStatus &&
            request.latestOutcomeStatus !== "denied"
          ) {
            throw outcomeStateConflict();
          }
          if (
            !isAlumniHelpOutcomeCodeForType(
              request.agreedHelpType,
              input.outcomeCode,
            )
          ) {
            throw alumniInputError();
          }
          const isResubmission = request.latestOutcomeStatus === "denied";
          const revisionNumber = (request.latestOutcomeRevisionNumber ?? 0) + 1;
          const outcomeId = new mongoose.Types.ObjectId();
          const dueAt = helpOutcomeDueAt(now);
          const requestPurgeAt = request.closedAt
            ? acceptedHelpRequestPurgeAt(request.closedAt, dueAt)
            : null;
          const outcome = new AlumniHelpOutcomeSubmission({
            _id: outcomeId,
            helpRequestId: request._id,
            revisionNumber,
            previousSubmissionId: request.latestOutcomeSubmissionId ?? null,
            submittedBy: actorId,
            agreedHelpType: request.agreedHelpType,
            outcomeCode: input.outcomeCode,
            status: "pending",
            submittedAt: now,
            dueAt,
            purgeAt: requestPurgeAt,
            revision: 0,
          });
          await outcome.save({ session });

          request.latestOutcomeSubmissionId = outcomeId;
          request.latestOutcomeRevisionNumber = revisionNumber;
          request.latestOutcomeStatus = "pending";
          request.latestOutcomeDueAt = dueAt;
          request.purgeAt = requestPurgeAt;
          request.revision = input.expectedRevision + 1;
          await request.validate();
          const updated = await AlumniHelpRequest.updateOne(
            {
              _id: request._id,
              requesterId: actorId,
              revision: input.expectedRevision,
              latestOutcomeStatus: isResubmission ? "denied" : null,
            },
            {
              $set: {
                latestOutcomeSubmissionId: outcomeId,
                latestOutcomeRevisionNumber: revisionNumber,
                latestOutcomeStatus: "pending",
                latestOutcomeDueAt: dueAt,
                purgeAt: requestPurgeAt,
                revision: request.revision,
              },
              $max: helpUpdateMarkers(request.revision, "requester"),
            },
            { session, runValidators: false },
          );
          if (updated.modifiedCount !== 1) throw requestRevisionConflict();
          if (requestPurgeAt) {
            await AlumniHelpOutcomeSubmission.updateMany(
              { helpRequestId: request._id },
              { $set: { purgeAt: requestPurgeAt } },
              { session, runValidators: false },
            );
          }
          const eventType: AlumniHelpWorkflowEventType = isResubmission
            ? "outcome_resubmit"
            : "outcome_submit";
          const timelineEventId = new mongoose.Types.ObjectId();
          await AuditLogService.recordRequiredInTransaction(
            {
              action: `alumni_help.${eventType}`,
              actor: { type: "user", id: input.actor.id, role: input.actor.role },
              source: "http",
              outcome: "success",
              target: { model: "AlumniHelpOutcomeSubmission", id: outcomeId.toString() },
              correlationId: input.correlationId,
              details: {
                outcomeRevisionNumber: revisionNumber,
                outcomeCode: input.outcomeCode,
                dueAt: dueAt.toISOString(),
                resultingRequestRevision: request.revision,
              },
            },
            session,
          );
          await enqueueAlumniHelpWorkflowNotifications({
            requestId: request._id.toString(),
            requestRevision: request.revision,
            timelineEventId: timelineEventId.toString(),
            eventType,
            actorUserId: actorId.toString(),
            requesterId: request.requesterId.toString(),
            providerId: request.providerId.toString(),
            outcomeSubmissionId: outcomeId.toString(),
            outcomeRevision: revisionNumber,
            occurredAt: now,
            session,
            correlationId: input.correlationId,
          });
          return {
            httpStatus: 201,
            response: { requestId: request._id.toString() },
            resource: { type: "AlumniHelpRequest", id: request._id.toString() },
          };
        },
      });
    } catch (error) {
      // Two distinct idempotency keys can reach the partial unique pending-
      // outcome index before either request CAS becomes visible. Normalize that
      // storage race to the request revision conflict clients already handle.
      if (isDuplicateKey(error)) throw requestRevisionConflict();
      throw error;
    }
    return this.get(input.actor.id, execution.response!.requestId as string);
  }

  async decideOutcome(
    input: DecideAlumniHelpOutcomeInput,
  ): Promise<AlumniHelpRequestDataDTO> {
    const actorId = toObjectId(input.actor.id);
    const requestId = toObjectId(input.requestId, true);
    const outcomeId = toOutcomeObjectId(input.outcomeId);
    const execution = await this.idempotency.execute<HelpMutationReceipt>({
      scope: `alumni.help.outcome.${input.decision}`,
      actorKey: input.actor.id,
      key: input.idempotencyKey,
      requestPayload: {
        requestId: input.requestId,
        outcomeId: input.outcomeId,
        expectedRevision: input.expectedRevision,
      },
      execute: async (session) => {
        const now = this.requireNow();
        const request = await this.loadParticipantRequest(
          requestId,
          actorId,
          session,
          true,
        );
        if (!request.providerId.equals(actorId)) throw requestNotFound();
        const outcome = await AlumniHelpOutcomeSubmission.findOne({
          _id: outcomeId,
          helpRequestId: request._id,
        }).session(session);
        if (!outcome) throw outcomeNotFound();
        if (outcome.revision !== input.expectedRevision) {
          throw outcomeRevisionConflict();
        }
        if (outcome.status !== "pending") throw outcomeStateConflict();
        if (now.getTime() >= outcome.dueAt.getTime()) throw outcomeDeadlinePassed();
        if (!request.latestOutcomeSubmissionId?.equals(outcome._id)) {
          throw outcomeStateConflict();
        }

        outcome.status = input.decision === "confirm" ? "confirmed" : "denied";
        outcome.decidedAt = now;
        outcome.decidedBy = actorId;
        outcome.confirmationMethod =
          input.decision === "confirm" ? "provider" : null;
        outcome.revision = input.expectedRevision + 1;
        await outcome.validate();
        const outcomeUpdated = await AlumniHelpOutcomeSubmission.updateOne(
          {
            _id: outcome._id,
            helpRequestId: request._id,
            status: "pending",
            revision: input.expectedRevision,
            dueAt: { $gt: now },
          },
          {
            $set: {
              status: outcome.status,
              decidedAt: now,
              decidedBy: actorId,
              confirmationMethod: outcome.confirmationMethod ?? null,
              revision: outcome.revision,
            },
          },
          { session, runValidators: false },
        );
        if (outcomeUpdated.modifiedCount !== 1) {
          throw outcomeRevisionConflict();
        }

        const requestRevision = request.revision;
        const fromStatus = request.status;
        const closesRequest =
          input.decision === "confirm" && request.status !== "closed";
        let closureEvent: AlumniHelpLifecycleEvent | null = null;
        if (closesRequest) {
          const closeTransition = ALUMNI_HELP_TRANSITIONS.outcome_confirm;
          if (!(closeTransition.from as readonly string[]).includes(fromStatus)) {
            throw requestStateConflict();
          }
          request.status = closeTransition.to;
          request.closedAt = now;
          request.purgeAt = acceptedHelpRequestPurgeAt(
            now,
            request.latestOutcomeDueAt,
          );
          closureEvent = {
            _id: new mongoose.Types.ObjectId(),
            sequence: request.lifecycleTimeline.length + 1,
            action: "outcome_confirm",
            fromStatus,
            toStatus: closeTransition.to,
            actorRole: "provider",
            actorId,
            note: null,
            helpType: null,
            occurredAt: now,
          };
          request.lifecycleTimeline.push(closureEvent);
        }
        request.latestOutcomeStatus = outcome.status;
        request.revision = requestRevision + 1;
        await request.validate();
        const roomGraceEndsAt = closesRequest
          ? alumniHelpRoomGraceEndsAt(now)
          : null;
        const requestUpdated = await AlumniHelpRequest.updateOne(
          {
            _id: request._id,
            revision: requestRevision,
            latestOutcomeSubmissionId: outcome._id,
            latestOutcomeStatus: "pending",
          },
          {
            $set: {
              ...(closesRequest
                ? {
                    status: request.status,
                    activeUniqueness: request.activeUniqueness,
                    closedAt: request.closedAt,
                    purgeAt: request.purgeAt,
                  }
                : {}),
              latestOutcomeStatus: outcome.status,
              revision: request.revision,
            },
            ...(closureEvent ? { $push: { lifecycleTimeline: closureEvent } } : {}),
            $max: helpUpdateMarkers(request.revision, "provider"),
          },
          { session, runValidators: false },
        );
        if (requestUpdated.modifiedCount !== 1) throw requestRevisionConflict();
        if (closesRequest && roomGraceEndsAt) {
          if (!request.purgeAt || !request.conversationId) {
            throw requestStateConflict();
          }
          await AlumniHelpOutcomeSubmission.updateMany(
            { helpRequestId: request._id },
            { $set: { purgeAt: request.purgeAt } },
            { session, runValidators: false },
          );
          await this.roomProvisioner.startGraceInTransaction({
            conversationId: request.conversationId,
            helpRequestId: request._id,
            occurredAt: now,
            writeAccessEndsAt: roomGraceEndsAt,
            session,
          });
        }
        const eventType: AlumniHelpWorkflowEventType =
          input.decision === "confirm" ? "outcome_confirm" : "outcome_deny";
        const timelineEventId = closureEvent?._id ?? new mongoose.Types.ObjectId();
        await AuditLogService.recordRequiredInTransaction(
          {
            action: `alumni_help.${eventType}`,
            actor: { type: "user", id: input.actor.id, role: input.actor.role },
            source: "http",
            outcome: "success",
            target: {
              model: "AlumniHelpOutcomeSubmission",
              id: outcome._id.toString(),
            },
            correlationId: input.correlationId,
            details: {
              outcomeRevisionNumber: outcome.revisionNumber,
              fromRevision: input.expectedRevision,
              toRevision: outcome.revision,
              resultingRequestRevision: request.revision,
              resultingRequestStatus: request.status,
              requestClosedByConfirmation: closesRequest,
            },
          },
          session,
        );
        await enqueueAlumniHelpWorkflowNotifications({
          requestId: request._id.toString(),
          requestRevision: request.revision,
          timelineEventId: timelineEventId.toString(),
          eventType,
          actorUserId: actorId.toString(),
          requesterId: request.requesterId.toString(),
          providerId: request.providerId.toString(),
          outcomeSubmissionId: outcome._id.toString(),
          outcomeRevision: outcome.revisionNumber,
          occurredAt: now,
          session,
          correlationId: input.correlationId,
          ...(roomGraceEndsAt && request.conversationId
            ? {
                roomGraceStarted: {
                  conversationId: request.conversationId.toString(),
                  writeAccessEndsAt: roomGraceEndsAt,
                },
              }
            : {}),
        });
        return {
          httpStatus: 200,
          response: { requestId: request._id.toString() },
          resource: { type: "AlumniHelpRequest", id: request._id.toString() },
        };
      },
    });
    return this.get(input.actor.id, execution.response!.requestId as string);
  }

  private requireNow(): Date {
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Alumni Help clock is invalid.");
    }
    return new Date(now);
  }

  private assertCurrentTerms(consentVersion: string, disclaimerVersion: string): void {
    if (
      consentVersion !== ALUMNI_HELP_TERMS.consent.version ||
      disclaimerVersion !== ALUMNI_HELP_TERMS.disclaimer.version
    ) {
      throw termsVersionInvalid();
    }
  }

  private assertRequestTermsKnown(
    request: IAlumniHelpRequest,
  ): ArchivedHelpTerms {
    const consent = findAlumniHelpConsent(request.consentVersion);
    const disclaimer = findAlumniHelpDisclaimer(request.disclaimerVersion);
    if (
      !consent ||
      consent.documentHash !== request.consentDocumentHash ||
      !disclaimer ||
      disclaimer.documentHash !== request.disclaimerDocumentHash
    ) {
      throw termsVersionInvalid();
    }
    return Object.freeze({ consent, disclaimer });
  }

  private async loadEligibleProvider(
    profileId: mongoose.Types.ObjectId,
    session?: ClientSession,
  ): Promise<EligibleProvider> {
    const profile = await AlumniProfile.findOne({
      _id: profileId,
      publishStatus: "published",
      accountDeletionApprovedAt: null,
      currentPublicationConsentId: { $type: "objectId" },
    }).session(session ?? null);
    if (!profile) throw offeringUnavailable();
    const user = await User.findOne({
      _id: profile.userId,
      isActive: true,
      isVerified: true,
    })
      .select("_id username firstName lastName avatar isActive isVerified")
      .session(session ?? null);
    if (!user) throw offeringUnavailable();
    const consent = await ConsentRecord.findOne({
        _id: profile.currentPublicationConsentId,
        subjectUserId: profile.userId,
        alumniProfileId: profile._id,
        purpose: "alumni_profile_publication",
        status: "active",
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
      })
        .select("_id")
        .session(session ?? null);
    if (!consent) throw offeringUnavailable();
    return { profile, user };
  }

  private async assertEligibleOffering(
    profileId: mongoose.Types.ObjectId,
    helpType: AlumniHelpType,
    session: ClientSession,
  ): Promise<void> {
    const provider = await this.loadEligibleProvider(profileId, session);
    if (!offeringEnabled(provider.profile, helpType)) throw offeringUnavailable();
  }

  private async loadParticipantRequest(
    requestId: mongoose.Types.ObjectId,
    actorId: mongoose.Types.ObjectId,
    session?: ClientSession,
    includeTerms = false,
  ): Promise<IAlumniHelpRequest> {
    const request = await AlumniHelpRequest.findOne({
      _id: requestId,
      $or: [{ requesterId: actorId }, { providerId: actorId }],
      $and: [
        { $or: [{ purgeAt: null }, { purgeAt: { $gt: this.requireNow() } }] },
      ],
    })
      .select(includeTerms ? "+consentDocumentHash +disclaimerDocumentHash" : "")
      .session(session ?? null);
    if (!request) throw requestNotFound();
    return request;
  }
}

export const alumniHelpRequestService = new AlumniHelpRequestService();
