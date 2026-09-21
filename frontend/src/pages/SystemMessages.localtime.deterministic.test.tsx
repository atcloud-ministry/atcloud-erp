/**
 * Deterministic local time conversion test.
 * Emulates Pacific viewer-local Date getters while retaining the real source-zone
 * conversion. Covers invitations without a backend-provided UTC anchor.
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

// Mock notification context with a single Role Invited message.
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

describe("SystemMessages deterministic local time conversion", () => {
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
      scenario: "converts 15:00 New York to 12:00 Pacific in daylight time",
      date: "2025-10-02",
      time: "15:00",
      expected: "2025-10-02 • 12:00",
    },
    {
      scenario: "converts 15:00 New York to 12:00 Pacific in standard time",
      date: "2025-01-02",
      time: "15:00",
      expected: "2025-01-02 • 12:00",
    },
    {
      scenario: "respects distinct DST transitions and the previous local day",
      date: "2025-03-09",
      time: "03:30",
      expected: "2025-03-08 • 23:30",
    },
  ])("$scenario", async ({ date, time, expected }) => {
    vi.mocked(systemMessageService.getSystemMessagesPaginated).mockResolvedValue({
      messages: [
        {
          ...buildRoleInvitedMessage({
            id: "m1",
            date,
            time,
            timeZone: "America/New_York",
            eventId: "evt1",
            eventTitle: "Community Meetup",
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
