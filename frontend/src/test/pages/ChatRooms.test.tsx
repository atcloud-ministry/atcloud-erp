import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatRooms from "../../pages/ChatRooms";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  applyCounter: vi.fn(),
  roomCounts: {} as Record<string, number>,
  captureCounterGeneration: vi.fn(() => 0),
  handlers: new Map<string, (payload?: unknown) => void>(),
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  conversationsService: { list: mocks.list },
}));
vi.mock("../../contexts/ChatRoomsContext", () => ({
  useChatRooms: () => ({
    applyCounterSnapshot: mocks.applyCounter,
    captureCounterGeneration: mocks.captureCounterGeneration,
    roomUnreadCounts: mocks.roomCounts,
  }),
}));
vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: { alumniNetwork: { readable: true, writable: true, mode: "on" } },
  }),
}));
vi.mock("../../services/socketService", () => ({
  socketService: {
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      mocks.handlers.set(event, handler);
      return () => mocks.handlers.delete(event);
    }),
  },
}));

const room = {
  id: "64b000000000000000000001",
  kind: "alumni_help" as const,
  status: "current" as const,
  section: "current" as const,
  title: "Amy Chen",
  helpRequestId: "64b000000000000000000002",
  programId: null,
  counterpart: {
    id: "64b000000000000000000003",
    displayName: "Amy Chen",
    avatar: null,
  },
  lastSequence: 1,
  lastMessage: {
    id: "64b000000000000000000004",
    sequence: 1,
    kind: "text" as const,
    sender: {
      id: "64b000000000000000000003",
      displayName: "Amy Chen",
      avatar: null,
    },
    contentPreview: "Happy to help",
    safeLink: null,
    createdAt: "2026-09-13T12:00:00.000Z",
  },
  viewer: {
    role: "requester" as const,
    status: "active" as const,
    lastReadSequence: 0,
    unreadCount: 1,
    muted: false,
    canSend: true,
    canAnnounce: false,
    accessMode: "read_write" as const,
  },
  archivedAt: null,
  createdAt: "2026-09-13T11:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

const result = {
  conversations: [room],
  pagination: {
    currentPage: 1,
    totalPages: 1,
    totalCount: 1,
    hasNext: false,
    hasPrev: false,
  },
  chatUnreadTotal: 1,
};

function renderPage(entry = "/dashboard/chat-rooms") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<ChatRooms />} path="/dashboard/chat-rooms" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatRooms page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.roomCounts = {};
    mocks.list.mockResolvedValue(result);
  });

  it("loads Current Rooms, publishes counters, and links to the Room", async () => {
    renderPage();
    const link = await screen.findByRole("link", {
      name: "Amy Chen, 1 unread message",
    });
    expect(link).toHaveAttribute("href", `/dashboard/chat-rooms/${room.id}`);
    expect(mocks.list).toHaveBeenCalledWith(
      { view: "current", page: 1, limit: 30 },
      expect.any(AbortSignal),
    );
    expect(mocks.applyCounter).toHaveBeenCalledWith(1, room.id, 1, 0, 0);
  });

  it("keeps Past / Read-only selection in the URL contract", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "Amy Chen, 1 unread message" });
    await user.click(screen.getByRole("link", { name: "Past / Read-only" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        { view: "past", page: 1, limit: 30 },
        expect.any(AbortSignal),
      ),
    );
  });

  it("keeps pagination focus available while the next page loads", async () => {
    const user = userEvent.setup();
    const firstPage = {
      ...result,
      pagination: {
        ...result.pagination,
        totalPages: 2,
        totalCount: 2,
        hasNext: true,
      },
    };
    const secondPage = {
      ...result,
      pagination: {
        ...result.pagination,
        currentPage: 2,
        totalPages: 2,
        totalCount: 2,
        hasPrev: true,
      },
    };
    let resolveSecondPage!: (value: typeof secondPage) => void;
    const secondPageRequest = new Promise<typeof secondPage>((resolve) => {
      resolveSecondPage = resolve;
    });
    mocks.list
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(secondPageRequest);
    renderPage();
    await screen.findByText("Page 1 of 2");
    const next = screen.getByRole("button", { name: "Next page" });

    await user.click(next);
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        { view: "current", page: 2, limit: 30 },
        expect.any(AbortSignal),
      ),
    );
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");

    await act(async () => resolveSecondPage(secondPage));
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toHaveFocus());
  });

  it("identifies a live-titled Program Room with its Past and read-only state", async () => {
    mocks.list.mockResolvedValueOnce({
      ...result,
      conversations: [
        {
          ...room,
          kind: "program",
          status: "current",
          section: "past",
          title: "EMBA 2026",
          helpRequestId: null,
          programId: "64b000000000000000000005",
          counterpart: null,
          viewer: {
            ...room.viewer,
            role: "mentee",
            status: "history_only",
            unreadCount: 0,
            canSend: false,
            accessMode: "read_only",
          },
        },
      ],
      chatUnreadTotal: 0,
    });
    renderPage("/dashboard/chat-rooms?view=past");

    expect(
      await screen.findByRole("link", { name: "EMBA 2026" }),
    ).toHaveAttribute("href", `/dashboard/chat-rooms/${room.id}`);
    expect(screen.getByText("Program · Past · Read-only")).toBeInTheDocument();
  });

  it("uses live absolute room counts and coalesces unread-event refreshes", async () => {
    mocks.roomCounts = { [room.id]: 145 };
    renderPage();
    const link = await screen.findByRole("link", {
      name: "Amy Chen, 145 unread messages",
    });
    expect(link).toHaveTextContent("99+");

    expect(mocks.handlers.has("chat_message")).toBe(false);
    act(() => {
      mocks.handlers.get("chat_unread_update")?.();
      mocks.handlers.get("chat_unread_update")?.();
      mocks.handlers.get("chat_unread_update")?.();
      mocks.handlers.get("alumni_help_update")?.({
        requestId: room.helpRequestId,
        requestRevision: 4,
        helpActionRequiredCount: 0,
        timestamp: "2026-09-13T12:04:00.000Z",
      });
    });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2), {
      timeout: 1_500,
    });
  });
});

export { room as chatRoomPageFixture };
