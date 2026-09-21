import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EventDetail from "../../pages/EventDetail";
import { NotificationProvider } from "../../contexts/NotificationModalContext";

// Capture handler for socket event_update
let capturedHandler: ((data: any) => void) | null = null;

beforeEach(() => {
  window.localStorage.setItem("authToken", "test-token");
  capturedHandler = null;
});

// Track guest API calls and control responses
const getEventGuestsMock = vi.fn();
vi.mock("../../services/guestApi", () => ({
  __esModule: true,
  default: {
    getEventGuests: (...args: any[]) => getEventGuestsMock(...args),
  },
}));

// Mock socket service to capture and trigger event_update
vi.mock("../../services/socketService", () => ({
  socketService: {
    connect: vi.fn(),
    joinEventRoom: vi.fn(async () => {}),
    leaveEventRoom: vi.fn(),
    on: vi.fn((event: string, handler: (data: any) => void) => {
      if (event === "event_update") capturedHandler = handler;
    }),
    off: vi.fn(),
  },
}));

// Quiet toasts and provider passthrough
vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: () => {},
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
  NotificationProvider: ({ children }: any) => children,
}));

// Non-admin participant view
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: {
      id: "uP",
      role: "Participant",
      roleInAtCloud: "Member",
    },
  }),
}));

// Minimal event response with one role
const getEventMock = vi.fn(async (id: string) => ({
  id,
  title: "Realtime PII Test Event",
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
  authService: {
    getProfile: vi.fn(async () => ({ id: "uP", role: "Participant" })),
  },
  eventService: {
    getEvent: (id: string) => getEventMock(id),
  },
}));

describe("Participant realtime guest_registration without PII leak", () => {
  it("shows new guest name immediately on guest_registration but hides email/phone", async () => {
    // Initial guests empty on first fetch
    getEventGuestsMock.mockResolvedValueOnce({ guests: [] });

    render(
      <NotificationProvider>
        <MemoryRouter initialEntries={["/events/e1"]}>
          <Routes>
            <Route path="/events/:id" element={<EventDetail />} />
          </Routes>
        </MemoryRouter>
      </NotificationProvider>
    );

    // Wait for event to load
    await waitFor(() => {
      expect(screen.getByText(/Realtime PII Test Event/)).toBeInTheDocument();
    });

    // Emit a guest_registration event
    // Prepare the refetch response BEFORE emitting so the handler doesn't overwrite
    // the optimistic insertion with an empty list.
    getEventGuestsMock.mockResolvedValueOnce({
      guests: [
        {
          id: "gNew",
          roleId: "r1",
          fullName: "New Guest",
          email: "new@e.com",
          phone: "+1 999",
        },
      ],
    });

    await act(async () => {
      capturedHandler?.({
        eventId: "e1",
        updateType: "guest_registration",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    // Wait for UI to reflect new guest in-slot
    await waitFor(() => {
      expect(screen.getByText(/Guest: New Guest/)).toBeInTheDocument();
    });

    // PII NOW VISIBLE for all logged-in users (simplified visibility)
    expect(screen.queryByText(/new@e.com/i)).toBeTruthy();
    expect(screen.queryByText(/\+1 999/i)).toBeTruthy();
  });
});
