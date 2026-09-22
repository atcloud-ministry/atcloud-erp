import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlumniHelpProvider,
  isAlumniHelpUpdatePayload,
  useAlumniHelp,
} from "../../contexts/AlumniHelpContext";

const mocks = vi.hoisted(() => ({
  getNotificationCounts: vi.fn(),
  socketHandlers: new Map<string, (payload?: unknown) => void>(),
  showNotification: vi.fn(),
  userId: "64b000000000000000000001" as string | null,
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: mocks.userId ? { id: mocks.userId } : null }),
}));

vi.mock("../../hooks/useSocket", () => ({ useSocket: vi.fn() }));

vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: { mode: "on", readable: true, writable: true },
    },
  }),
}));

vi.mock("../../contexts/NotificationModalContext", () => ({
  useNotification: () => ({ showNotification: mocks.showNotification }),
}));

vi.mock("../../services/api", () => ({
  alumniHelpService: {
    getNotificationCounts: mocks.getNotificationCounts,
  },
}));

vi.mock("../../services/socketService", () => ({
  socketService: {
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      mocks.socketHandlers.set(event, handler);
      return () => {
        mocks.socketHandlers.delete(event);
      };
    }),
  },
}));

function CountProbe() {
  const { helpActionRequiredCount, helpNotificationCount, helpRefreshSequence } = useAlumniHelp();
  return <>
    <output aria-label="Alumni Help action count">{helpActionRequiredCount}</output>
    <output aria-label="Alumni Help notification count">{helpNotificationCount}</output>
    <output aria-label="Alumni Help refresh sequence">{helpRefreshSequence}</output>
  </>;
}

function LocationProbe() {
  return <output aria-label="Current location">{useLocation().pathname}</output>;
}

function renderProvider() {
  return render(
    <MemoryRouter>
      <AlumniHelpProvider>
        <CountProbe />
        <LocationProbe />
      </AlumniHelpProvider>
    </MemoryRouter>,
  );
}

describe("AlumniHelpProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socketHandlers.clear();
    mocks.userId = "64b000000000000000000001";
    mocks.getNotificationCounts.mockResolvedValue({ helpActionRequiredCount: 2, helpNotificationCount: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the count and accepts only validated realtime count updates", async () => {
    renderProvider();

    await waitFor(() =>
      expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("2"),
    );
    expect(mocks.getNotificationCounts).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("3");

    act(() => {
      mocks.socketHandlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 1,
        helpActionRequiredCount: 5,
        helpNotificationCount: 6,
        timestamp: "2026-09-12T13:00:00.000Z",
      });
    });
    expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("5");
    expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("6");
    expect(screen.getByLabelText("Alumni Help refresh sequence")).toHaveTextContent("1");

    mocks.getNotificationCounts.mockResolvedValue({ helpActionRequiredCount: 4, helpNotificationCount: 5 });
    act(() =>
      mocks.socketHandlers.get("alumni_help_update")?.({
        helpActionRequiredCount: -1,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("4"),
    );
    expect(mocks.getNotificationCounts).toHaveBeenCalledTimes(2);
  });

  it("retains a live unread update when an older HTTP count returns afterward", async () => {
    let resolveCounts!: (value: { helpActionRequiredCount: number; helpNotificationCount: number }) => void;
    mocks.getNotificationCounts.mockReturnValue(new Promise((resolve) => { resolveCounts = resolve; }));
    renderProvider();
    act(() => mocks.socketHandlers.get("alumni_help_update")?.({
      requestId: "64b000000000000000000002",
      requestRevision: 7,
      helpActionRequiredCount: 0,
      helpNotificationCount: 1,
      timestamp: "2026-09-21T13:00:00.000Z",
    }));
    await act(async () => resolveCounts({ helpActionRequiredCount: 0, helpNotificationCount: 0 }));
    expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("1");
  });

  it("refreshes count and mounted Help content after reconnect and after foreground suspension", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("3"));
    mocks.getNotificationCounts.mockResolvedValue({ helpActionRequiredCount: 0, helpNotificationCount: 1 });
    act(() => mocks.socketHandlers.get("connect")?.());
    await waitFor(() => expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("1"));
    expect(screen.getByLabelText("Alumni Help refresh sequence")).toHaveTextContent("1");

    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.getNotificationCounts).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    mocks.getNotificationCounts.mockResolvedValue({ helpActionRequiredCount: 1, helpNotificationCount: 2 });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.getNotificationCounts).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("2");
    expect(screen.getByLabelText("Alumni Help refresh sequence")).toHaveTextContent("2");
  });

  it("recovers missed events within the bounded foreground interval and pauses offline", async () => {
    vi.useFakeTimers();
    renderProvider();
    await act(async () => {});
    mocks.getNotificationCounts.mockResolvedValue({ helpActionRequiredCount: 0, helpNotificationCount: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(mocks.getNotificationCounts).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.getByLabelText("Alumni Help notification count")).toHaveTextContent("1");
    expect(screen.getByLabelText("Alumni Help refresh sequence")).toHaveTextContent("1");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.getNotificationCounts).toHaveBeenCalledTimes(2);
  });

  it("requires the exact metadata-only Alumni Help event shape", () => {
    const valid = {
      requestId: "64b000000000000000000002",
      requestRevision: 1,
      helpActionRequiredCount: 0,
      timestamp: "2026-09-13T12:00:00.000Z",
    };
    expect(isAlumniHelpUpdatePayload(valid)).toBe(true);
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        roomCreated: { conversationId: "64b000000000000000000003" },
      }),
    ).toBe(true);
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        roomGraceStarted: {
          conversationId: "64b000000000000000000003",
          writeAccessEndsAt: "2026-09-20T12:00:00.000Z",
        },
      }),
    ).toBe(true);
    expect(isAlumniHelpUpdatePayload({ ...valid, message: "private text" })).toBe(
      false,
    );
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        roomCreated: { conversationId: "not-an-object-id" },
      }),
    ).toBe(false);
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        roomGraceStarted: {
          conversationId: "64b000000000000000000003",
          writeAccessEndsAt: "not-an-instant",
        },
      }),
    ).toBe(false);
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        roomCreated: { conversationId: "64b000000000000000000003" },
        roomGraceStarted: {
          conversationId: "64b000000000000000000004",
          writeAccessEndsAt: "2026-09-20T12:00:00.000Z",
        },
      }),
    ).toBe(false);
    expect(
      isAlumniHelpUpdatePayload({
        ...valid,
        timestamp: "2026-09-13T05:00:00-07:00",
      }),
    ).toBe(false);
  });

  it("shows one Chat Room prompt for a valid room-created event", async () => {
    renderProvider();
    await screen.findByLabelText("Alumni Help action count");

    act(() => {
      mocks.socketHandlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 1,
        helpActionRequiredCount: 0,
        roomCreated: { conversationId: "64b000000000000000000003" },
        timestamp: "2026-09-13T12:00:00.000Z",
      });
    });

    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Chat Room created",
        actionButton: expect.objectContaining({ text: "Open Chat Room" }),
        lockUntilClose: true,
      }),
    );

    const firstOptions = mocks.showNotification.mock.calls[0][0];
    act(() => firstOptions.actionButton.onClick());
    expect(screen.getByLabelText("Current location")).toHaveTextContent(
      "/dashboard/chat-rooms/64b000000000000000000003",
    );

    act(() => {
      mocks.socketHandlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 1,
        helpActionRequiredCount: 0,
        roomCreated: { conversationId: "64b000000000000000000003" },
        timestamp: "2026-09-13T12:00:01.000Z",
      });
    });
    expect(mocks.showNotification).toHaveBeenCalledOnce();
  });

  it("shows one direct-to-Room prompt when a request closes", async () => {
    renderProvider();
    await screen.findByLabelText("Alumni Help action count");

    act(() => {
      mocks.socketHandlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 4,
        helpActionRequiredCount: 0,
        helpNotificationCount: 1,
        roomGraceStarted: {
          conversationId: "64b000000000000000000003",
          writeAccessEndsAt: "2026-09-20T12:00:00.000Z",
        },
        timestamp: "2026-09-13T12:00:00.000Z",
      });
    });

    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Help request closed",
        message: expect.stringContaining("private Chat Room"),
        actionButton: expect.objectContaining({ text: "Open Chat Room" }),
        lockUntilClose: true,
      }),
    );
    const options = mocks.showNotification.mock.calls[0][0];
    act(() => options.actionButton.onClick());
    expect(screen.getByLabelText("Current location")).toHaveTextContent(
      "/dashboard/chat-rooms/64b000000000000000000003",
    );

    act(() => {
      mocks.socketHandlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 4,
        helpActionRequiredCount: 0,
        helpNotificationCount: 1,
        roomGraceStarted: {
          conversationId: "64b000000000000000000003",
          writeAccessEndsAt: "2026-09-20T12:00:00.000Z",
        },
        timestamp: "2026-09-13T12:00:01.000Z",
      });
    });
    expect(mocks.showNotification).toHaveBeenCalledOnce();
  });
});
