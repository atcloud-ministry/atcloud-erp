import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HelpRequestDetail from "../../pages/HelpRequestDetail";
import type { AlumniHelpRequestDetailDTO } from "../../services/api";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  transition: vi.fn(),
  requestInformation: vi.fn(),
  provideInformation: vi.fn(),
  proposeAlternative: vi.fn(),
  submitOutcome: vi.fn(),
  decideOutcome: vi.fn(),
  setCount: vi.fn(),
  announceHelpRoomCreated: vi.fn(),
  writable: true,
  socketHandler: null as ((payload: unknown) => void) | null,
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniHelpService: {
    get: mocks.get,
    transition: mocks.transition,
    requestInformation: mocks.requestInformation,
    provideInformation: mocks.provideInformation,
    proposeAlternative: mocks.proposeAlternative,
    submitOutcome: mocks.submitOutcome,
    decideOutcome: mocks.decideOutcome,
  },
}));

vi.mock("../../contexts/AlumniHelpContext", () => ({
  useAlumniHelp: () => ({
    setHelpActionRequiredCount: mocks.setCount,
    announceHelpRoomCreated: mocks.announceHelpRoomCreated,
  }),
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: {
        mode: mocks.writable ? "on" : "read_only",
        readable: true,
        writable: mocks.writable,
      },
    },
  }),
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    on: vi.fn((_event: string, handler: (payload: unknown) => void) => {
      mocks.socketHandler = handler;
      return () => {
        mocks.socketHandler = null;
      };
    }),
  },
}));

const IDS = {
  request: "64b000000000000000000001",
  requester: "64b000000000000000000002",
  provider: "64b000000000000000000003",
  profile: "64b000000000000000000004",
  timeline: "64b000000000000000000005",
  outcome: "64b000000000000000000006",
  conversation: "64b000000000000000000007",
};

function makeRequest(
  overrides: Partial<AlumniHelpRequestDetailDTO> = {},
): AlumniHelpRequestDetailDTO {
  return {
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
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={[
        `/dashboard/community/help-requests/${IDS.request}`,
      ]}
    >
      <Routes>
        <Route
          element={<HelpRequestDetail />}
          path="/dashboard/community/help-requests/:requestId"
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("HelpRequestDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writable = true;
    mocks.socketHandler = null;
    const request = makeRequest();
    mocks.get.mockResolvedValue({ request, helpActionRequiredCount: 1 });
    mocks.requestInformation.mockResolvedValue({
      request: makeRequest({
        status: "needs_information",
        revision: 1,
        availableActions: [],
      }),
      helpActionRequiredCount: 0,
    });
    mocks.proposeAlternative.mockResolvedValue({
      request: makeRequest({
        status: "alternative_proposed",
        revision: 1,
        proposedHelpType: "warm_introduction",
        availableActions: [],
      }),
      helpActionRequiredCount: 0,
    });
  });

  it("renders server-authorized actions, information exchange, and alternatives", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Taylor Reed" })).toBeInTheDocument();
    expect(
      screen.getAllByText("Could we discuss a career transition?"),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request information" }));
    await user.type(screen.getByLabelText("What information do you need?"), "What field are you targeting?");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mocks.requestInformation).toHaveBeenCalledOnce());
    expect(mocks.requestInformation.mock.calls[0].slice(0, 3)).toEqual([
      IDS.request,
      0,
      "What field are you targeting?",
    ]);
    expect(mocks.requestInformation.mock.calls[0][3]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mocks.setCount).toHaveBeenCalledWith(0);
  });

  it("offers only server-supplied alternative types", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "Taylor Reed" });

    await user.click(screen.getByRole("button", { name: "Propose alternative" }));
    expect(screen.getByLabelText("Warm Introduction")).toBeInTheDocument();
    expect(screen.queryByLabelText("Formal Employee Referral")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Warm Introduction"));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mocks.proposeAlternative).toHaveBeenCalledOnce());
    expect(mocks.proposeAlternative.mock.calls[0].slice(0, 4)).toEqual([
      IDS.request,
      0,
      "warm_introduction",
      undefined,
    ]);
  });

  it("announces the newly created Chat Room immediately after accepting", async () => {
    const user = userEvent.setup();
    const accepted = makeRequest({
      status: "accepted",
      agreedHelpType: "career_advice",
      conversationId: IDS.conversation,
      revision: 1,
      availableActions: ["start", "complete"],
      acceptedAt: "2026-09-13T12:00:00.000Z",
    });
    mocks.transition.mockResolvedValue({
      request: accepted,
      helpActionRequiredCount: 0,
    });
    renderPage();

    await screen.findByRole("heading", { name: "Taylor Reed" });
    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
    expect(mocks.announceHelpRoomCreated).toHaveBeenCalledWith(
      IDS.request,
      IDS.conversation,
    );
  });

  it("renders all three referral outcomes and submits the selected result", async () => {
    const user = userEvent.setup();
    const accepted = makeRequest({
      status: "accepted",
      requestedHelpType: "formal_employee_referral",
      agreedHelpType: "formal_employee_referral",
      viewerRole: "requester",
      actionRequiredForViewer: false,
      availableActions: ["submit_outcome", "close"],
      acceptedAt: "2026-09-13T12:00:00.000Z",
      conversationId: IDS.conversation,
      availableAlternativeHelpTypes: [],
    });
    mocks.get.mockResolvedValue({ request: accepted, helpActionRequiredCount: 0 });
    mocks.submitOutcome.mockResolvedValue({
      request: makeRequest({ ...accepted, availableActions: [] }),
      helpActionRequiredCount: 0,
    });
    renderPage();

    expect(await screen.findByText("Help Room created")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Help Room" })).toHaveAttribute(
      "href",
      `/dashboard/chat-rooms/${IDS.conversation}`,
    );
    expect(screen.getByLabelText("Formal Employee Referral did not take place")).toBeInTheDocument();
    expect(screen.getByLabelText(/led to an interview, but not a hire/)).toBeInTheDocument();
    expect(screen.getByLabelText(/led to an interview and a hire/)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/led to an interview and a hire/));
    await user.click(screen.getByRole("button", { name: "Submit Result" }));
    await waitFor(() => expect(mocks.submitOutcome).toHaveBeenCalledOnce());
    expect(mocks.submitOutcome.mock.calls[0].slice(0, 3)).toEqual([
      IDS.request,
      0,
      "hired_after_interview",
    ]);
  });

  it("shows pending deadline and lets only the provider confirm or deny", async () => {
    const outcome = {
      id: IDS.outcome,
      revisionNumber: 1,
      previousSubmissionId: null,
      agreedHelpType: "career_advice" as const,
      outcomeCode: "completed" as const,
      status: "pending" as const,
      submittedAt: "2026-09-14T12:00:00.000Z",
      dueAt: "2026-10-04T12:00:00.000Z",
      decidedAt: null,
      confirmationMethod: null,
      revision: 2,
    };
    const pending = makeRequest({
      status: "closed",
      agreedHelpType: "career_advice",
      viewerRole: "provider",
      actionRequiredForViewer: true,
      availableActions: ["confirm_outcome", "deny_outcome"],
      latestOutcome: outcome,
      outcomes: [outcome],
      closedAt: "2026-09-14T12:00:00.000Z",
    });
    mocks.get.mockResolvedValue({ request: pending, helpActionRequiredCount: 1 });
    mocks.decideOutcome.mockResolvedValue({
      request: makeRequest({ ...pending, availableActions: [] }),
      helpActionRequiredCount: 0,
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/Awaiting provider confirmation until/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm Result" }));
    await waitFor(() => expect(mocks.decideOutcome).toHaveBeenCalledOnce());
    expect(mocks.decideOutcome.mock.calls[0].slice(0, 4)).toEqual([
      IDS.request,
      IDS.outcome,
      "confirm",
      2,
    ]);
  });

  it("keeps all mutations unavailable in read-only mode", async () => {
    mocks.writable = false;
    renderPage();

    expect(await screen.findByRole("status")).toHaveTextContent("currently read-only");
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
