import {
  BaseApiClient,
  type ProgramParticipantsResponse,
  type ProgramUnenrollPreview,
  type ProgramUnenrollResult,
} from "./common";
import type { ProgramType } from "../../constants/programTypes";
import type { ProgramRoles } from "../../types/program";
import {
  decodeProgramCommunitySettings,
  type ProgramCommunitySettingsDTO,
  type UpdateProgramCommunitySettingsInput,
} from "./programCommunitySettings.contracts";

/**
 * Programs API Service
 * Handles program CRUD operations, events, and participants
 */
class ProgramsApiClient extends BaseApiClient {
  async listPrograms(params?: {
    type?: string;
    q?: string;
    page?: number;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      title: string;
      programType: ProgramType;
      hostedBy?: string;
      period?: {
        startYear?: string;
        startMonth?: string;
        endYear?: string;
        endMonth?: string;
      };
      introduction?: string;
      flyerUrl?: string;
      zoomLink?: string;
      meetingId?: string;
      passcode?: string;
      earlyBirdDeadline?: string;
      isFree?: boolean;
      programRoles?: ProgramRoles;
      mentors?: Array<{
        userId: string;
        firstName?: string;
        lastName?: string;
        email?: string;
        gender?: "male" | "female";
        avatar?: string;
        roleInAtCloud?: string;
      }>;
      adminEnrollments?: {
        mentees?: string[];
        classReps?: string[];
      };
      fullPriceTicket: number;
      classRepDiscount?: number;
      earlyBirdDiscount?: number;
      events?: string[];
      createdBy: string;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    // Keep legacy array consumers compatible while ensuring every request is
    // bounded. Callers can opt into any page up to the server's cap of 100.
    const query = new URLSearchParams({ limit: "100" });
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value != null && value !== "") query.set(key, String(value));
    });
    const res = await this.request<unknown>(`/programs?${query.toString()}`);
    type MentorLite = {
      userId: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      gender?: "male" | "female";
      avatar?: string;
      roleInAtCloud?: string;
    };
    type ProgramDTO = {
      id: string;
      title: string;
      programType: ProgramType;
      hostedBy?: string;
      period?: {
        startYear?: string;
        startMonth?: string;
        endYear?: string;
        endMonth?: string;
      };
      introduction?: string;
      flyerUrl?: string;
      zoomLink?: string;
      meetingId?: string;
      passcode?: string;
      earlyBirdDeadline?: string;
      isFree?: boolean;
      programRoles?: ProgramRoles;
      mentors?: MentorLite[];
      adminEnrollments?: {
        mentees?: string[];
        classReps?: string[];
      };
      fullPriceTicket: number;
      classRepDiscount?: number;
      earlyBirdDiscount?: number;
      events?: string[];
      createdBy: string;
      createdAt: string;
      updatedAt: string;
    };

    // Backend returns { success, data: ProgramDTO[] }, and request() already
    // unwraps to place the array on res.data. Return the array directly.
    return (res.data as ProgramDTO[]) || [];
  }

  async getProgram(id: string): Promise<unknown> {
    const res = await this.request<unknown>(`/programs/${id}`);
    return (res as { data?: unknown }).data;
  }

  async createProgram(payload: unknown): Promise<unknown> {
    const res = await this.request<unknown>(`/programs`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return (res as { data?: unknown }).data;
  }

  async updateProgram(id: string, payload: unknown): Promise<unknown> {
    const res = await this.request<unknown>(`/programs/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    return (res as { data?: unknown }).data;
  }

  async getCommunitySettings(
    id: string,
    signal?: AbortSignal,
  ): Promise<ProgramCommunitySettingsDTO> {
    const res = await this.request<unknown>(
      `/programs/${encodeURIComponent(id)}/community-settings`,
      { signal },
    );
    if (res.data === undefined) {
      throw new Error(res.message || "Failed to load Program Chat Room settings");
    }
    return decodeProgramCommunitySettings(res.data);
  }

  async updateCommunitySettings(
    id: string,
    input: UpdateProgramCommunitySettingsInput,
    idempotencyKey: string,
  ): Promise<ProgramCommunitySettingsDTO> {
    const res = await this.request<unknown>(
      `/programs/${encodeURIComponent(id)}/community-settings`,
      {
        method: "PUT",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
      },
    );
    if (res.data === undefined) {
      throw new Error(res.message || "Failed to update Program Chat Room settings");
    }
    return decodeProgramCommunitySettings(res.data);
  }

  async deleteProgram(
    id: string,
    options?: { deleteLinkedEvents?: boolean }
  ): Promise<{
    message: string;
    unlinkedEvents?: number;
    deletedEvents?: number;
    deletedRegistrations?: number;
    deletedGuestRegistrations?: number;
  }> {
    const qs = options?.deleteLinkedEvents ? "?deleteLinkedEvents=true" : "";
    const res = await this.request<{
      message: string;
      unlinkedEvents?: number;
      deletedEvents?: number;
      deletedRegistrations?: number;
      deletedGuestRegistrations?: number;
    }>(`/programs/${id}${qs}`, { method: "DELETE" });
    return res.data || { message: "Program deleted successfully" };
  }

  async listProgramEvents(id: string): Promise<unknown[]> {
    const res = await this.request<unknown>(`/programs/${id}/events`);
    return ((res as { data?: unknown[] }).data as unknown[]) || [];
  }

  // Paged program events (server-side pagination)
  async listProgramEventsPaged(
    id: string,
    params: {
      page?: number;
      limit?: number;
      sort?: "date:asc" | "date:desc";
      type?: string;
      status?: string;
    } = {}
  ): Promise<{
    items: unknown[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    sort?: { field: string; dir: "asc" | "desc" };
    filters?: { type?: string; status?: string };
  }> {
    const search = new URLSearchParams();
    if (params.page != null) search.set("page", String(params.page));
    if (params.limit != null) search.set("limit", String(params.limit));
    if (params.sort) search.set("sort", params.sort);
    if (params.type) search.set("type", params.type);
    if (params.status) search.set("status", params.status);
    const qs = search.toString();
    const res = await this.request<unknown>(
      `/programs/${id}/events${qs ? `?${qs}` : ""}`
    );
    const data = (
      res as {
        data?: {
          items?: unknown[];
          page?: number;
          limit?: number;
          total?: number;
          totalPages?: number;
          sort?: { field: string; dir: "asc" | "desc" };
          filters?: { type?: string; status?: string };
        };
      }
    ).data;
    return {
      items: data?.items || [],
      page: data?.page ?? params.page ?? 1,
      limit: data?.limit ?? params.limit ?? 20,
      total: data?.total ?? (data?.items?.length || 0),
      totalPages:
        data?.totalPages ??
        Math.max(
          1,
          Math.ceil((data?.total ?? 0) / (data?.limit ?? params.limit ?? 20))
        ),
      sort: data?.sort,
      filters: data?.filters,
    };
  }

  async getParticipants(id: string): Promise<ProgramParticipantsResponse> {
    const res = await this.request<ProgramParticipantsResponse>(
      `/programs/${id}/participants`
    );
    return (
      res.data || {
        mentees: [],
        classReps: [],
      }
    );
  }

  async adminEnrollProgram(
    id: string,
    enrollAs: "mentee" | "classRep"
  ): Promise<unknown> {
    const res = await this.request<unknown>(`/programs/${id}/admin-enroll`, {
      method: "POST",
      body: JSON.stringify({ enrollAs }),
    });
    return (res as { data?: unknown }).data;
  }

  async adminUnenrollProgram(id: string): Promise<unknown> {
    const res = await this.request<unknown>(`/programs/${id}/admin-enroll`, {
      method: "DELETE",
    });
    return (res as { data?: unknown }).data;
  }

  async getUnenrollPreview(id: string): Promise<ProgramUnenrollPreview> {
    const res = await this.request<ProgramUnenrollPreview>(
      `/programs/${id}/unenroll-preview`,
    );
    if (!res.data) {
      throw new Error(res.message || "Failed to load unenrollment details");
    }
    return res.data;
  }

  async selfUnenrollProgram(id: string): Promise<ProgramUnenrollResult> {
    const res = await this.request<ProgramUnenrollResult>(
      `/programs/${id}/unenroll`,
      {
        method: "POST",
      },
    );
    if (!res.data) {
      throw new Error(res.message || "Failed to unenroll from program");
    }
    return res.data;
  }

  async sendProgramEmails(
    id: string,
    payload: {
      subject: string;
      bodyHtml: string;
      bodyText?: string;
      includeMentors?: boolean;
      includeClassReps?: boolean;
      includeMentees?: boolean;
    }
  ): Promise<{ recipientCount: number; sent?: number }> {
    type EmailResult = { recipientCount: number; sent?: number };
    const response = await this.request<EmailResult>(`/programs/${id}/email`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const isEmailResult = (v: unknown): v is EmailResult =>
      !!v &&
      typeof v === "object" &&
      ("recipientCount" in (v as Record<string, unknown>) ||
        "sent" in (v as Record<string, unknown>));

    const payloadData: unknown = response.data ?? null;
    if (isEmailResult(payloadData)) {
      return payloadData;
    }
    if (isEmailResult(response as unknown)) {
      return response as unknown as EmailResult;
    }
    // Default fallback
    return { recipientCount: 0, sent: 0 };
  }
}

// Export singleton instance
const programsApiClient = new ProgramsApiClient();

// Export service methods
export const programsService = {
  listPrograms: (
    params?: Parameters<typeof programsApiClient.listPrograms>[0]
  ) => programsApiClient.listPrograms(params),
  getProgram: (id: string) => programsApiClient.getProgram(id),
  createProgram: (payload: unknown) => programsApiClient.createProgram(payload),
  updateProgram: (id: string, payload: unknown) =>
    programsApiClient.updateProgram(id, payload),
  getCommunitySettings: (id: string, signal?: AbortSignal) =>
    programsApiClient.getCommunitySettings(id, signal),
  updateCommunitySettings: (
    id: string,
    input: UpdateProgramCommunitySettingsInput,
    idempotencyKey: string,
  ) => programsApiClient.updateCommunitySettings(id, input, idempotencyKey),
  deleteProgram: (
    id: string,
    options?: Parameters<typeof programsApiClient.deleteProgram>[1]
  ) => programsApiClient.deleteProgram(id, options),
  listProgramEvents: (id: string) => programsApiClient.listProgramEvents(id),
  listProgramEventsPaged: (
    id: string,
    params?: Parameters<typeof programsApiClient.listProgramEventsPaged>[1]
  ) => programsApiClient.listProgramEventsPaged(id, params),
  getParticipants: (id: string) => programsApiClient.getParticipants(id),
  adminEnrollProgram: (id: string, enrollAs: "mentee" | "classRep") =>
    programsApiClient.adminEnrollProgram(id, enrollAs),
  adminUnenrollProgram: (id: string) =>
    programsApiClient.adminUnenrollProgram(id),
  getUnenrollPreview: (id: string) =>
    programsApiClient.getUnenrollPreview(id),
  selfUnenrollProgram: (id: string) =>
    programsApiClient.selfUnenrollProgram(id),
  sendProgramEmails: (
    id: string,
    payload: Parameters<typeof programsApiClient.sendProgramEmails>[1]
  ) => programsApiClient.sendProgramEmails(id, payload),

  // Backward compatibility aliases
  list: (params?: Parameters<typeof programsApiClient.listPrograms>[0]) =>
    programsApiClient.listPrograms(params),
  getById: (id: string) => programsApiClient.getProgram(id),
};

// Legacy export for backward compatibility
export const programService = programsService;
