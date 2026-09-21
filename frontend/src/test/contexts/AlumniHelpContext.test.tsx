import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlumniHelpProvider,
  isAlumniHelpUpdatePayload,
  useAlumniHelp,
} from "../../contexts/AlumniHelpContext";

const mocks = vi.hoisted(() => ({
  getActionRequiredCount: vi.fn(),
  socketHandlers: new Map<string, (payload?: unknown) => void>(),
  showNotification: vi.fn(),
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ currentUser: { id: "64b000000000000000000001" } }),
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
    getActionRequiredCount: mocks.getActionRequiredCount,
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
  const { helpActionRequiredCount } = useAlumniHelp();
  return <output aria-label="Alumni Help action count">{helpActionRequiredCount}</output>;
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
    mocks.getActionRequiredCount.mockResolvedValue(2);
  });

  it("loads the count and accepts only validated realtime count updates", async () => {
    renderProvider();

    await waitFor(() =>
      expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("2"),
    );
    expect(mocks.getActionRequiredCount).toHaveBeenCalledOnce();

    act(() => {
      mocks.socketHandlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 1,
        helpActionRequiredCount: 5,
        timestamp: "2026-09-12T13:00:00.000Z",
      });
    });
    expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("5");

    mocks.getActionRequiredCount.mockResolvedValue(4);
    act(() =>
      mocks.socketHandlers.get("alumni_help_update")?.({
        helpActionRequiredCount: -1,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Alumni Help action count")).toHaveTextContent("4"),
    );
    expect(mocks.getActionRequiredCount).toHaveBeenCalledTimes(2);
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
});
