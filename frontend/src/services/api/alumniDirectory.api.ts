import { BaseApiClient } from "./common";
import {
  DIRECTORY_OFFERINGS,
  decodeDirectoryDetailResponse,
  decodeDirectoryPage,
  decodeOwnAlumniProfileResponse,
  type DirectoryDetailDTO,
  type DirectoryHelpOfferingsDTO,
  type DirectoryOffering,
  type DirectoryPageDTO,
  type OwnAlumniProfileDTO,
} from "./alumniDirectory.contracts";

export const DIRECTORY_DEFAULT_PAGE_SIZE = 24;
export const DIRECTORY_MAX_PAGE_SIZE = 100;

export interface DirectoryListParams {
  page?: number;
  limit?: number;
  q?: string;
  company?: string;
  industry?: string;
  skill?: string;
  location?: string;
  cohort?: string;
  offering?: DirectoryOffering;
}

export interface AlumniProfileUpdateInput {
  expectedRevision: number;
  professionalHeadline?: string | null;
  industry?: string | null;
  skills?: string[];
  bio?: string | null;
  helpOfferings?: DirectoryHelpOfferingsDTO;
}

export interface AlumniProfilePublishInput {
  expectedRevision: number;
  consentVersion: string;
  consentAccepted: true;
}

function withQuery(endpoint: string, params: DirectoryListParams): string {
  const query = new URLSearchParams();

  if (params.page !== undefined) {
    if (!Number.isSafeInteger(params.page) || params.page < 1) {
      throw new Error("Directory page must be a positive integer");
    }
    query.set("page", String(params.page));
  }
  if (params.limit !== undefined) {
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit < 1 ||
      params.limit > DIRECTORY_MAX_PAGE_SIZE
    ) {
      throw new Error(
        `Directory limit must be an integer from 1 to ${DIRECTORY_MAX_PAGE_SIZE}`,
      );
    }
    query.set("limit", String(params.limit));
  }

  const textFilters = {
    q: params.q,
    company: params.company,
    industry: params.industry,
    skill: params.skill,
    location: params.location,
    cohort: params.cohort,
  };
  Object.entries(textFilters).forEach(([key, value]) => {
    const normalized = value?.trim();
    if (normalized) query.set(key, normalized);
  });

  if (params.offering !== undefined) {
    if (!DIRECTORY_OFFERINGS.includes(params.offering)) {
      throw new Error("Invalid Directory help offering");
    }
    query.set("offering", params.offering);
  }

  const serialized = query.toString();
  return serialized ? `${endpoint}?${serialized}` : endpoint;
}

class AlumniDirectoryApiClient extends BaseApiClient {
  async list(
    params: DirectoryListParams = {},
    signal?: AbortSignal,
  ): Promise<DirectoryPageDTO> {
    const response = await this.request<unknown>(withQuery("/directory", params), {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get the alumni directory");
    }
    return decodeDirectoryPage(response.data);
  }

  async get(profileId: string, signal?: AbortSignal): Promise<DirectoryDetailDTO> {
    const response = await this.request<unknown>(
      `/directory/${encodeURIComponent(profileId)}`,
      { signal },
    );
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get the alumni profile");
    }
    return decodeDirectoryDetailResponse(response.data);
  }

  async getOwn(signal?: AbortSignal): Promise<OwnAlumniProfileDTO> {
    const response = await this.request<unknown>("/directory/me", { signal });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to get your alumni profile");
    }
    return decodeOwnAlumniProfileResponse(response.data);
  }

  async previewOwn(signal?: AbortSignal): Promise<DirectoryDetailDTO> {
    const response = await this.request<unknown>("/directory/me/preview", {
      signal,
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to preview your alumni profile");
    }
    return decodeDirectoryDetailResponse(response.data);
  }

  async updateOwn(
    input: AlumniProfileUpdateInput,
    idempotencyKey: string,
  ): Promise<OwnAlumniProfileDTO> {
    const response = await this.request<unknown>("/directory/me", {
      method: "PATCH",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to update your alumni profile");
    }
    return decodeOwnAlumniProfileResponse(response.data);
  }

  async publishOwn(
    input: AlumniProfilePublishInput,
    idempotencyKey: string,
  ): Promise<OwnAlumniProfileDTO> {
    const response = await this.request<unknown>("/directory/me/publish", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to publish your alumni profile");
    }
    return decodeOwnAlumniProfileResponse(response.data);
  }

  async withdrawOwn(
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<OwnAlumniProfileDTO> {
    const response = await this.request<unknown>("/directory/me/withdraw", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ expectedRevision }),
    });
    if (response.data === undefined) {
      throw new Error(response.message || "Failed to withdraw your alumni profile");
    }
    return decodeOwnAlumniProfileResponse(response.data);
  }
}

const alumniDirectoryApiClient = new AlumniDirectoryApiClient();

export const alumniDirectoryService = {
  list: (params?: DirectoryListParams, signal?: AbortSignal) =>
    alumniDirectoryApiClient.list(params, signal),
  get: (profileId: string, signal?: AbortSignal) =>
    alumniDirectoryApiClient.get(profileId, signal),
  getOwn: (signal?: AbortSignal) => alumniDirectoryApiClient.getOwn(signal),
  previewOwn: (signal?: AbortSignal) =>
    alumniDirectoryApiClient.previewOwn(signal),
  updateOwn: (input: AlumniProfileUpdateInput, idempotencyKey: string) =>
    alumniDirectoryApiClient.updateOwn(input, idempotencyKey),
  publishOwn: (input: AlumniProfilePublishInput, idempotencyKey: string) =>
    alumniDirectoryApiClient.publishOwn(input, idempotencyKey),
  withdrawOwn: (expectedRevision: number, idempotencyKey: string) =>
    alumniDirectoryApiClient.withdrawOwn(expectedRevision, idempotencyKey),
};

export type {
  DirectoryAffiliationDTO,
  DirectoryCardDTO,
  DirectoryDetailDTO,
  DirectoryHelpOfferingsDTO,
  DirectoryOffering,
  DirectoryPageDTO,
  OwnAlumniProfileDTO,
} from "./alumniDirectory.contracts";
