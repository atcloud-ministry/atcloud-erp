import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HelpRequests from "../../pages/HelpRequests";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  setCount: vi.fn(),
  socketHandler: null as (() => void) | null,
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  alumniHelpService: { list: mocks.list },
}));

vi.mock("../../contexts/AlumniHelpContext", () => ({
  useAlumniHelp: () => ({ setHelpActionRequiredCount: mocks.setCount }),
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
});

function renderPage(initialEntry = "/dashboard/community/help-requests") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          element={<HelpRequests />}
          path="/dashboard/community/help-requests"
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("HelpRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socketHandler = null;
    mocks.list.mockResolvedValue(page());
  });

  it("loads Action Needed by default and publishes the authoritative count", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Taylor Reed" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(
      { view: "action_required", page: 1, limit: 20 },
      expect.any(AbortSignal),
    );
    expect(mocks.setCount).toHaveBeenCalledWith(3);
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
    renderPage();
    await screen.findByRole("heading", { name: "Taylor Reed" });

    await user.click(screen.getByRole("link", { name: "Received" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        { view: "received", page: 1, limit: 20 },
        expect.any(AbortSignal),
      ),
    );

    mocks.socketHandler?.();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  });
});
