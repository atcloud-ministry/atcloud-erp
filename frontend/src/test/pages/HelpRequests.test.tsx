import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HelpRequests from "../../pages/HelpRequests";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  setCount: vi.fn(),
  captureGeneration: vi.fn(() => 0),
  helpRefreshSequence: 0,
  socketHandler: null as (() => void) | null,
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniHelpService: { list: mocks.list },
}));

vi.mock("../../contexts/AlumniHelpContext", () => ({
  useAlumniHelp: () => ({
    setHelpNotificationCounts: mocks.setCount,
    captureHelpCounterGeneration: mocks.captureGeneration,
    helpRefreshSequence: mocks.helpRefreshSequence,
  }),
}));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: { mode: "on", readable: true, writable: true },
    },
  }),
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    on: vi.fn((_event: string, handler: () => void) => {
      mocks.socketHandler = handler;
      return () => {
        mocks.socketHandler = null;
      };
    }),
  },
}));

const request = {
  id: "64b000000000000000000001",
  requester: {
    id: "64b000000000000000000002",
    displayName: "Taylor Reed",
    avatar: null,
  },
  provider: {
    id: "64b000000000000000000003",
    displayName: "Amy Chen",
    avatar: null,
  },
  status: "requested" as const,
  requestedHelpType: "career_advice" as const,
  proposedHelpType: null,
  agreedHelpType: null,
  conversationId: null,
  viewerRole: "provider" as const,
  actionRequiredForViewer: true,
  hasUnreadUpdate: true,
  availableActions: ["accept" as const, "decline" as const],
  latestOutcome: null,
  revision: 0,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
  closedAt: null,
};

const page = (requests = [request], count = 3) => ({
  requests,
  pagination: {
    currentPage: 1,
    totalPages: requests.length ? 1 : 0,
    totalCount: requests.length,
    hasNext: false,
    hasPrev: false,
  },
  helpActionRequiredCount: count,
  helpNotificationCount: count,
});

function PageHarness({ initialEntry = "/dashboard/community/help-requests" }: { initialEntry?: string }) {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          element={<HelpRequests />}
          path="/dashboard/community/help-requests"
        />
      </Routes>
    </MemoryRouter>
  );
}

function renderPage(initialEntry?: string) {
  return render(<PageHarness initialEntry={initialEntry} />);
}

describe("HelpRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socketHandler = null;
    mocks.helpRefreshSequence = 0;
    mocks.list.mockResolvedValue(page());
  });

  it("loads unread updates and pending actions by default and publishes both counts", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Taylor Reed" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(
      { view: "updates", page: 1, limit: 20 },
      expect.any(AbortSignal),
    );
    expect(mocks.setCount).toHaveBeenCalledWith(expect.objectContaining({ helpActionRequiredCount: 3, helpNotificationCount: 3 }), 0);
    expect(screen.getByText("Action required")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View Request" }),
    ).toHaveAttribute(
      "href",
      "/dashboard/community/help-requests/64b000000000000000000001",
    );
  });

  it("keeps the selected view in the URL and refreshes after a workflow event", async () => {
    const user = userEvent.setup();
    const rendered = renderPage();
    await screen.findByRole("heading", { name: "Taylor Reed" });

    await user.click(screen.getByRole("link", { name: "Received" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        { view: "received", page: 1, limit: 20 },
        expect.any(AbortSignal),
      ),
    );

    mocks.helpRefreshSequence += 1;
    rendered.rerender(<PageHarness />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });

  it("keeps the action-only view separately addressable", async () => {
    renderPage("/dashboard/community/help-requests?view=action_required");
    await screen.findByRole("heading", { name: "Taylor Reed" });
    expect(mocks.list).toHaveBeenCalledWith(
      { view: "action_required", page: 1, limit: 20 },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("link", { name: "Action Needed" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Updates" })).toHaveAttribute("href", "/dashboard/community/help-requests");
  });
});
