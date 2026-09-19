import { BaseApiClient } from "./common";
import {
  ALUMNI_HELP_TYPES,
  decodeAlumniHelpActionRequiredCount,
  decodeAlumniHelpRequestMutation,
  decodeAlumniHelpRequestPage,
  decodeAlumniHelpTerms,
  type AlumniHelpOutcomeCode,
  type AlumniHelpRequestMutationDTO,
  type AlumniHelpRequestPageDTO,
  type AlumniHelpTermsDTO,
  type AlumniHelpType,
} from "./alumniHelp.contracts";

export const ALUMNI_HELP_DEFAULT_PAGE_SIZE = 20;
export const ALUMNI_HELP_MAX_PAGE_SIZE = 100;

export const ALUMNI_HELP_LIST_VIEWS = [
  "action_required",
  "received",
  "sent",
  "completed",
] as const;

export type AlumniHelpListView = (typeof ALUMNI_HELP_LIST_VIEWS)[number];

export interface AlumniHelpListParams {
  view: AlumniHelpListView;
  page?: number;
  limit?: number;
}

export interface CreateAlumniHelpRequestInput {
  alumniProfileId: string;
  requestedHelpType: AlumniHelpType;
  openingNote?: string;
  consentVersion: string;
  consentAccepted: true;
  disclaimerVersion: string;
  disclaimerAccepted: true;
}

type LifecycleEndpoint =
  | "confirm-alternative"
  | "reject-alternative"
  | "accept"
  | "decline"
  | "withdraw"
  | "start"
  | "complete"
  | "close";

function requireObjectId(value: string, label: string): string {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new Error(`${label} must be a valid ObjectId`);
  }
  return value;
}

function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Expected revision must be a non-negative integer");
  }
  return value;
}

function requireIdempotencyKey(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("Idempotency-Key must be an RFC 4122 UUID");
  }
  return value;
}

function buildListEndpoint(params: AlumniHelpListParams): string {
  if (!ALUMNI_HELP_LIST_VIEWS.includes(params.view)) {
    throw new Error("Invalid Alumni Help list view");
  }
  const page = params.page ?? 1;
  const limit = params.limit ?? ALUMNI_HELP_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("Alumni Help page must be a positive integer");
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ALUMNI_HELP_MAX_PAGE_SIZE
  ) {
    throw new Error(
      `Alumni Help limit must be an integer from 1 to ${ALUMNI_HELP_MAX_PAGE_SIZE}`,
    );
  }
  const maximumPage = Math.floor(
    (Number.MAX_SAFE_INTEGER - (limit - 1)) / limit,
  );
  if (page > maximumPage) {
    throw new Error("Alumni Help page is outside the supported range");
  }
  const query = new URLSearchParams({
    view: params.view,
    page: String(page),
    limit: String(limit),
  });
  return `/alumni-help-requests?${query.toString()}`;
}

class AlumniHelpApiClient extends BaseApiClient {
  async getTerms(signal?: AbortSignal): Promise<AlumniHelpTermsDTO> {
    const response = await this.request<unknown>("/alumni-help-requests/terms", {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load Alumni Help terms");
    }
    return decodeAlumniHelpTerms(response.data);
  }

  async list(
    params: AlumniHelpListParams,
    signal?: AbortSignal,
  ): Promise<AlumniHelpRequestPageDTO> {
    const response = await this.request<unknown>(buildListEndpoint(params), {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load help requests");
    }
    return decodeAlumniHelpRequestPage(response.data);
  }

  async getActionRequiredCount(signal?: AbortSignal): Promise<number> {
    const response = await this.request<unknown>(
      "/alumni-help-requests/action-required-count",
      { signal },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load action count");
    }
    return decodeAlumniHelpActionRequiredCount(response.data);
  }

  async get(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AlumniHelpRequestMutationDTO> {
    const response = await this.request<unknown>(
      `/alumni-help-requests/${encodeURIComponent(requireObjectId(requestId, "Request ID"))}`,
      { signal },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to load the help request");
    }
    return decodeAlumniHelpRequestMutation(response.data);
  }

  async create(
    input: CreateAlumniHelpRequestInput,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    requireObjectId(input.alumniProfileId, "Alumni profile ID");
    if (!ALUMNI_HELP_TYPES.includes(input.requestedHelpType)) {
      throw new Error("Invalid Alumni Help type");
    }
    return this.write("/alumni-help-requests", input, idempotencyKey);
  }

  async requestInformation(
    requestId: string,
    expectedRevision: number,
    note: string,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    return this.writeForRequest(
      requestId,
      "request-information",
      { expectedRevision: requireRevision(expectedRevision), note },
      idempotencyKey,
    );
  }

  async provideInformation(
    requestId: string,
    expectedRevision: number,
    note: string,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    return this.writeForRequest(
      requestId,
      "provide-information",
      { expectedRevision: requireRevision(expectedRevision), note },
      idempotencyKey,
    );
  }

  async proposeAlternative(
    requestId: string,
    expectedRevision: number,
    proposedHelpType: AlumniHelpType,
    note: string | undefined,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    if (!ALUMNI_HELP_TYPES.includes(proposedHelpType)) {
      throw new Error("Invalid Alumni Help type");
    }
    return this.writeForRequest(
      requestId,
      "propose-alternative",
      {
        expectedRevision: requireRevision(expectedRevision),
        proposedHelpType,
        ...(note?.trim() ? { note } : {}),
      },
      idempotencyKey,
    );
  }

  async transition(
    requestId: string,
    endpoint: LifecycleEndpoint,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    return this.writeForRequest(
      requestId,
      endpoint,
      { expectedRevision: requireRevision(expectedRevision) },
      idempotencyKey,
    );
  }

  async submitOutcome(
    requestId: string,
    expectedRevision: number,
    outcomeCode: AlumniHelpOutcomeCode,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    return this.writeForRequest(
      requestId,
      "outcomes",
      { expectedRevision: requireRevision(expectedRevision), outcomeCode },
      idempotencyKey,
    );
  }

  async decideOutcome(
    requestId: string,
    outcomeId: string,
    decision: "confirm" | "deny",
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    const safeRequestId = encodeURIComponent(
      requireObjectId(requestId, "Request ID"),
    );
    const safeOutcomeId = encodeURIComponent(
      requireObjectId(outcomeId, "Outcome ID"),
    );
    return this.write(
      `/alumni-help-requests/${safeRequestId}/outcomes/${safeOutcomeId}/${decision}`,
      { expectedRevision: requireRevision(expectedRevision) },
      idempotencyKey,
    );
  }

  private writeForRequest(
    requestId: string,
    endpoint: LifecycleEndpoint | "request-information" | "provide-information" | "propose-alternative" | "outcomes",
    body: object,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    const safeId = encodeURIComponent(requireObjectId(requestId, "Request ID"));
    return this.write(
      `/alumni-help-requests/${safeId}/${endpoint}`,
      body,
      idempotencyKey,
    );
  }

  private async write(
    endpoint: string,
    body: object,
    idempotencyKey: string,
  ): Promise<AlumniHelpRequestMutationDTO> {
    const response = await this.request<unknown>(endpoint, {
      method: "POST",
      headers: { "Idempotency-Key": requireIdempotencyKey(idempotencyKey) },
      body: JSON.stringify(body),
    });
    if (response.data === undefined) {
      throw new Error(response.message || "The Alumni Help action failed");
    }
    return decodeAlumniHelpRequestMutation(response.data);
  }
}

const client = new AlumniHelpApiClient();

export const alumniHelpService = {
  getTerms: (signal?: AbortSignal) => client.getTerms(signal),
  list: (params: AlumniHelpListParams, signal?: AbortSignal) =>
    client.list(params, signal),
  getActionRequiredCount: (signal?: AbortSignal) =>
    client.getActionRequiredCount(signal),
  get: (requestId: string, signal?: AbortSignal) => client.get(requestId, signal),
  create: (input: CreateAlumniHelpRequestInput, idempotencyKey: string) =>
    client.create(input, idempotencyKey),
  requestInformation: (
    requestId: string,
    expectedRevision: number,
    note: string,
    idempotencyKey: string,
  ) => client.requestInformation(requestId, expectedRevision, note, idempotencyKey),
  provideInformation: (
    requestId: string,
    expectedRevision: number,
    note: string,
    idempotencyKey: string,
  ) => client.provideInformation(requestId, expectedRevision, note, idempotencyKey),
  proposeAlternative: (
    requestId: string,
    expectedRevision: number,
    proposedHelpType: AlumniHelpType,
    note: string | undefined,
    idempotencyKey: string,
  ) =>
    client.proposeAlternative(
      requestId,
      expectedRevision,
      proposedHelpType,
      note,
      idempotencyKey,
    ),
  transition: (
    requestId: string,
    endpoint: LifecycleEndpoint,
    expectedRevision: number,
    idempotencyKey: string,
  ) => client.transition(requestId, endpoint, expectedRevision, idempotencyKey),
  submitOutcome: (
    requestId: string,
    expectedRevision: number,
    outcomeCode: AlumniHelpOutcomeCode,
    idempotencyKey: string,
  ) => client.submitOutcome(requestId, expectedRevision, outcomeCode, idempotencyKey),
  decideOutcome: (
    requestId: string,
    outcomeId: string,
    decision: "confirm" | "deny",
    expectedRevision: number,
    idempotencyKey: string,
  ) =>
    client.decideOutcome(
      requestId,
      outcomeId,
      decision,
      expectedRevision,
      idempotencyKey,
    ),
};

export type {
  AlumniHelpAvailableAction,
  AlumniHelpConfirmationMethod,
  AlumniHelpLifecycleAction,
  AlumniHelpOutcomeCode,
  AlumniHelpOutcomeDTO,
  AlumniHelpOutcomeStatus,
  AlumniHelpParticipantDTO,
  AlumniHelpRequestDetailDTO,
  AlumniHelpRequestMutationDTO,
  AlumniHelpRequestPageDTO,
  AlumniHelpRequestStatus,
  AlumniHelpRequestSummaryDTO,
  AlumniHelpTermsDTO,
  AlumniHelpTimelineEntryDTO,
  AlumniHelpType,
  AlumniHelpViewerRole,
} from "./alumniHelp.contracts";
