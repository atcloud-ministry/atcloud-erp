import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alumniHelpService,
  type AlumniHelpRequestDetailDTO,
} from "../../services/api/alumniHelp.api";
import {
  decodeAlumniHelpRequestMutation,
  decodeAlumniHelpRequestPage,
  decodeAlumniHelpNotificationCounts,
} from "../../services/api/alumniHelp.contracts";

const IDS = {
  request: "64b000000000000000000001",
  requester: "64b000000000000000000002",
  provider: "64b000000000000000000003",
  profile: "64b000000000000000000004",
  timeline: "64b000000000000000000005",
  outcome: "64b000000000000000000006",
  conversation: "64b000000000000000000007",
};

const detail: AlumniHelpRequestDetailDTO = {
  id: IDS.request,
  requester: { id: IDS.requester, displayName: "Taylor Reed", avatar: null },
  provider: { id: IDS.provider, displayName: "Amy Chen", avatar: null },
  status: "requested",
  requestedHelpType: "career_advice",
  proposedHelpType: null,
  agreedHelpType: null,
  conversationId: null,
  viewerRole: "provider",
  actionRequiredForViewer: true,
  hasUnreadUpdate: true,
  availableActions: [
    "request_information",
    "propose_alternative",
    "accept",
    "decline",
  ],
  latestOutcome: null,
  revision: 0,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
  closedAt: null,
  alumniProfileId: IDS.profile,
  openingNote: "Could we discuss a career transition?",
  lifecycleTimeline: [
    {
      id: IDS.timeline,
      sequence: 1,
      action: "create",
      fromStatus: null,
      toStatus: "requested",
      actorRole: "requester",
      note: "Could we discuss a career transition?",
      helpType: "career_advice",
      occurredAt: "2026-09-12T12:00:00.000Z",
    },
  ],
  outcomes: [],
  availableAlternativeHelpTypes: ["warm_introduction"],
  acceptedAt: null,
  declinedAt: null,
  withdrawnAt: null,
  startedAt: null,
  completedAt: null,
  termsAcceptedAt: "2026-09-12T12:00:00.000Z",
  acceptedTerms: {
    consent: {
      version: "alumni-help-consent-v1",
      text: "Consent text",
      effectiveAt: "2026-09-12T00:00:00.000Z",
    },
    disclaimer: {
      version: "alumni-help-disclaimer-v1",
      text: "Disclaimer text",
      effectiveAt: "2026-09-12T00:00:00.000Z",
    },
  },
};

const mutationData = { request: detail, helpActionRequiredCount: 1, helpNotificationCount: 2 };
const summary = {
  id: detail.id,
  requester: detail.requester,
  provider: detail.provider,
  status: detail.status,
  requestedHelpType: detail.requestedHelpType,
  proposedHelpType: detail.proposedHelpType,
  agreedHelpType: detail.agreedHelpType,
  conversationId: detail.conversationId,
  viewerRole: detail.viewerRole,
  actionRequiredForViewer: detail.actionRequiredForViewer,
  hasUnreadUpdate: detail.hasUnreadUpdate,
  availableActions: detail.availableActions,
  latestOutcome: detail.latestOutcome,
  revision: detail.revision,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
  closedAt: detail.closedAt,
};
const validKey = "550e8400-e29b-41d4-a716-446655440000";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, message: "ok", data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Alumni Help strict response contracts", () => {
  it("accepts new unread counts and rejects counts smaller than the action-required union", () => {
    expect(decodeAlumniHelpNotificationCounts({ helpActionRequiredCount: 0, helpNotificationCount: 2 }))
      .toEqual({ helpActionRequiredCount: 0, helpNotificationCount: 2 });
    expect(() => decodeAlumniHelpNotificationCounts({ helpActionRequiredCount: 2, helpNotificationCount: 1 }))
      .toThrow(/helpNotificationCount/);
    expect(() => decodeAlumniHelpRequestMutation({ ...mutationData, request: { ...detail, hasUnreadUpdate: "yes" } }))
      .toThrow(/hasUnreadUpdate/);
  });
  it("accepts the exact request detail and list DTOs", () => {
    expect(decodeAlumniHelpRequestMutation(mutationData)).toEqual(mutationData);
    expect(
      decodeAlumniHelpRequestPage({
        requests: [summary],
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalCount: 1,
          hasNext: false,
          hasPrev: false,
        },
        helpActionRequiredCount: 1,
      }),
    ).toMatchObject({ requests: [{ id: IDS.request }] });
  });

  it("rejects private participant fields and unknown top-level fields", () => {
    expect(() =>
      decodeAlumniHelpRequestMutation({
        ...mutationData,
        request: {
          ...detail,
          requester: {
            ...detail.requester,
            email: "private@example.com",
          },
        },
      }),
    ).toThrow(/exact keys/);
    expect(() =>
      decodeAlumniHelpRequestMutation({ ...mutationData, internal: true }),
    ).toThrow(/exact keys/);
  });

  it("rejects invalid actions, dates, and inconsistent pagination", () => {
    expect(() =>
      decodeAlumniHelpRequestMutation({
        ...mutationData,
        request: { ...detail, availableActions: ["admin_override"] },
      }),
    ).toThrow(/request_information/);
    expect(() =>
      decodeAlumniHelpRequestMutation({
        ...mutationData,
        request: { ...detail, updatedAt: "not-a-date" },
      }),
    ).toThrow(/ISO date/);
    expect(() =>
      decodeAlumniHelpRequestPage({
        requests: [],
        pagination: {
          currentPage: 1,
          totalPages: 2,
          totalCount: 20,
          hasNext: false,
          hasPrev: false,
        },
        helpActionRequiredCount: 0,
      }),
    ).toThrow(/consistent with pagination/);
  });
});

describe("Alumni Help API client", () => {
  it("acknowledges exactly the rendered revision without sending a workflow action", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      response({ helpActionRequiredCount: 1, helpNotificationCount: 1 }),
    );
    await expect(alumniHelpService.markRead(IDS.request, 7)).resolves.toEqual({
      helpActionRequiredCount: 1,
      helpNotificationCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/alumni-help-requests/${IDS.request}/read`),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ observedRevision: 7 }) }),
    );
  });
  it("rejects pagination whose complete MongoDB window is unsafe", async () => {
    await expect(
      alumniHelpService.list({
        view: "received",
        page: Number.MAX_SAFE_INTEGER,
        limit: 100,
      }),
    ).rejects.toThrow(/outside the supported range/);
  });

  it("uses canonical list, detail, terms, and action-count endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/terms")) {
        return response({
          terms: {
            consent: {
              version: "help-consent-v1",
              text: "Consent text",
              effectiveAt: "2026-09-12T00:00:00.000Z",
            },
            disclaimer: {
              version: "help-disclaimer-v1",
              text: "Disclaimer text",
              effectiveAt: "2026-09-12T00:00:00.000Z",
            },
          },
        });
      }
      if (pathname.endsWith("/action-required-count")) {
        return response({ helpActionRequiredCount: 1 });
      }
      if (pathname.endsWith(IDS.request)) return response(mutationData);
      return response({
        requests: [summary],
        pagination: {
          currentPage: 2,
          totalPages: 2,
          totalCount: 21,
          hasNext: false,
          hasPrev: true,
        },
        helpActionRequiredCount: 1,
      });
    });
    const controller = new AbortController();

    await alumniHelpService.getTerms(controller.signal);
    await alumniHelpService.getActionRequiredCount(controller.signal);
    await alumniHelpService.get(IDS.request, controller.signal);
    await alumniHelpService.list(
      { view: "received", page: 2, limit: 20 },
      controller.signal,
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/api/alumni-help-requests/terms"),
        expect.stringContaining("/api/alumni-help-requests/action-required-count"),
        expect.stringContaining(`/api/alumni-help-requests/${IDS.request}`),
        expect.stringContaining(
          "/api/alumni-help-requests?view=received&page=2&limit=20",
        ),
      ]),
    );
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.signal).toBe(controller.signal);
    }
  });

  it("sends revisions, payloads, and idempotency keys to action endpoints", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(mutationData));

    await alumniHelpService.requestInformation(IDS.request, 0, "More context?", validKey);
    await alumniHelpService.proposeAlternative(
      IDS.request,
      0,
      "warm_introduction",
      undefined,
      validKey,
    );
    await alumniHelpService.transition(IDS.request, "accept", 0, validKey);
    await alumniHelpService.submitOutcome(IDS.request, 1, "completed", validKey);
    await alumniHelpService.decideOutcome(
      IDS.request,
      IDS.outcome,
      "deny",
      2,
      validKey,
    );

    expect(
      fetchMock.mock.calls.map(([url, options]) => ({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(options?.body)),
        key: (options?.headers as Record<string, string>)["Idempotency-Key"],
      })),
    ).toEqual([
      {
        path: `/api/alumni-help-requests/${IDS.request}/request-information`,
        body: { expectedRevision: 0, note: "More context?" },
        key: validKey,
      },
      {
        path: `/api/alumni-help-requests/${IDS.request}/propose-alternative`,
        body: { expectedRevision: 0, proposedHelpType: "warm_introduction" },
        key: validKey,
      },
      {
        path: `/api/alumni-help-requests/${IDS.request}/accept`,
        body: { expectedRevision: 0 },
        key: validKey,
      },
      {
        path: `/api/alumni-help-requests/${IDS.request}/outcomes`,
        body: { expectedRevision: 1, outcomeCode: "completed" },
        key: validKey,
      },
      {
        path: `/api/alumni-help-requests/${IDS.request}/outcomes/${IDS.outcome}/deny`,
        body: { expectedRevision: 2 },
        key: validKey,
      },
    ]);
  });
});

export { detail as alumniHelpDetailFixture };
