import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EventDetail from "../../pages/EventDetail";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

let capturedHandler: ((data: any) => void) | null = null;
beforeEach(() => {
  window.localStorage.setItem("authToken", "tkn");
  capturedHandler = null;
});

const getEventGuestsMock = vi.fn();
vi.mock("../../services/guestApi", () => ({
  __esModule: true,
  default: {
    getEventGuests: (...args: any[]) => getEventGuestsMock(...args),
  },
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    connect: vi.fn(),
    joinEventRoom: vi.fn(async () => {}),
    leaveEventRoom: vi.fn(),
    on: vi.fn((event: string, handler: (d: any) => void) => {
      if (event === "event_update") capturedHandler = handler;
    }),
    off: vi.fn(),
  },
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: () => {},
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
  NotificationProvider: ({ children }: any) => children,
}));

// Admin view for ease of locating names in admin list
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: {
      id: "admin",
      role: "Administrator",
      roleInAtCloud: "Administrator",
    },
  }),
}));

const getEventMock = vi.fn(async (id: string) => ({
  id,
  title: "Cancel No Refetch Test",
  type: "Meeting",
  date: "2025-12-01",
  time: "10:00",
  endTime: "11:00",
  timeZone: "America/New_York",
  roles: [{ id: "r1", name: "Role A", maxParticipants: 2, currentSignups: [] }],
  totalSignups: 0,
  totalSlots: 2,
  createdBy: { id: "u1" },
  createdAt: new Date().toISOString(),
  description: "desc",
  isHybrid: false,
  status: "upcoming",
  attendees: [],
}));

vi.mock("../../services/api", () => ({
  __esModule: true,
  eventService: {
    getEvent: (id: string) => getEventMock(id),
  },
}));

describe("Guest cancellation invalidation", () => {
  it("refetches authorized guest data when the socket payload contains no details", async () => {
    // Initial guest list contains one guest
    getEventGuestsMock.mockResolvedValueOnce({
      guests: [
        {
          id: "g1",
          roleId: "r1",
          fullName: "Alpha Guest",
          email: "a@e.com",
          phone: "+1 111",
        },
      ],
    });

    render(
      <NotificationProvider>
        <MemoryRouter initialEntries={["/events/e1"]}>
          <Routes>
            <Route path="/events/:id" element={<EventDetail />} />
          </Routes>
        </MemoryRouter>
      </NotificationProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Cancel No Refetch Test/)).toBeInTheDocument();
    });

    // Ensure Alpha present initially (scope to admin guest list block)
    const adminGuests = await screen.findByTestId("admin-guests-r1");
    expect(within(adminGuests).getByText(/Alpha Guest/)).toBeInTheDocument();

    // Clear mock call count before triggering cancellation
    getEventGuestsMock.mockClear();
    getEventGuestsMock.mockResolvedValueOnce({ guests: [] });

    await act(async () => {
      capturedHandler?.({
        eventId: "e1",
        updateType: "guest_cancellation",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    // Guest should be removed using the refreshed authorized response.
    await waitFor(() => {
      expect(screen.queryByTestId("admin-guests-r1")).toBeNull();
    });

    expect(getEventGuestsMock).toHaveBeenCalledOnce();
    expect(getEventGuestsMock).toHaveBeenCalledWith("e1");
  });
});
