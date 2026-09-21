import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatRoom, {
  mergeCanonicalMessages,
  previewContent,
} from "../../pages/ChatRoom";
import type { ChatMessageDTO } from "../../services/api";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
  publishAnnouncement: vi.fn(),
  markRead: vi.fn(),
  setMuted: vi.fn(),
  applyCounter: vi.fn(),
  captureCounterGeneration: vi.fn(() => 0),
  counterGeneration: 0,
  join: vi.fn(),
  leave: vi.fn(),
  handlers: new Map<string, (payload?: unknown) => void>(),
  writable: true,
  userId: "64b000000000000000000010",
}));

vi.mock("../../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/api")>()),
  conversationsService: {
    get: mocks.get,
    history: mocks.history,
    send: mocks.send,
    publishAnnouncement: mocks.publishAnnouncement,
    markRead: mocks.markRead,
    setMuted: mocks.setMuted,
  },
}));
vi.mock("../../contexts/ChatRoomsContext", () => ({
  useChatRooms: () => ({
    applyCounterSnapshot: mocks.applyCounter,
    captureCounterGeneration: mocks.captureCounterGeneration,
  }),
}));
vi.mock("../../contexts/RuntimeConfigContext", () => ({
  useRuntimeConfig: () => ({
    status: "ready",
    config: {
      alumniNetwork: {
        readable: true,
        writable: mocks.writable,
        mode: mocks.writable ? "on" : "read_only",
      },
    },
  }),
}));
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: {
      id: mocks.userId,
      firstName: "Taylor",
      lastName: "Reed",
      username: "taylor",
      avatar: null,
    },
  }),
}));
vi.mock("../../hooks/useSocket", () => ({
  useSocket: () => ({ connected: true }),
}));
vi.mock("../../services/socketService", () => ({
  socketService: {
    joinConversationRoom: mocks.join,
    leaveConversationRoom: mocks.leave,
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      mocks.handlers.set(event, handler);
      return () => mocks.handlers.delete(event);
    }),
  },
}));

const IDS = {
  room: "64b000000000000000000001",
  request: "64b000000000000000000002",
  other: "64b000000000000000000003",
  me: "64b000000000000000000010",
  firstMessage: "64b000000000000000000004",
  secondMessage: "64b000000000000000000005",
};
const other = { id: IDS.other, displayName: "Amy Chen", avatar: null };
const me = { id: IDS.me, displayName: "Taylor Reed", avatar: null };

const firstMessage: ChatMessageDTO = {
  id: IDS.firstMessage,
  conversationId: IDS.room,
  sequence: 1,
  kind: "text",
  sender: other,
  content: "Happy to help",
  safeLink: { url: "https://example.com/resource", label: "Resource" },
  clientMessageId: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-09-13T12:00:00.000Z",
};

const room = {
  id: IDS.room,
  kind: "alumni_help" as const,
  status: "current" as const,
  section: "current" as const,
  title: "Amy Chen",
  helpRequestId: IDS.request,
  programId: null,
  counterpart: other,
  lastSequence: 1,
  lastMessage: {
    id: IDS.firstMessage,
    sequence: 1,
    kind: "text" as const,
    sender: other,
    contentPreview: "Happy to help",
    safeLink: firstMessage.safeLink,
    createdAt: firstMessage.createdAt,
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

function history(
  messages: ChatMessageDTO[] = [firstMessage],
  overrides: Record<string, unknown> = {},
) {
  return {
    conversationId: IDS.room,
    messages,
    pagination: {
      limit: 50,
      hasMore: false,
      beforeSequence: null,
      afterSequence: null,
      nextBeforeSequence: null,
      nextAfterSequence: null,
    },
    roomUnreadCount: 1,
    chatUnreadTotal: 1,
    ...overrides,
  };
}

function renderPage() {
  return render(pageTree());
}

function pageTree() {
  return (
    <MemoryRouter initialEntries={[`/dashboard/chat-rooms/${IDS.room}`]}>
      <Routes>
        <Route element={<ChatRoom />} path="/dashboard/chat-rooms/:conversationId" />
      </Routes>
    </MemoryRouter>
  );
}

function setDocumentVisibility(value: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

describe("ChatRoom page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.writable = true;
    mocks.userId = IDS.me;
    mocks.counterGeneration = 0;
    mocks.captureCounterGeneration.mockImplementation(
      () => mocks.counterGeneration,
    );
    mocks.join.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue({ conversation: room, chatUnreadTotal: 1 });
    mocks.history.mockResolvedValue(history());
    mocks.markRead.mockResolvedValue({
      conversationId: IDS.room,
      lastReadSequence: 1,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });
    mocks.publishAnnouncement.mockResolvedValue({
      message: {
        ...firstMessage,
        id: IDS.secondMessage,
        sequence: 2,
        kind: "announcement",
        sender: me,
        content: "Default announcement",
        safeLink: null,
        clientMessageId: "10000000-0000-4000-8000-000000000020",
      },
      roomUnreadCount: 0,
      chatUnreadTotal: 0,
    });
    mocks.setMuted.mockResolvedValue({
      conversationId: IDS.room,
      muted: true,
      chatUnreadTotal: 0,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    setDocumentVisibility("visible");
  });

  it("keeps matching clientMessageIds from different senders", () => {
    const reusedClientMessageId =
      "10000000-0000-4000-8000-000000000099";
    const messages = mergeCanonicalMessages(
      [{ ...firstMessage, clientMessageId: reusedClientMessageId }],
      [
        {
          ...firstMessage,
          id: IDS.secondMessage,
          sequence: 2,
          sender: me,
          clientMessageId: reusedClientMessageId,
        },
      ],
    );

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.sender.id)).toEqual([
      IDS.other,
      IDS.me,
    ]);
  });

  it("deduplicates a retry from the same sender and clientMessageId", () => {
    const retry = {
      ...firstMessage,
      id: IDS.secondMessage,
      sequence: 2,
      content: "Canonical retry result",
    };

    const messages = mergeCanonicalMessages([firstMessage], [retry]);

    expect(messages).toEqual([retry]);
  });

  it("renders authorized history and advances the read cursor", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Amy Chen" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Privacy & Data Use" }),
    ).toHaveAttribute("href", "/privacy");
    expect(screen.getByText("Happy to help")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Resource/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(IDS.room, 1));
    await waitFor(() => expect(mocks.join).toHaveBeenCalledWith(IDS.room));
  });

  it("identifies a Program Room and its Past read-only access in detail", async () => {
    mocks.get.mockResolvedValueOnce({
      conversation: {
        ...room,
        kind: "program",
        status: "current",
        section: "past",
        title: "EMBA 2026",
        helpRequestId: null,
        programId: "64b000000000000000000020",
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
      chatUnreadTotal: 0,
    });
    mocks.history.mockResolvedValueOnce(
      history([], { roomUnreadCount: 0, chatUnreadTotal: 0 }),
    );
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "EMBA 2026" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Program Room · Past · Read-only")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });

  it("uses only server canAnnounce to publish and retry a Program announcement", async () => {
    const user = userEvent.setup();
    const programRoom = {
      ...room,
      kind: "program" as const,
      title: "EMBA 2026",
      helpRequestId: null,
      programId: "64b000000000000000000020",
      counterpart: null,
      viewer: {
        ...room.viewer,
        role: "mentee" as const,
        canAnnounce: true,
      },
    };
    mocks.get.mockResolvedValueOnce({
      conversation: programRoom,
      chatUnreadTotal: 0,
    });
    mocks.publishAnnouncement
      .mockRejectedValueOnce(new Error("Announcement transport failed"))
      .mockImplementationOnce(
        async (
          _roomId: string,
          input: { clientMessageId: string; content: string },
        ) => ({
          message: {
            ...firstMessage,
            id: IDS.secondMessage,
            sequence: 2,
            kind: "announcement" as const,
            sender: me,
            content: input.content,
            safeLink: null,
            clientMessageId: input.clientMessageId,
          },
          roomUnreadCount: 0,
          chatUnreadTotal: 0,
        }),
      );
    renderPage();

    await screen.findByRole("heading", { name: "EMBA 2026" });
    await user.click(screen.getByRole("button", { name: "Post announcement" }));
    await user.type(
      screen.getByRole("textbox", { name: "Program announcement" }),
      "Program starts tomorrow",
    );
    await user.click(
      screen.getByRole("button", { name: "Publish announcement" }),
    );

    expect(await screen.findByText("Announcement transport failed")).toBeInTheDocument();
    expect(screen.getByText("Program starts tomorrow")).toBeInTheDocument();
    expect(screen.getByText(/· failed/u)).toBeInTheDocument();
    const firstClientMessageId = mocks.publishAnnouncement.mock.calls[0][1]
      .clientMessageId as string;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/· sent/u)).toBeInTheDocument();

    expect(mocks.publishAnnouncement).toHaveBeenCalledTimes(2);
    expect(mocks.publishAnnouncement.mock.calls[1][0]).toBe(IDS.room);
    expect(mocks.publishAnnouncement.mock.calls[1][1]).toEqual({
      clientMessageId: firstClientMessageId,
      content: "Program starts tomorrow",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not expose announcement controls without the server capability", async () => {
    mocks.get.mockResolvedValueOnce({
      conversation: {
        ...room,
        kind: "program",
        title: "EMBA 2026",
        helpRequestId: null,
        programId: "64b000000000000000000020",
        counterpart: null,
        viewer: { ...room.viewer, role: "mentor", canAnnounce: false },
      },
      chatUnreadTotal: 0,
    });
    renderPage();

    await screen.findByRole("heading", { name: "EMBA 2026" });
    expect(
      screen.queryByRole("button", { name: "Post announcement" }),
    ).toBeNull();
  });

  it("shows failed optimistic delivery and retries with the same clientMessageId", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mocks.send.mockImplementation(async (_roomId: string, input: { clientMessageId: string; content: string }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("Network unavailable");
      return {
        message: {
          ...firstMessage,
          id: IDS.secondMessage,
          sequence: 2,
          sender: me,
          content: input.content,
          safeLink: null,
          clientMessageId: input.clientMessageId,
        },
        roomUnreadCount: 0,
        chatUnreadTotal: 0,
      };
    });
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });

    await user.type(screen.getByLabelText("Message"), "Thank you");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/sent/)).toBeInTheDocument();

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][1].clientMessageId).toBe(
      mocks.send.mock.calls[1][1].clientMessageId,
    );
  });

  it("treats a matching Socket delivery as success after the HTTP request fails", async () => {
    const user = userEvent.setup();
    let rejectSend!: (reason?: unknown) => void;
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));

    await user.type(screen.getByLabelText("Message"), "Delivered once");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    const clientMessageId = mocks.send.mock.calls[0][1].clientMessageId as string;

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: {
          ...firstMessage,
          id: IDS.secondMessage,
          sequence: 2,
          sender: me,
          content: "Delivered once",
          safeLink: null,
          clientMessageId,
        },
        timestamp: "2026-09-13T12:01:00.000Z",
      });
    });
    await act(async () => rejectSend(new Error("Late network failure")));

    expect(screen.getAllByText("Delivered once")).toHaveLength(1);
    expect(screen.queryByText("Late network failure")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("does not reconcile an optimistic send from another sender's reused clientMessageId", async () => {
    const user = userEvent.setup();
    let rejectSend!: (reason?: unknown) => void;
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));

    await user.type(screen.getByLabelText("Message"), "My pending message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    const reusedClientMessageId = mocks.send.mock.calls[0][1]
      .clientMessageId as string;

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: {
          ...firstMessage,
          id: IDS.secondMessage,
          sequence: 2,
          content: "Other sender collision",
          safeLink: null,
          clientMessageId: reusedClientMessageId,
        },
        timestamp: "2026-09-13T12:01:00.000Z",
      });
    });
    await act(async () => rejectSend(new Error("My request failed")));

    expect(screen.getByText("Other sender collision")).toBeInTheDocument();
    expect(screen.getByText("My pending message")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("reconciles a failed optimistic message from REST recovery without a duplicate", async () => {
    const user = userEvent.setup();
    mocks.send.mockRejectedValueOnce(new Error("Network dropped after commit"));
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));

    await user.type(screen.getByLabelText("Message"), "Committed once");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    const clientMessageId = mocks.send.mock.calls[0][1].clientMessageId as string;
    mocks.history.mockResolvedValueOnce(
      history(
        [
          {
            ...firstMessage,
            id: IDS.secondMessage,
            sequence: 2,
            sender: me,
            content: "Committed once",
            safeLink: null,
            clientMessageId,
          },
        ],
        {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 1,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
        },
      ),
    );
    mocks.markRead.mockResolvedValue({
      conversationId: IDS.room,
      lastReadSequence: 2,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });

    act(() => mocks.handlers.get("connect")?.());

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText("Committed once")).toHaveLength(1);
    expect(screen.queryByText("Network dropped after commit")).not.toBeInTheDocument();
  });

  it("deduplicates a realtime message and advances its visible read cursor", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));
    const incoming = {
      ...firstMessage,
      id: IDS.secondMessage,
      sequence: 2,
      content: "A realtime update",
      safeLink: null,
      clientMessageId: "10000000-0000-4000-8000-000000000002",
    };
    mocks.markRead.mockResolvedValue({
      conversationId: IDS.room,
      lastReadSequence: 2,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: incoming,
        timestamp: "2026-09-13T12:01:00.000Z",
      });
      mocks.handlers.get("chat_message")?.({
        message: incoming,
        timestamp: "2026-09-13T12:01:00.000Z",
      });
    });

    expect(await screen.findByText("A realtime update")).toBeInTheDocument();
    expect(screen.getAllByText("A realtime update")).toHaveLength(1);
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(IDS.room, 2));
  });

  it("recovers a Socket sequence gap before advancing the verified read cursor", async () => {
    const emptyRoom = {
      ...room,
      lastSequence: 0,
      lastMessage: null,
      viewer: { ...room.viewer, lastReadSequence: 0, unreadCount: 0 },
    };
    mocks.get.mockResolvedValue({ conversation: emptyRoom, chatUnreadTotal: 0 });
    mocks.history
      .mockResolvedValueOnce(
        history([], { roomUnreadCount: 0, chatUnreadTotal: 0 }),
      )
      .mockResolvedValueOnce(
        history([], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 0,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
          roomUnreadCount: 0,
          chatUnreadTotal: 0,
        }),
      );
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));

    let resolveGapRecovery!: (value: ReturnType<typeof history>) => void;
    mocks.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGapRecovery = resolve;
        }),
    );
    mocks.markRead.mockResolvedValue({
      conversationId: IDS.room,
      lastReadSequence: 2,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });
    const secondMessage = {
      ...firstMessage,
      id: IDS.secondMessage,
      sequence: 2,
      content: "Second arrived first",
      safeLink: null,
      clientMessageId: "10000000-0000-4000-8000-000000000006",
    };

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: secondMessage,
        timestamp: "2026-09-13T12:04:00.000Z",
      });
    });

    expect(await screen.findByText("Second arrived first")).toBeInTheDocument();
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(3));
    expect(mocks.history).toHaveBeenLastCalledWith(IDS.room, {
      afterSequence: 0,
      limit: 100,
    });
    expect(mocks.markRead).not.toHaveBeenCalled();

    await act(async () => {
      resolveGapRecovery(
        history([firstMessage], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 0,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
          roomUnreadCount: 2,
          chatUnreadTotal: 2,
        }),
      );
    });

    expect(await screen.findByText("Happy to help")).toBeInTheDocument();
    expect(screen.getAllByText("Second arrived first")).toHaveLength(1);
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(IDS.room, 2));

    mocks.history.mockResolvedValueOnce(
      history([], {
        pagination: {
          limit: 100,
          hasMore: false,
          beforeSequence: null,
          afterSequence: 2,
          nextBeforeSequence: null,
          nextAfterSequence: null,
        },
        roomUnreadCount: 0,
        chatUnreadTotal: 0,
      }),
    );
    act(() => mocks.handlers.get("connect")?.());
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(4));
    expect(mocks.history).toHaveBeenLastCalledWith(IDS.room, {
      afterSequence: 2,
      limit: 100,
    });
    expect(screen.getAllByText("Happy to help")).toHaveLength(1);
    expect(screen.getAllByText("Second arrived first")).toHaveLength(1);
  });

  it("advances through an authoritative REST gap in the visible access window", async () => {
    const visibleSecondMessage = {
      ...firstMessage,
      id: IDS.secondMessage,
      sequence: 2,
      content: "First visible in this access window",
      safeLink: null,
      clientMessageId: "10000000-0000-4000-8000-000000000007",
    };
    mocks.get.mockResolvedValue({
      conversation: {
        ...room,
        lastSequence: 2,
        lastMessage: null,
        viewer: { ...room.viewer, lastReadSequence: 0, unreadCount: 1 },
      },
      chatUnreadTotal: 1,
    });
    mocks.history
      .mockResolvedValueOnce(history([], { roomUnreadCount: 1 }))
      .mockResolvedValueOnce(
        history([visibleSecondMessage], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 0,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
        }),
      );
    mocks.markRead.mockResolvedValue({
      conversationId: IDS.room,
      lastReadSequence: 2,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });

    renderPage();

    expect(
      await screen.findByText("First visible in this access window"),
    ).toBeInTheDocument();
    expect(mocks.history).toHaveBeenLastCalledWith(IDS.room, {
      afterSequence: 0,
      limit: 100,
    });
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(IDS.room, 2));
  });

  it("waits for a hidden recovered Room to become visible before marking it read", async () => {
    const emptyRoom = {
      ...room,
      lastSequence: 0,
      lastMessage: null,
      viewer: { ...room.viewer, lastReadSequence: 0, unreadCount: 0 },
    };
    const secondMessage = {
      ...firstMessage,
      id: IDS.secondMessage,
      sequence: 2,
      content: "Recovered while hidden",
      safeLink: null,
      clientMessageId: "10000000-0000-4000-8000-000000000008",
    };
    mocks.get.mockResolvedValue({ conversation: emptyRoom, chatUnreadTotal: 0 });
    mocks.history
      .mockResolvedValueOnce(
        history([], { roomUnreadCount: 0, chatUnreadTotal: 0 }),
      )
      .mockResolvedValueOnce(
        history([], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 0,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
          roomUnreadCount: 0,
          chatUnreadTotal: 0,
        }),
      )
      .mockResolvedValueOnce(
        history([firstMessage], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 0,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
          roomUnreadCount: 2,
          chatUnreadTotal: 2,
        }),
      );
    mocks.markRead.mockResolvedValue({
      conversationId: IDS.room,
      lastReadSequence: 2,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });
    setDocumentVisibility("hidden");
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: secondMessage,
        timestamp: "2026-09-13T12:05:00.000Z",
      });
    });

    expect(await screen.findByText("Happy to help")).toBeInTheDocument();
    expect(screen.getByText("Recovered while hidden")).toBeInTheDocument();
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(3));
    expect(mocks.history).toHaveBeenLastCalledWith(IDS.room, {
      afterSequence: 0,
      limit: 100,
    });
    expect(mocks.markRead).not.toHaveBeenCalled();

    act(() => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(IDS.room, 2));
  });

  it("recovers messages after reconnect using the highest durable sequence", async () => {
    const recovered = {
      ...firstMessage,
      id: IDS.secondMessage,
      sequence: 2,
      content: "Recovered after reconnect",
      safeLink: null,
      clientMessageId: "10000000-0000-4000-8000-000000000003",
    };
    mocks.history
      .mockResolvedValueOnce(history())
      .mockResolvedValueOnce(
        history([], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 1,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        history([recovered], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 1,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
          roomUnreadCount: 99,
          chatUnreadTotal: 99,
        }),
      );
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });
    await waitFor(() => expect(mocks.handlers.has("connect")).toBe(true));

    act(() => mocks.handlers.get("connect")?.());
    expect(await screen.findByText("Recovered after reconnect")).toBeInTheDocument();
    expect(mocks.history).toHaveBeenLastCalledWith(IDS.room, {
      afterSequence: 1,
      limit: 100,
    });
    expect(mocks.applyCounter).not.toHaveBeenCalledWith(
      99,
      IDS.room,
      99,
      expect.anything(),
    );
  });

  it("closes the initial fetch-to-subscribe gap from sequence zero", async () => {
    mocks.get.mockResolvedValue({
      conversation: {
        ...room,
        lastSequence: 0,
        lastMessage: null,
        viewer: { ...room.viewer, lastReadSequence: 0, unreadCount: 0 },
      },
      chatUnreadTotal: 0,
    });
    mocks.history
      .mockResolvedValueOnce(history([], { roomUnreadCount: 0, chatUnreadTotal: 0 }))
      .mockResolvedValueOnce(
        history([firstMessage], {
          pagination: {
            limit: 100,
            hasMore: false,
            beforeSequence: null,
            afterSequence: 0,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
        }),
      );
    renderPage();
    await screen.findByRole("heading", { name: "Amy Chen" });

    expect(await screen.findByText("Happy to help")).toBeInTheDocument();
    expect(mocks.history).toHaveBeenLastCalledWith(IDS.room, {
      afterSequence: 0,
      limit: 100,
    });
  });

  it("serializes read updates and eventually submits the highest visible cursor", async () => {
    let resolveFirst!: (value: {
      conversationId: string;
      lastReadSequence: number;
      unreadCount: number;
      chatUnreadTotal: number;
    }) => void;
    mocks.markRead
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        conversationId: IDS.room,
        lastReadSequence: 2,
        unreadCount: 0,
        chatUnreadTotal: 0,
      });
    renderPage();
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(IDS.room, 1));
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: {
          ...firstMessage,
          id: IDS.secondMessage,
          sequence: 2,
          content: "Read me too",
          safeLink: null,
          clientMessageId: "10000000-0000-4000-8000-000000000004",
        },
        timestamp: "2026-09-13T12:02:00.000Z",
      });
      mocks.counterGeneration = 1;
      mocks.handlers.get("chat_unread_update")?.({
        conversationId: IDS.room,
        roomUnreadCount: 1,
        chatUnreadTotal: 1,
        lastReadSequence: 1,
        timestamp: "2026-09-13T12:02:01.000Z",
      });
    });
    await screen.findByText("Read me too");
    expect(mocks.markRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        conversationId: IDS.room,
        lastReadSequence: 1,
        unreadCount: 1,
        chatUnreadTotal: 1,
      });
    });
    await waitFor(() =>
      expect(mocks.markRead).toHaveBeenNthCalledWith(2, IDS.room, 2),
    );
    expect(mocks.applyCounter).not.toHaveBeenCalledWith(
      0,
      IDS.room,
      0,
      1,
    );
  });

  it("retries a pending read cursor after a transient failure and reconnect", async () => {
    let rejectFirst!: (reason?: unknown) => void;
    mocks.markRead
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        conversationId: IDS.room,
        lastReadSequence: 1,
        unreadCount: 0,
        chatUnreadTotal: 0,
      });
    renderPage();
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));

    await act(async () => rejectFirst(new Error("Temporary network failure")));
    expect(mocks.markRead).toHaveBeenCalledTimes(1);

    act(() => mocks.handlers.get("connect")?.());
    await waitFor(() =>
      expect(mocks.markRead).toHaveBeenNthCalledWith(2, IDS.room, 1),
    );
  });

  it("keeps a current active read-only Room subscribed while disabling send", async () => {
    mocks.writable = false;
    mocks.get.mockResolvedValue({
      conversation: {
        ...room,
        viewer: {
          ...room.viewer,
          canSend: false,
          accessMode: "read_only",
        },
      },
      chatUnreadTotal: 1,
    });
    renderPage();

    expect(await screen.findByText(/This Room is read-only/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.join).toHaveBeenCalledWith(IDS.room));
    await waitFor(() => expect(mocks.handlers.has("chat_message")).toBe(true));

    act(() => {
      mocks.handlers.get("chat_message")?.({
        message: {
          ...firstMessage,
          id: IDS.secondMessage,
          sequence: 2,
          content: "Delivered while read-only",
          safeLink: null,
          clientMessageId: "10000000-0000-4000-8000-000000000005",
        },
        timestamp: "2026-09-13T12:03:00.000Z",
      });
    });
    expect(await screen.findByText("Delivered while read-only")).toBeInTheDocument();
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("keeps Past Rooms read-only without attempting a live subscription", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({
      conversation: {
        ...room,
        status: "archived",
        section: "past",
        archivedAt: "2026-09-14T12:00:00.000Z",
        viewer: {
          ...room.viewer,
          status: "history_only",
          unreadCount: 0,
          canSend: false,
          accessMode: "read_only",
        },
      },
      chatUnreadTotal: 0,
    });
    renderPage();

    expect(await screen.findByText(/This Room is read-only/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(mocks.join).not.toHaveBeenCalled();
    expect(mocks.markRead).not.toHaveBeenCalled();
    expect(screen.queryByText(/Live updates are unavailable/)).not.toBeInTheDocument();
    const mute = screen.getByRole("button", {
      name: "Mute Room notifications",
    });
    expect(mute).toBeEnabled();
    await user.click(mute);
    await waitFor(() =>
      expect(mocks.setMuted).toHaveBeenCalledWith(IDS.room, true),
    );
  });

  it("moves an open Help Room to read-only when its Help Request closes", async () => {
    const archivedRoom = {
      ...room,
      status: "archived" as const,
      section: "past" as const,
      archivedAt: "2026-09-13T12:05:00.000Z",
      viewer: {
        ...room.viewer,
        status: "history_only" as const,
        unreadCount: 0,
        canSend: false,
        accessMode: "read_only" as const,
      },
    };
    renderPage();
    await screen.findByLabelText("Message");
    await waitFor(() => expect(mocks.handlers.has("alumni_help_update")).toBe(true));
    mocks.get.mockResolvedValueOnce({
      conversation: archivedRoom,
      chatUnreadTotal: 0,
    });

    act(() => {
      mocks.handlers.get("alumni_help_update")?.({
        requestId: IDS.request,
        requestRevision: 5,
        helpActionRequiredCount: 0,
        timestamp: "2026-09-13T12:05:00.000Z",
      });
    });

    expect(await screen.findByText(/This Room is read-only/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.leave).toHaveBeenCalledWith(IDS.room));
  });

  it("refreshes an open Program Room to retained Past access after unenrollment", async () => {
    const currentProgramRoom = {
      ...room,
      kind: "program" as const,
      title: "EMBA 2026",
      helpRequestId: null,
      programId: "64b000000000000000000020",
      counterpart: null,
      viewer: {
        ...room.viewer,
        role: "mentor" as const,
        canAnnounce: true,
      },
    };
    const pastProgramRoom = {
      ...currentProgramRoom,
      section: "past" as const,
      viewer: {
        ...currentProgramRoom.viewer,
        status: "history_only" as const,
        unreadCount: 0,
        canSend: false,
        canAnnounce: false,
        accessMode: "read_only" as const,
      },
    };
    mocks.get.mockResolvedValueOnce({
      conversation: currentProgramRoom,
      chatUnreadTotal: 1,
    });
    renderPage();

    expect(
      await screen.findByRole("button", { name: "Post announcement" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(screen.getByText("Happy to help")).toBeInTheDocument();
    await waitFor(() => expect(mocks.handlers.has("disconnect")).toBe(true));

    act(() => {
      mocks.handlers.get("disconnect")?.("io server disconnect");
    });
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Post announcement" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Happy to help")).toBeInTheDocument();

    mocks.get
      .mockRejectedValueOnce(
        Object.assign(new Error("Program Room projection is changing."), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce({
        conversation: pastProgramRoom,
        chatUnreadTotal: 0,
      });
    await act(async () => {
      mocks.handlers.get("connect")?.();
    });

    expect(
      await screen.findByText("Program Room · Past · Read-only"),
    ).toBeInTheDocument();
    expect(screen.getByText("Happy to help")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(mocks.leave).toHaveBeenCalledWith(IDS.room));
  });

  it("keeps failed Program messages available across an ordinary network reconnect", async () => {
    const user = userEvent.setup();
    const currentProgramRoom = {
      ...room,
      kind: "program" as const,
      title: "EMBA 2026",
      helpRequestId: null,
      programId: "64b000000000000000000020",
      counterpart: null,
      viewer: {
        ...room.viewer,
        role: "mentee" as const,
      },
    };
    mocks.get.mockResolvedValue({
      conversation: currentProgramRoom,
      chatUnreadTotal: 1,
    });
    mocks.send.mockRejectedValueOnce(new Error("Network unavailable"));
    renderPage();

    await screen.findByRole("heading", { name: "EMBA 2026" });
    await user.type(screen.getByLabelText("Message"), "Keep my retry");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();

    act(() => {
      mocks.handlers.get("disconnect")?.("transport close");
      mocks.handlers.get("connect")?.();
    });

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Keep my retry")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
  });

  it("updates mute state and bounds local last-message previews", async () => {
    const user = userEvent.setup();
    renderPage();
    const mute = await screen.findByRole("button", {
      name: "Mute Room notifications",
    });
    await user.click(mute);
    await waitFor(() => expect(mocks.setMuted).toHaveBeenCalledWith(IDS.room, true));
    expect(
      await screen.findByRole("button", { name: "Unmute Room notifications" }),
    ).toHaveAttribute("aria-pressed", "true");

    const preview = previewContent("x".repeat(400));
    expect(Array.from(preview ?? "")).toHaveLength(161);
    expect(preview?.endsWith("…")).toBe(true);
  });

  it("follows runtime write-mode changes without a page reload", async () => {
    const rendered = renderPage();
    await screen.findByLabelText("Message");

    mocks.get.mockResolvedValueOnce({
      conversation: {
        ...room,
        viewer: {
          ...room.viewer,
          canSend: false,
          accessMode: "read_only",
        },
      },
      chatUnreadTotal: 0,
    });
    mocks.writable = false;
    rendered.rerender(pageTree());
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));

    mocks.get.mockResolvedValueOnce({ conversation: room, chatUnreadTotal: 0 });
    mocks.writable = true;
    rendered.rerender(pageTree());
    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
  });

  it("hides the previous account's Room while reauthorizing the same route", async () => {
    const rendered = renderPage();
    expect(await screen.findByText("Happy to help")).toBeInTheDocument();
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));

    let resolveNextRoom!: (value: {
      conversation: typeof room;
      chatUnreadTotal: number;
    }) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNextRoom = resolve;
        }),
    );
    mocks.history.mockResolvedValue(
      history([], { roomUnreadCount: 0, chatUnreadTotal: 0 }),
    );
    mocks.userId = "64b000000000000000000099";
    rendered.rerender(pageTree());

    expect(screen.queryByText("Happy to help")).not.toBeInTheDocument();
    expect(screen.getByText("Loading Chat Room...")).toBeInTheDocument();
    await waitFor(() => expect(resolveNextRoom).toBeTypeOf("function"));
    await act(async () => {
      resolveNextRoom({
        conversation: { ...room, title: "New account Room" },
        chatUnreadTotal: 0,
      });
    });

    expect(
      await screen.findByRole("heading", { name: "New account Room" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Happy to help")).not.toBeInTheDocument();
  });
});
