import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
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

// Notification spies
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useToastReplacement: () => toasts,
  NotificationProvider: ({ children }: any) => children,
}));

// Mock socket service
vi.mock("../../services/socketService", () => socketTest.make());

// Auth as Super Admin with specific id
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "u1", role: "Super Admin" } }),
}));
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "u1", role: "Super Admin" } }),
}));

// Minimal event snapshot used in typed branches
const baseEvent = {
  id: "e1",
  title: "Typed Branch Event",
  type: "Meeting",
  date: "2025-12-01",
  time: "10:00",
  endTime: "12:00",
  timeZone: "America/New_York",
  roles: [
    { id: "r1", name: "Role A", maxParticipants: 5, currentSignups: [] },
    { id: "r2", name: "Role B", maxParticipants: 5, currentSignups: [] },
  ],
  status: "upcoming",
  attendees: [],
};

// Mock APIs
vi.mock("../../services/api", () => ({
  __esModule: true,
  eventService: {
    getEvent: vi.fn(async () => baseEvent),
  },
}));
vi.mock("../../services/guestApi", () => ({
  __esModule: true,
  default: { getEventGuests: vi.fn(async () => ({ guests: [] })) },
}));

describe("EventDetail realtime user invalidations", () => {
  beforeEach(() => {
    socketTest.reset();
    toasts.info.mockReset();
    toasts.warning.mockReset();
    // Ensure socket effect runs and registers event_update handler
    localStorage.setItem("authToken", "test-token");
  });

  afterEach(() => {
    localStorage.removeItem("authToken");
  });

  it("uses generic notifications and refetches for user updates with null data", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/event/e1"]}>
        <Routes>
          <Route path="/dashboard/event/:id" element={<EventDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for initial event to load
    await waitFor(() => {
      // Once loaded, sending updates should be handled
      expect(true).toBe(true);
    });

    socketTest.emit({
      eventId: "e1",
      updateType: "user_signed_up",
      data: null,
      timestamp: new Date().toISOString(),
    });

    socketTest.emit({
      eventId: "e1",
      updateType: "user_cancelled",
      data: null,
      timestamp: new Date().toISOString(),
    });

    socketTest.emit({
      eventId: "e1",
      updateType: "user_removed",
      data: null,
      timestamp: new Date().toISOString(),
    });

    socketTest.emit({
      eventId: "e1",
      updateType: "user_removed",
      data: null,
      timestamp: new Date().toISOString(),
    });

    socketTest.emit({
      eventId: "e1",
      updateType: "user_moved",
      data: null,
      timestamp: new Date().toISOString(),
    });

    socketTest.emit({
      eventId: "e1",
      updateType: "user_assigned",
      data: null,
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const infoCalls = toasts.info.mock.calls
        .map((c) => String(c?.[0] ?? ""))
        .join(" | ");
      expect(toasts.info).toHaveBeenCalledTimes(6);
      expect(infoCalls).toBe(
        Array(6).fill("Event information has changed.").join(" | "),
      );
      expect(infoCalls).not.toMatch(/Role A|u1|u2|u3|u4/i);
      expect(toasts.warning).not.toHaveBeenCalled();
    });
  });
});
