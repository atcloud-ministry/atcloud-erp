import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, waitFor } from "@testing-library/react";
import EventDetail from "../../pages/EventDetail";
import { installDefaultFetchMock } from "../fixtures/defaultFetch";

installDefaultFetchMock();

// Toast spies
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

// Auth mocks
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "u1", role: "Administrator" } }),
}));
vi.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "u1", role: "Administrator" } }),
}));

// Socket mock capturing event_update handler
const socketMock = vi.hoisted(() => {
  let handler: ((p: any) => void) | null = null;
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
vi.mock("../../services/socketService", () => socketMock.make());

// Base published event returned by eventService.getEvent (first fetch and interim refetch)
const publishedEvent = {
  id: "e1",
  title: "Sample Event",
  type: "Meeting",
  date: "2025-12-01",
  time: "10:00",
  endTime: "11:00",
  timeZone: "America/New_York",
  location: "123 Main St",
  organizer: "u1",
  roles: [
    { id: "r1", name: "Facilitator", maxParticipants: 2, currentSignups: [] },
  ],
  signedUp: 0,
  totalSlots: 2,
  createdBy: { id: "u1" },
  createdAt: new Date().toISOString(),
  format: "Online",
  publish: true,
  publishedAt: new Date().toISOString(),
  zoomLink: "https://zoom.us/j/123",
  meetingId: "123456789",
  passcode: "abc123",
};

// Unpublished version missing required fields (simulate backend auto-unpublish)
const autoUnpublishedEvent = {
  ...publishedEvent,
  publish: false,
  zoomLink: "", // cleared -> missing
  autoUnpublishedReason: "MISSING_REQUIRED_FIELDS",
  autoUnpublishedAt: new Date().toISOString(),
};

// eventService mock with programmable sequence
const getEventMock = vi.fn();
vi.mock("../../services/api", () => ({
  __esModule: true,
  eventService: {
    getEvent: (...args: any[]) => getEventMock(...args),
    publishEvent: vi.fn(),
    unpublishEvent: vi.fn(),
  },
}));
vi.mock("../../services/guestApi", () => ({
  __esModule: true,
  default: { getEventGuests: vi.fn(async () => ({ guests: [] })) },
}));

describe("EventDetail realtime auto-unpublish toast", () => {
  beforeEach(() => {
    socketMock.reset();
    toasts.warning.mockReset();
    toasts.info.mockReset();
    toasts.error.mockReset();
    toasts.success.mockReset();
    localStorage.setItem("authToken", "test-token");
    // First two getEvent calls (initial load + post-event_update refetch) will return published then unpublished variant
    getEventMock.mockReset();
    // First call -> published, subsequent calls -> auto-unpublished variant
    let callCount = 0;
    getEventMock.mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(
        callCount === 1 ? publishedEvent : autoUnpublishedEvent
      );
    });
  });
  afterEach(() => {
    localStorage.removeItem("authToken");
  });

  it("fires exactly one warning toast when publish→unpublish transition with missing fields reason occurs", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard/event/e1"]}>
        <Routes>
          <Route path="/dashboard/event/:id" element={<EventDetail />} />
        </Routes>
      </MemoryRouter>
    );

    // Wait for initial load
    await waitFor(() => expect(getEventMock).toHaveBeenCalledTimes(1));

    // Emit an event_update indicating data changed (any update type causing refetch)
    socketMock.emit({
      eventId: "e1",
      updateType: "guest_registration", // triggers refetch path without requiring embedded event shape
      data: null,
      timestamp: new Date().toISOString(),
    });

    // Wait for refetch and toast invocation
    await waitFor(() => {
      expect(getEventMock).toHaveBeenCalledTimes(2);
      expect(toasts.warning).toHaveBeenCalledTimes(1);
      const msg = toasts.warning.mock.calls[0][0] as string;
      expect(msg).toMatch(/automatically unpublished/i);
      expect(msg).toMatch(/missing/i);
      expect(msg).toMatch(/Zoom Link/i); // readable label
    });

    // Emit a second unrelated update to ensure no duplicate toast
    socketMock.emit({
      eventId: "e1",
      updateType: "guest_cancellation",
      data: null,
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(getEventMock).toHaveBeenCalledTimes(3));
    expect(toasts.warning).toHaveBeenCalledTimes(1); // still only one
  });
});
