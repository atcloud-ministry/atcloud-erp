import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EventDetail from "../../pages/EventDetail";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

// Capture handler for socket event_update
let capturedHandler: ((data: any) => Promise<void> | void) | null = null;
const getEventGuestsMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  // Ensure a token exists so EventDetail registers socket listeners
  window.localStorage.setItem("authToken", "test-token");
  capturedHandler = null;
  getEventGuestsMock.mockReset();
  getEventGuestsMock.mockResolvedValue({
    guests: [
      {
        id: "g1",
        roleId: "r1",
        fullName: "Alpha Guest",
        email: "a@e.com",
        phone: "+1 111",
      },
      {
        id: "g2",
        roleId: "r1",
        fullName: "Beta Guest",
        email: "b@e.com",
        phone: "+1 222",
      },
    ],
  });
});

// Mock Guest API to return initial guests by role
vi.mock("../../services/guestApi", () => ({
  __esModule: true,
  default: {
    getEventGuests: getEventGuestsMock,
    resendManageLink: vi.fn(),
    adminCancelGuest: vi.fn(),
    adminUpdateGuest: vi.fn(),
  },
}));

// Mock socket service to capture and trigger event_update
vi.mock("../../services/socketService", () => ({
  socketService: {
    connect: vi.fn(),
    joinEventRoom: vi.fn(async () => {}),
    leaveEventRoom: vi.fn(),
    on: vi.fn(
      (event: string, handler: (data: any) => Promise<void> | void) => {
      if (event === "event_update") capturedHandler = handler;
      }
    ),
    off: vi.fn(),
  },
}));

// Quiet toasts and provide provider passthrough
vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: () => {},
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
  NotificationProvider: ({ children }: any) => children,
}));

// Mock auth as admin
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: {
      id: "admin",
      role: "Administrator",
      roleInAtCloud: "Administrator",
    },
  }),
}));

// Mock event service
const getEventMock = vi.fn(async (id: string) => ({
  id,
  title: "Realtime Test Event",
  type: "Meeting",
  date: "2025-12-01",
  time: "10:00",
  endTime: "11:00",
  timeZone: "America/New_York",
  roles: [
    { id: "r1", name: "Role A", maxParticipants: 2, currentSignups: [] },
    { id: "r2", name: "Role B", maxParticipants: 2, currentSignups: [] },
  ],
  totalSignups: 0,
  totalSlots: 4,
  createdBy: { id: "u1" },
  createdAt: new Date().toISOString(),
  description: "desc",
  isHybrid: false,
  status: "upcoming",
  attendees: [],
}));

vi.mock("../../services/api", () => ({
  __esModule: true,
  authService: {
    getProfile: vi.fn(async () => ({ id: "admin", role: "Administrator" })),
  },
  eventService: {
    getEvent: (id: string) => getEventMock(id),
    signUpForEvent: vi.fn(),
    updateWorkshopGroupTopic: vi.fn(),
    cancelSignup: vi.fn(),
    removeUserFromRole: vi.fn(),
    moveUserBetweenRoles: vi.fn(),
    deleteEvent: vi.fn(),
    updateEvent: vi.fn(),
    assignUserToRole: vi.fn(),
  },
}));

describe("EventDetail admin realtime guest updates", () => {
  it("removes a guest on guest_cancellation and keeps list stable on guest_updated", async () => {
    render(
      <NotificationProvider>
        <MemoryRouter initialEntries={["/events/e1"]}>
          <Routes>
            <Route path="/events/:id" element={<EventDetail />} />
          </Routes>
        </MemoryRouter>
      </NotificationProvider>
    );

    // Initial load: two guests in Role A, button disabled (full by guests)
    await waitFor(() => {
      expect(screen.getAllByText(/Guests:/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Alpha Guest")).toBeInTheDocument();
    expect(screen.getByText("Beta Guest")).toBeInTheDocument();

    // Open the Sign Up dropdown within each role card specifically
    const roleACardHeading = screen.getByRole("heading", { name: "Role A" });
    const roleACard = roleACardHeading.closest(".border");
    expect(roleACard).toBeTruthy();
    const roleBCardHeading = screen.getByRole("heading", { name: "Role B" });
    const roleBCard = roleBCardHeading.closest(".border");
    expect(roleBCard).toBeTruthy();

    // Role A (2 guests, max 2) => full; no Sign Up button in Actions
    expect(
      within(roleACard as HTMLElement).queryByRole("button", {
        name: /^Sign Up$/i,
      })
    ).toBeNull();

    // Role B (0 guests, max 2) => not full
    within(roleBCard as HTMLElement)
      .getByRole("button", { name: /^Sign Up$/i })
      .click();
    let inviteGuestItem = await within(roleBCard as HTMLElement).findByText(
      /Invite Guest/i
    );
    expect(
      inviteGuestItem.closest("button")?.hasAttribute("disabled") ?? false
    ).toBe(false);
    within(roleBCard as HTMLElement)
      .getByRole("button", { name: /^Sign Up$/i })
      .click();

    // Fire a guest_updated event (no change expected visually)
    await act(async () => {
      capturedHandler?.({
        eventId: "e1",
        updateType: "guest_updated",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    // Still both present
    expect(await screen.findByText("Alpha Guest")).toBeInTheDocument();
    expect(screen.getByText("Beta Guest")).toBeInTheDocument();

    // The authorized HTTP refresh now reflects the cancellation.
    getEventGuestsMock.mockResolvedValue({
      guests: [
        {
          id: "g2",
          roleId: "r1",
          fullName: "Beta Guest",
          email: "b@e.com",
          phone: "+1 222",
        },
      ],
    });

    // Fire an invalidation-only guest_cancellation notification.
    await act(async () => {
      capturedHandler?.({
        eventId: "e1",
        updateType: "guest_cancellation",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    // Alpha should be removed; Role A becomes not full (1/2)
    await waitFor(() => {
      expect(screen.queryByText("Alpha Guest")).toBeNull();
    });
    expect(screen.getByText("Beta Guest")).toBeInTheDocument();

    // Role A should now have a Sign Up button and Invite Guest enabled
    const roleASignUpBtn = within(roleACard as HTMLElement).getByRole(
      "button",
      { name: /^Sign Up$/i }
    );
    roleASignUpBtn.click();
    inviteGuestItem = await within(roleACard as HTMLElement).findByText(
      /Invite Guest/i
    );
    expect(
      inviteGuestItem.closest("button")?.hasAttribute("disabled") ?? false
    ).toBe(false);
    // Role B remains enabled
    within(roleBCard as HTMLElement)
      .getByRole("button", { name: /^Sign Up$/i })
      .click();
    inviteGuestItem = await within(roleBCard as HTMLElement).findByText(
      /Invite Guest/i
    );
    expect(
      inviteGuestItem.closest("button")?.hasAttribute("disabled") ?? false
    ).toBe(false);
  });

  it("keeps an earlier guest refresh eligible when a later non-guest update arrives", async () => {
    render(
      <NotificationProvider>
        <MemoryRouter initialEntries={["/events/e1"]}>
          <Routes>
            <Route path="/events/:id" element={<EventDetail />} />
          </Routes>
        </MemoryRouter>
      </NotificationProvider>
    );

    await screen.findByText("Alpha Guest");

    let resolveGuestRefresh!: (value: {
      guests: Array<{
        id: string;
        roleId: string;
        fullName: string;
        email: string;
      }>;
    }) => void;
    const pendingGuestRefresh = new Promise<{
      guests: Array<{
        id: string;
        roleId: string;
        fullName: string;
        email: string;
      }>;
    }>((resolve) => {
      resolveGuestRefresh = resolve;
    });
    getEventGuestsMock.mockReturnValueOnce(pendingGuestRefresh);

    let firstUpdate: Promise<void> | void;
    act(() => {
      firstUpdate = capturedHandler?.({
        eventId: "e1",
        updateType: "guest_updated",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(getEventGuestsMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      await capturedHandler?.({
        eventId: "e1",
        updateType: "attendance_updated",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    await act(async () => {
      resolveGuestRefresh({
        guests: [
          {
            id: "g3",
            roleId: "r1",
            fullName: "Gamma Guest",
            email: "g@e.com",
          },
        ],
      });
      await firstUpdate;
    });

    expect(await screen.findByText("Gamma Guest")).toBeInTheDocument();
    expect(screen.queryByText("Alpha Guest")).toBeNull();
  });
});
