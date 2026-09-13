import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationsService } from "../../services/api/conversations.api";

const IDS = {
  room: "64b000000000000000000001",
  request: "64b000000000000000000002",
  program: "64b000000000000000000005",
  user: "64b000000000000000000003",
  message: "64b000000000000000000004",
};
const clientMessageId = "550e8400-e29b-41d4-a716-446655440000";
const participant = { id: IDS.user, displayName: "Amy Chen", avatar: null };
const message = {
  id: IDS.message,
  conversationId: IDS.room,
  sequence: 1,
  kind: "text",
  sender: participant,
  content: "Hello",
  safeLink: null,
  clientMessageId,
  createdAt: "2026-09-13T12:00:00.000Z",
};
const conversation = {
  id: IDS.room,
  kind: "alumni_help",
  status: "current",
  section: "current",
  title: "Amy Chen",
  helpRequestId: IDS.request,
  programId: null,
  counterpart: participant,
  lastSequence: 1,
  lastMessage: {
    id: IDS.message,
    sequence: 1,
    kind: "text",
    sender: participant,
    contentPreview: "Hello",
    safeLink: null,
    createdAt: "2026-09-13T12:00:00.000Z",
  },
  viewer: {
    role: "requester",
    status: "active",
    lastReadSequence: 0,
    unreadCount: 1,
    muted: false,
    canSend: true,
    canAnnounce: false,
    accessMode: "read_write",
  },
  archivedAt: null,
  createdAt: "2026-09-13T11:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, message: "ok", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Conversations API client", () => {
  it("uses canonical bounded list, detail, unread, and history endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const value = String(url);
      if (value.includes("/unread-count")) return response({ chatUnreadTotal: 4 });
      if (value.includes("/messages")) {
        return response({
          conversationId: IDS.room,
          messages: [message],
          pagination: {
            limit: 50,
            hasMore: false,
            beforeSequence: null,
            afterSequence: null,
            nextBeforeSequence: null,
            nextAfterSequence: null,
          },
          roomUnreadCount: 1,
          chatUnreadTotal: 4,
        });
      }
      if (value.endsWith(IDS.room)) {
        return response({ conversation, chatUnreadTotal: 4 });
      }
      return response({
        conversations: [conversation],
        pagination: {
          currentPage: 2,
          totalPages: 2,
          totalCount: 31,
          hasNext: false,
          hasPrev: true,
        },
        chatUnreadTotal: 4,
      });
    });

    await conversationsService.list({ view: "past", page: 2, limit: 30 });
    await conversationsService.getUnreadCount();
    await conversationsService.get(IDS.room);
    await conversationsService.history(IDS.room, { limit: 50 });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/api/conversations?view=past&page=2&limit=30"),
        expect.stringContaining("/api/conversations/unread-count"),
        expect.stringMatching(new RegExp(`/api/conversations/${IDS.room}$`)),
        expect.stringContaining(`/api/conversations/${IDS.room}/messages?limit=50`),
      ]),
    );
  });

  it("uses the same UUID for durable client identity and idempotency", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ message, roomUnreadCount: 0, chatUnreadTotal: 3 }),
    );

    await conversationsService.send(IDS.room, {
      clientMessageId,
      content: " Hello ",
      safeLink: { url: "https://example.com/path" },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options?.method).toBe("POST");
    expect((options?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      clientMessageId,
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      clientMessageId,
      content: "Hello",
      safeLink: {
        url: "https://example.com/path",
        label: "https://example.com/path",
      },
    });
  });

  it("publishes Program announcements through the independent idempotent endpoint", async () => {
    const announcement = {
      ...message,
      kind: "announcement",
      content: "Program starts tomorrow",
      safeLink: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ message: announcement, roomUnreadCount: 0, chatUnreadTotal: 3 }),
    );

    await expect(
      conversationsService.publishAnnouncement(IDS.room, {
        clientMessageId,
        content: "  Program starts tomorrow  ",
      }),
    ).resolves.toMatchObject({ message: { kind: "announcement" } });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      new RegExp(`/api/conversations/${IDS.room}/announcements$`),
    );
    expect(options?.method).toBe("POST");
    expect((options?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      clientMessageId,
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      clientMessageId,
      content: "Program starts tomorrow",
    });
  });

  it("supports safe-link-only sends and compact read/mute responses", async () => {
    const safeLinkMessage = {
      ...message,
      content: null,
      safeLink: { url: "https://example.com", label: "Example" },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const body = JSON.parse(String(options?.body ?? "{}"));
      if ("throughSequence" in body) {
        return response({
          conversationId: IDS.room,
          lastReadSequence: 1,
          unreadCount: 0,
          chatUnreadTotal: 0,
        });
      }
      if ("muted" in body) {
        return response({
          conversationId: IDS.room,
          muted: true,
          chatUnreadTotal: 0,
        });
      }
      return response({
        message: safeLinkMessage,
        roomUnreadCount: 0,
        chatUnreadTotal: 0,
      });
    });

    await conversationsService.send(IDS.room, {
      clientMessageId,
      content: null,
      safeLink: { url: "https://example.com", label: "Example" },
    });
    await conversationsService.markRead(IDS.room, 1);
    await conversationsService.setMuted(IDS.room, true);

    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual([
      "POST",
      "PATCH",
      "PATCH",
    ]);
  });

  it("supports reconnect recovery from afterSequence zero", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        conversationId: IDS.room,
        messages: [message],
        pagination: {
          limit: 100,
          hasMore: false,
          beforeSequence: null,
          afterSequence: 0,
          nextBeforeSequence: null,
          nextAfterSequence: null,
        },
        roomUnreadCount: 1,
        chatUnreadTotal: 1,
      }),
    );

    await conversationsService.history(IDS.room, {
      afterSequence: 0,
      limit: 100,
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/api/conversations/${IDS.room}/messages?limit=100&afterSequence=0`,
    );
  });

  it("uses the authenticated Program Room lookup endpoint", async () => {
    const room = {
      id: IDS.room,
      programId: IDS.program,
      status: "current",
      section: "current",
      viewer: { status: "active", accessMode: "read_write" },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response({ room }));

    await expect(conversationsService.getProgramRoom(IDS.program)).resolves.toEqual({
      room,
    });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      new RegExp(`/api/conversations/program/${IDS.program}$`),
    );
    await expect(conversationsService.getProgramRoom("not-an-id")).rejects.toThrow(
      /Program ID/u,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects unsafe pagination, ambiguous history, UUID, and links locally", async () => {
    await expect(
      conversationsService.list({
        view: "current",
        page: Number.MAX_SAFE_INTEGER,
        limit: 100,
      }),
    ).rejects.toThrow(/outside the supported range/);
    await expect(
      conversationsService.history(IDS.room, {
        beforeSequence: 3,
        afterSequence: 4,
      }),
    ).rejects.toThrow(/cannot request/);
    await expect(
      conversationsService.history(IDS.room, { afterSequence: -1 }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      conversationsService.send(IDS.room, {
        clientMessageId: "not-a-uuid",
        content: "Hello",
      }),
    ).rejects.toThrow(/UUID/);
    await expect(
      conversationsService.send(IDS.room, {
        clientMessageId,
        content: "Hello",
        safeLink: { url: "javascript:alert(1)" },
      }),
    ).rejects.toThrow(/http/);
  });
});

export { conversation as chatConversationFixture, message as chatMessageFixture };
