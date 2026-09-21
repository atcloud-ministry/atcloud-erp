import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatRoomsProvider,
  useChatRooms,
} from "../../contexts/ChatRoomsContext";

const mocks = vi.hoisted(() => ({
  getUnreadCount: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  userId: "64b000000000000000000001" as string | null,
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: mocks.userId ? { id: mocks.userId } : null,
  }),
}));
vi.mock("../../hooks/useSocket", () => ({ useSocket: () => ({}) }));
vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: { alumniNetwork: { readable: true, writable: true, mode: "on" } },
  }),
}));
vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  conversationsService: { getUnreadCount: mocks.getUnreadCount },
}));
vi.mock("../../services/socketService", () => ({
  socketService: {
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      mocks.handlers.set(event, handler);
      return () => mocks.handlers.delete(event);
    }),
  },
}));

let latestContext: ReturnType<typeof useChatRooms> | null = null;

function Consumer() {
  const value = useChatRooms();
  latestContext = value;
  return (
    <div>
      <span data-testid="total">{value.chatUnreadTotal}</span>
      <span data-testid="room">
        {value.roomUnreadCounts["64b000000000000000000002"] ?? "missing"}
      </span>
      <span data-testid="ready">{String(value.countReady)}</span>
    </div>
  );
}

describe("ChatRoomsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.userId = "64b000000000000000000001";
    latestContext = null;
    mocks.getUnreadCount.mockResolvedValue(4);
  });

  it("loads the authoritative aggregate unread count", async () => {
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("4"));
    expect(mocks.getUnreadCount).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("retries an uninitialized count when the browser comes back online", async () => {
    mocks.getUnreadCount
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(7);
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await waitFor(() => expect(mocks.getUnreadCount).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("ready")).toHaveTextContent("false");

    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("7"));
    expect(screen.getByTestId("ready")).toHaveTextContent("true");
  });

  it("applies recipient-scoped absolute room and aggregate counters", async () => {
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await screen.findByText("4");

    act(() => {
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000002",
        roomUnreadCount: 7,
        chatUnreadTotal: 12,
        lastReadSequence: 3,
        timestamp: "2026-09-13T12:00:00.000Z",
      });
    });

    expect(screen.getByTestId("total")).toHaveTextContent("12");
    expect(screen.getByTestId("room")).toHaveTextContent("7");
  });

  it("reconciles the badge from a persisted message when its counter snapshot is delayed", async () => {
    mocks.getUnreadCount
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(9);
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await screen.findByText("4");

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: {
          id: "64b000000000000000000010",
          conversationId: "64b000000000000000000002",
          sequence: 4,
          kind: "text",
          sender: {
            id: "64b000000000000000000003",
            displayName: "Amy Chen",
            avatar: null,
          },
          content: "A new message",
          safeLink: null,
          clientMessageId: "00000000-0000-4000-8000-000000000001",
          createdAt: "2026-09-20T12:00:00.000Z",
        },
        timestamp: "2026-09-20T12:00:00.000Z",
      });
    });

    await waitFor(() =>
      expect(mocks.getUnreadCount).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByTestId("total")).toHaveTextContent("9");
  });

  it("ignores a delayed lower read cursor but accepts a newer tab's cursor", async () => {
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await screen.findByText("4");

    act(() => {
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000002",
        roomUnreadCount: 0,
        chatUnreadTotal: 2,
        lastReadSequence: 8,
        timestamp: "2026-09-13T12:02:00.000Z",
      });
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000002",
        roomUnreadCount: 6,
        chatUnreadTotal: 8,
        lastReadSequence: 7,
        timestamp: "2026-09-13T12:01:00.000Z",
      });
    });

    expect(screen.getByTestId("total")).toHaveTextContent("2");
    expect(screen.getByTestId("room")).toHaveTextContent("0");

    act(() => {
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000002",
        roomUnreadCount: 0,
        chatUnreadTotal: 1,
        lastReadSequence: 9,
        timestamp: "2026-09-13T12:03:00.000Z",
      });
    });
    expect(screen.getByTestId("total")).toHaveTextContent("1");
    expect(screen.getByTestId("room")).toHaveTextContent("0");
  });

  it("reconciles an out-of-order absolute total emitted by another room", async () => {
    mocks.getUnreadCount.mockResolvedValueOnce(4).mockResolvedValueOnce(9);
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await screen.findByText("4");

    act(() => {
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000002",
        roomUnreadCount: 4,
        chatUnreadTotal: 9,
        lastReadSequence: 2,
        timestamp: "2026-09-13T12:02:00.000Z",
      });
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000003",
        roomUnreadCount: 1,
        chatUnreadTotal: 5,
        lastReadSequence: 1,
        timestamp: "2026-09-13T12:01:00.000Z",
      });
    });

    expect(screen.getByTestId("total")).toHaveTextContent("5");
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("9"));
    expect(mocks.getUnreadCount).toHaveBeenCalledTimes(2);
  });

  it("rejects an overlapping REST snapshot after an equal-cursor Socket update", async () => {
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await screen.findByText("4");
    const requestGeneration = latestContext!.captureCounterGeneration();

    act(() => {
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: "64b000000000000000000002",
        roomUnreadCount: 2,
        chatUnreadTotal: 2,
        lastReadSequence: 0,
        timestamp: "2026-09-13T12:02:00.000Z",
      });
    });
    act(() => {
      latestContext!.applyCounterSnapshot(
        1,
        "64b000000000000000000002",
        1,
        0,
        requestGeneration,
      );
    });

    expect(screen.getByTestId("total")).toHaveTextContent("2");
    expect(screen.getByTestId("room")).toHaveTextContent("2");
  });

  it("recovers the aggregate count after malformed events and reconnect", async () => {
    mocks.getUnreadCount.mockResolvedValueOnce(1).mockResolvedValueOnce(6).mockResolvedValueOnce(9);
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("1"));

    act(() => mocks.handlers.get("chat_unread_update")?.({ invalid: true }));
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("6"));
    act(() => mocks.handlers.get("connect")?.());
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("9"));
  });

  it("refreshes the aggregate when an Alumni Help lifecycle event can archive a Room", async () => {
    mocks.getUnreadCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    render(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("3"));

    act(() => {
      mocks.handlers.get("alumni_help_update")?.({
        requestId: "64b000000000000000000002",
        requestRevision: 4,
        helpActionRequiredCount: 0,
        timestamp: "2026-09-13T12:04:00.000Z",
      });
    });

    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("0"));
    expect(mocks.getUnreadCount).toHaveBeenCalledTimes(2);
  });

  it("does not expose one account's counters after a direct account switch", async () => {
    let resolveSecond!: (value: number) => void;
    mocks.getUnreadCount
      .mockResolvedValueOnce(4)
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const view = (
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>
    );
    const rendered = render(view);
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("4"));

    mocks.userId = "64b000000000000000000099";
    rendered.rerender(
      <ChatRoomsProvider>
        <Consumer />
      </ChatRoomsProvider>,
    );
    expect(screen.getByTestId("total")).toHaveTextContent("0");
    expect(screen.getByTestId("room")).toHaveTextContent("missing");

    await act(async () => resolveSecond(7));
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("7"));
  });
});
