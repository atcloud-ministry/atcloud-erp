import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EventDetail from "../../pages/EventDetail";
// Hoisted socket mock & emitter to safely use inside vi.mock
const socketTest = vi.hoisted(() => {
  let handler: ((payload: any) => void) | null = null;
  return {
    make: () => ({
      socketService: {
        connect: vi.fn(),
        joinEventRoom: vi.fn(async () => {}),
        leaveEventRoom: vi.fn(),
        on: vi.fn((evt: string, cb: any) => {
          if (evt === "event_update") handler = cb;
        }),
        off: vi.fn(),
      },
    }),
    emit: (payload: any) => {
      if (!handler) throw new Error("event_update handler not registered");
      handler(payload);
    },
    reset: () => {
      handler = null;
    },
  };
});

// Hoisted spies used inside vi.mock factories
const hoisted = vi.hoisted(() => ({
  infoSpy: vi.fn(),
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: hoisted.infoSpy,
    warning: vi.fn(),
  }),
  NotificationProvider: ({ children }: any) => children,
}));

// Mock socket using shared util
vi.mock("../../services/socketService", () => socketTest.make());

// Ensure admin view to enable realtime notifications
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "admin", role: "Super Admin" } }),
}));
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "admin", role: "Super Admin" } }),
}));

vi.mock("../../services/api", () => ({
  __esModule: true,
  authService: {
    getProfile: vi.fn(async () => ({ id: "admin", role: "Super Admin" })),
  },
  eventService: {
    getEvent: vi.fn(async (id: string) => ({
      id,
      title: "Realtime DnD Event",
      type: "Meeting",
      date: "2025-12-01",
      time: "10:00",
      endTime: "12:00",
      timeZone: "America/New_York",
      roles: [
        { id: "r1", name: "Role A", maxParticipants: 2, currentSignups: [] },
        { id: "r2", name: "Role B", maxParticipants: 2, currentSignups: [] },
      ],
      status: "upcoming",
      attendees: [],
    })),
  },
}));

vi.mock("../../services/guestApi", () => ({
  __esModule: true,
  default: {
    getEventGuests: vi.fn(async () => ({ guests: [] })),
  },
}));

describe("EventDetail realtime guest_moved invalidation", () => {
  it("shows a generic notification when guest_moved data is null", async () => {
    socketTest.reset();
    render(
      <MemoryRouter initialEntries={["/events/e1"]}>
        <Routes>
          <Route path="/events/:id" element={<EventDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // wait until event is loaded
    await waitFor(() =>
      expect(screen.getByText(/Realtime DnD Event/)).toBeInTheDocument()
    );

    // Simulate the backend's invalidation-only payload.
    await waitFor(() => {
      socketTest.emit({
        eventId: "e1",
        updateType: "guest_moved",
        data: null,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => expect(hoisted.infoSpy).toHaveBeenCalled());
    const messageArg = hoisted.infoSpy.mock.calls.at(-1)?.[0];
    expect(String(messageArg)).toBe("Event information has changed.");
    expect(String(messageArg)).not.toMatch(/guest|Role A|Role B/i);
  });
});
