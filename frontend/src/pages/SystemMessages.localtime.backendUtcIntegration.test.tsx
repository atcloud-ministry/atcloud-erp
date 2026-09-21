/**
 * Integration-oriented test: uses backend-like UTC calculation expectations.
 * Verifies that when backend supplies eventDateTimeUtc for a Role Invited message,
 * the frontend replaces Event Time line with the viewer-local conversion and does NOT
 * regress to incorrect naive interpretation (e.g., showing 08:00 instead of 12:00).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { mockAuthContext } from "../test/test-utils/mockAuth";
import { buildRoleInvitedMessage } from "../test/test-utils/systemMessageBuilder";
import { mockViewerLocalDateGetters } from "../test/test-utils/mockViewerLocalDateGetters";
import { systemMessageService } from "../services/systemMessageService";

mockAuthContext({ currentUser: { id: "u1", role: "Administrator" } });

async function renderSystemMessages() {
  const { default: SystemMessages } = await import("./SystemMessages");
  render(<SystemMessages />);
}

vi.mock("../contexts/NotificationContext", () => ({
  useNotifications: () => ({
    systemMessages: [],
    markSystemMessageAsRead: vi.fn(),
    reloadSystemMessages: vi.fn(),
  }),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ hash: "", pathname: "/dashboard/system-messages" }),
}));

vi.mock("../services/systemMessageService", () => ({
  systemMessageService: {
    getSystemMessagesPaginated: vi.fn(),
  },
}));

describe("SystemMessages backend-supplied UTC integration", () => {
  let restoreViewerLocalDateGetters: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    restoreViewerLocalDateGetters = mockViewerLocalDateGetters(
      "America/Los_Angeles",
    );
  });
  afterEach(() => restoreViewerLocalDateGetters());

  it.each([
    {
      scenario: "renders 12:00 Pacific from the backend UTC anchor",
      date: "2025-10-02",
      time: "15:00",
      utc: "2025-10-02T19:00:00.000Z",
      expected: "2025-10-02 • 12:00",
    },
    {
      scenario: "prefers the UTC anchor over inconsistent source clock fields",
      date: "2025-10-02",
      time: "08:00",
      utc: "2025-10-02T19:00:00.000Z",
      expected: "2025-10-02 • 12:00",
    },
    {
      scenario: "converts the viewer calendar date across the year boundary",
      date: "2025-01-01",
      time: "01:00",
      utc: "2025-01-01T06:00:00.000Z",
      expected: "2024-12-31 • 22:00",
    },
  ])("$scenario", async ({ date, time, utc, expected }) => {
    vi.mocked(systemMessageService.getSystemMessagesPaginated).mockResolvedValue({
      messages: [
        {
          ...buildRoleInvitedMessage({
            id: "mUtc1",
            date,
            time,
            timeZone: "America/New_York",
            utc,
            eventId: "evtUtc1",
            eventTitle: "UTC Supply Test",
            createdAt: "2025-09-01T00:00:00.000Z",
          }),
          isActive: true,
          updatedAt: "2025-09-01T00:00:00.000Z",
        },
      ],
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalCount: 1,
        hasNext: false,
        hasPrev: false,
      },
      unreadCount: 1,
    });
    await renderSystemMessages();
    const para = await screen.findByText(/Alice Admin invited you/, {
      exact: false,
    });
    expect(para.textContent).toContain(
      `Event Time: ${expected} (your local time)`,
    );
  });
});
