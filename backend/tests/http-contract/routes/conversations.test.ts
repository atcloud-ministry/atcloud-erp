import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middlewareMocks = vi.hoisted(() => ({
  permission: vi.fn(),
  authorizationAction: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get("Authorization");
    if (!authorization) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    if (authorization !== "Bearer broken-context") {
      req.userId = "507f1f77bcf86cd799439011";
      req.userRole = "Participant";
    }
    req.correlationId = req.get("x-correlation-id") ?? undefined;
    next();
  },
  authorizePermission:
    (permission: string) =>
    (_req: Request, res: Response, next: NextFunction) => {
      middlewareMocks.permission(permission);
      if (_req.get("x-deny-permission") === "true") {
        res.status(403).json({ success: false, message: "Access denied." });
        return;
      }
      next();
    },
}));

vi.mock("../../../src/middleware/authorization", () => ({
  authorizeHttp:
    (options: { action: string }) =>
    (req: Request, res: Response, next: NextFunction) => {
      middlewareMocks.authorizationAction(options.action);
      if (req.get("x-deny-room") === "true") {
        res.status(404).json({
          success: false,
          message: "Resource not found.",
          reasonCode: "resource_not_found",
        });
        return;
      }
      next();
    },
}));

import type { AlumniNetworkMode } from "../../../src/config/alumniNetworkFeature";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import conversationRoutes from "../../../src/routes/conversations";
import {
  ChatRoomError,
  chatRoomNotFound,
} from "../../../src/services/chat/ChatRoomErrors";
import { chatRoomService } from "../../../src/services/chat/ChatRoomService";
import { AUTHORIZATION_ACTIONS } from "../../../src/services/authorization/types";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import { reliabilityFoundationService } from "../../../src/services/reliability/ReliabilityFoundationService";
import { featureControlService } from "../../../src/services/runtime/FeatureControlService";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

const USER_ID = "507f1f77bcf86cd799439011";
const OTHER_ID = "507f1f77bcf86cd799439012";
const ROOM_ID = "507f191e810c19729de860ea";
const REQUEST_ID = "507f191e810c19729de860eb";
const PROGRAM_ID = "507f191e810c19729de860ed";
const MESSAGE_ID = "507f191e810c19729de860ec";
const CLIENT_MESSAGE_ID = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";

const MESSAGE = Object.freeze({
  id: MESSAGE_ID,
  conversationId: ROOM_ID,
  sequence: 7,
  sender: Object.freeze({ id: OTHER_ID, displayName: "Amy Chen", avatar: null }),
  clientMessageId: CLIENT_MESSAGE_ID,
  kind: "text" as const,
  content: "Hello",
  safeLink: null,
  createdAt: "2026-09-12T12:00:00.000Z",
});

const CONVERSATION = Object.freeze({
  id: ROOM_ID,
  kind: "alumni_help" as const,
  status: "current" as const,
  section: "current" as const,
  title: "Amy Chen",
  helpRequestId: REQUEST_ID,
  programId: null,
  counterpart: Object.freeze({ id: OTHER_ID, displayName: "Amy Chen", avatar: null }),
  lastSequence: 7,
  lastMessage: Object.freeze({
    id: MESSAGE_ID,
    sequence: 7,
    kind: "text" as const,
    sender: MESSAGE.sender,
    contentPreview: "Hello",
    safeLink: null,
    createdAt: MESSAGE.createdAt,
  }),
  viewer: Object.freeze({
    role: "requester" as const,
    status: "active" as const,
    lastReadSequence: 6,
    unreadCount: 1,
    muted: false,
    accessMode: "read_write" as const,
    canSend: true,
    canAnnounce: false,
  }),
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: MESSAGE.createdAt,
  archivedAt: null,
  writeAccessEndsAt: null,
});

const PAGINATION = Object.freeze({
  currentPage: 1,
  totalPages: 1,
  totalCount: 1,
  hasNext: false,
  hasPrev: false,
});

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/conversations", conversationRoutes);
  return app;
}

function member(builder: request.Test): request.Test {
  return builder.set("Authorization", "Bearer member");
}

function setMode(mode: AlumniNetworkMode): void {
  vi.mocked(featureControlService.getRuntimeConfig).mockResolvedValue(
    createRuntimeConfigDTO(mode, 4),
  );
}

describe("conversation HTTP contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    middlewareMocks.permission.mockClear();
    middlewareMocks.authorizationAction.mockClear();
    vi.spyOn(featureControlService, "getRuntimeConfig");
    setMode("on");
  });

  it("requires authentication and profile-view permission", async () => {
    const list = vi.spyOn(chatRoomService, "list").mockResolvedValue({
      conversations: [],
      pagination: { ...PAGINATION, totalPages: 0, totalCount: 0 },
      chatUnreadTotal: 0,
    });
    const app = buildApp();

    await request(app).get("/api/conversations").expect(401);
    await member(request(app).get("/api/conversations"))
      .set("x-deny-permission", "true")
      .expect(403);
    await member(request(app).get("/api/conversations")).expect(200);

    expect(middlewareMocks.permission).toHaveBeenCalledWith(
      PERMISSIONS.VIEW_USER_PROFILES,
    );
    expect(list).toHaveBeenCalledWith(USER_ID, {
      view: "current",
      page: 1,
      limit: 30,
    });
  });

  it("maps list, total, detail, and directional history reads", async () => {
    vi.spyOn(chatRoomService, "list").mockResolvedValue({
      conversations: [CONVERSATION],
      pagination: PAGINATION,
      chatUnreadTotal: 1,
    });
    vi.spyOn(chatRoomService, "unreadTotal").mockResolvedValue({
      chatUnreadTotal: 1,
    });
    vi.spyOn(chatRoomService, "get").mockResolvedValue({
      conversation: CONVERSATION,
      chatUnreadTotal: 1,
    });
    const history = vi.spyOn(chatRoomService, "history").mockResolvedValue({
      conversationId: ROOM_ID,
      messages: [MESSAGE],
      pagination: {
        limit: 50,
        hasMore: false,
        beforeSequence: null,
        afterSequence: 6,
        nextBeforeSequence: null,
        nextAfterSequence: null,
      },
      roomUnreadCount: 1,
      chatUnreadTotal: 1,
    });
    const app = buildApp();

    const listResponse = await member(
      request(app).get("/api/conversations?view=past&page=1&limit=10"),
    ).expect(200);
    expect(listResponse.headers["cache-control"]).toBe("no-store");
    await member(request(app).get("/api/conversations/unread-count")).expect(200);
    await member(request(app).get(`/api/conversations/${ROOM_ID}`)).expect(200);
    await member(
      request(app).get(
        `/api/conversations/${ROOM_ID}/messages?afterSequence=6`,
      ),
    ).expect(200);

    expect(history).toHaveBeenCalledWith(USER_ID, ROOM_ID, {
      afterSequence: 6,
      limit: 50,
    });
    expect(middlewareMocks.authorizationAction).toHaveBeenCalledWith(
      AUTHORIZATION_ACTIONS.CONVERSATION_READ,
    );
  });

  it("maps the authenticated, feature-gated Program Room lookup without a public ID", async () => {
    const lookup = vi
      .spyOn(chatRoomService, "getProgramRoomLink")
      .mockResolvedValue({
        room: {
          id: ROOM_ID,
          programId: PROGRAM_ID,
          status: "current",
          section: "past",
          viewer: { status: "history_only", accessMode: "read_only" },
        },
      });
    const app = buildApp();

    await request(app)
      .get(`/api/conversations/program/${PROGRAM_ID}`)
      .expect(401);
    const response = await member(
      request(app).get(`/api/conversations/program/${PROGRAM_ID}`),
    ).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data.room).toMatchObject({
      id: ROOM_ID,
      section: "past",
      viewer: { accessMode: "read_only" },
    });
    expect(lookup).toHaveBeenCalledWith(USER_ID, PROGRAM_ID);

    lookup.mockRejectedValueOnce(chatRoomNotFound());
    const missingResponse = await member(
      request(app).get(`/api/conversations/program/${PROGRAM_ID}`),
    ).expect(200);
    expect(missingResponse.body).toEqual({
      success: true,
      data: { room: null },
    });

    lookup.mockRejectedValueOnce(new Error("membership resolver unavailable"));
    const unavailableResponse = await member(
      request(app).get(`/api/conversations/program/${PROGRAM_ID}`),
    ).expect(503);
    expect(unavailableResponse.body).toEqual({
      success: false,
      code: "CHAT_OPERATION_UNAVAILABLE",
      message: "The chat operation is temporarily unavailable.",
    });

    setMode("off");
    await member(
      request(app).get(`/api/conversations/program/${PROGRAM_ID}`),
    ).expect(503);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("maps send/read/mute bodies and idempotency context exactly", async () => {
    const send = vi.spyOn(chatRoomService, "send").mockResolvedValue({
      message: MESSAGE,
      roomUnreadCount: 0,
      chatUnreadTotal: 2,
    });
    const markRead = vi.spyOn(chatRoomService, "markRead").mockResolvedValue({
      conversationId: ROOM_ID,
      lastReadSequence: 7,
      unreadCount: 0,
      chatUnreadTotal: 1,
    });
    const mute = vi.spyOn(chatRoomService, "setMuted").mockResolvedValue({
      conversationId: ROOM_ID,
      muted: true,
      chatUnreadTotal: 1,
    });
    const emitUnread = vi
      .spyOn(socketService, "emitChatUnreadUpdate")
      .mockReturnValue(true);
    const wake = vi
      .spyOn(reliabilityFoundationService, "wakeNotificationOutbox")
      .mockReturnValue(false);
    const app = buildApp();
    const correlationId = "chat-http-contract";

    await member(request(app).post(`/api/conversations/${ROOM_ID}/messages`))
      .set("Idempotency-Key", CLIENT_MESSAGE_ID)
      .set("x-correlation-id", correlationId)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, content: "Hello" })
      .expect(201);
    await member(request(app).patch(`/api/conversations/${ROOM_ID}/read`))
      .send({ throughSequence: 7 })
      .expect(200);
    await member(request(app).patch(`/api/conversations/${ROOM_ID}/mute`))
      .send({ muted: true })
      .expect(200);

    expect(send).toHaveBeenCalledWith({
      conversationId: ROOM_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      content: "Hello",
      safeLink: null,
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: CLIENT_MESSAGE_ID,
      correlationId,
    });
    expect(markRead).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: ROOM_ID, throughSequence: 7 }),
    );
    expect(mute).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: ROOM_ID, muted: true }),
    );
    expect(emitUnread).toHaveBeenCalledWith(USER_ID, {
      conversationId: ROOM_ID,
      roomUnreadCount: 0,
      chatUnreadTotal: 1,
      lastReadSequence: 7,
    });
    expect(wake).toHaveBeenCalledOnce();
    expect(middlewareMocks.authorizationAction.mock.calls.map(([action]) => action))
      .toEqual([
        AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
        AUTHORIZATION_ACTIONS.CONVERSATION_UPDATE_STATE,
        AUTHORIZATION_ACTIONS.CONVERSATION_READ,
      ]);
  });

  it("maps the strict Program announcement body and idempotency context", async () => {
    const announcement = { ...MESSAGE, kind: "announcement" as const };
    const publish = vi
      .spyOn(chatRoomService, "publishAnnouncement")
      .mockResolvedValue({
        message: announcement,
        roomUnreadCount: 0,
        chatUnreadTotal: 2,
      });
    const wake = vi
      .spyOn(reliabilityFoundationService, "wakeNotificationOutbox")
      .mockReturnValue(false);
    const correlationId = "program-announcement-contract";

    const response = await member(
      request(buildApp()).post(
        `/api/conversations/${ROOM_ID}/announcements`,
      ),
    )
      .set("Idempotency-Key", CLIENT_MESSAGE_ID)
      .set("x-correlation-id", correlationId)
      .send({
        clientMessageId: CLIENT_MESSAGE_ID.toUpperCase(),
        content: "  Program update  ",
      })
      .expect(201);

    expect(response.body.data.message.kind).toBe("announcement");
    expect(publish).toHaveBeenCalledWith({
      conversationId: ROOM_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      content: "Program update",
      actor: { id: USER_ID, role: "Participant" },
      idempotencyKey: CLIENT_MESSAGE_ID,
      correlationId,
    });
    expect(middlewareMocks.authorizationAction).toHaveBeenLastCalledWith(
      AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
    );
    expect(wake).toHaveBeenCalledOnce();

    await member(
      request(buildApp()).post(
        `/api/conversations/${ROOM_ID}/announcements`,
      ),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ clientMessageId: randomUUID(), content: "Update", extra: true })
      .expect(400);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not fail a committed read when realtime synchronization is unavailable", async () => {
    vi.spyOn(chatRoomService, "markRead").mockResolvedValue({
      conversationId: ROOM_ID,
      lastReadSequence: 7,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });
    vi.spyOn(socketService, "emitChatUnreadUpdate").mockImplementation(() => {
      throw new Error("socket unavailable");
    });

    const response = await member(
      request(buildApp()).patch(`/api/conversations/${ROOM_ID}/read`),
    )
      .send({ throughSequence: 7 })
      .expect(200);
    expect(response.body.data).toMatchObject({
      conversationId: ROOM_ID,
      lastReadSequence: 7,
      unreadCount: 0,
      chatUnreadTotal: 0,
    });
  });

  it("enforces off reads while allowing canonical replay to reach the service in read-only mode", async () => {
    const list = vi.spyOn(chatRoomService, "list").mockResolvedValue({
      conversations: [],
      pagination: { ...PAGINATION, totalPages: 0, totalCount: 0 },
      chatUnreadTotal: 0,
    });
    const send = vi.spyOn(chatRoomService, "send").mockResolvedValue({
      message: MESSAGE,
      roomUnreadCount: 0,
      chatUnreadTotal: 0,
    });
    const app = buildApp();

    setMode("off");
    await member(request(app).get("/api/conversations")).expect(503);
    expect(list).not.toHaveBeenCalled();

    setMode("read_only");
    await member(request(app).get("/api/conversations")).expect(200);
    const replay = await member(
      request(app).post(`/api/conversations/${ROOM_ID}/messages`),
    )
      .set("Idempotency-Key", CLIENT_MESSAGE_ID)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, content: "Hello" })
      .expect(201);
    expect(replay.body.data.message.id).toBe(MESSAGE_ID);
    expect(send).toHaveBeenCalledTimes(1);
    expect(middlewareMocks.authorizationAction).toHaveBeenLastCalledWith(
      AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
    );

    send.mockRejectedValueOnce(
      new ChatRoomError(
        "CHAT_ROOM_READ_ONLY",
        409,
        "The chat room is read-only.",
      ),
    );
    const newWrite = await member(
      request(app).post(`/api/conversations/${ROOM_ID}/messages`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({ clientMessageId: randomUUID(), content: "New content" })
      .expect(409);
    expect(newWrite.body.code).toBe("CHAT_ROOM_READ_ONLY");
  });

  it("conceals non-member POSTs before the send-or-replay service path", async () => {
    const send = vi.spyOn(chatRoomService, "send");
    const response = await member(
      request(buildApp()).post(`/api/conversations/${ROOM_ID}/messages`),
    )
      .set("x-deny-room", "true")
      .set("Idempotency-Key", CLIENT_MESSAGE_ID)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, content: "Hello" })
      .expect(404);
    expect(response.body.reasonCode).toBe("resource_not_found");
    expect(send).not.toHaveBeenCalled();
  });

  it("conceals room authorization failures before service invocation", async () => {
    const get = vi.spyOn(chatRoomService, "get").mockResolvedValue({
      conversation: CONVERSATION,
      chatUnreadTotal: 0,
    });
    const response = await member(
      request(buildApp()).get(`/api/conversations/${ROOM_ID}`),
    )
      .set("x-deny-room", "true")
      .expect(404);
    expect(response.body.reasonCode).toBe("resource_not_found");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects invalid cursors, missing keys, unknown fields, and oversized payloads", async () => {
    const history = vi.spyOn(chatRoomService, "history");
    const send = vi.spyOn(chatRoomService, "send");
    const app = buildApp();

    await member(
      request(app).get(
        `/api/conversations/${ROOM_ID}/messages?beforeSequence=5&afterSequence=4`,
      ),
    ).expect(400);
    await member(request(app).post(`/api/conversations/${ROOM_ID}/messages`))
      .send({ clientMessageId: CLIENT_MESSAGE_ID, content: "Hello" })
      .expect(400);
    const oversized = await member(
      request(app).post(`/api/conversations/${ROOM_ID}/messages`),
    )
      .set("Idempotency-Key", randomUUID())
      .send({
        clientMessageId: randomUUID(),
        content: "😀".repeat(4_000),
        safeLink: {
          url: `https://example.org/${"a".repeat(500)}`,
          label: "Reference",
        },
      })
      .expect(413);
    expect(oversized.body.code).toBe("CHAT_MESSAGE_PAYLOAD_TOO_LARGE");
    expect(history).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("maps rate limits without exposing internal failures", async () => {
    vi.spyOn(chatRoomService, "send").mockRejectedValue(
      new ChatRoomError(
        "CHAT_SEND_RATE_LIMITED",
        429,
        "Too many chat messages were sent. Please try again shortly.",
        8,
      ),
    );
    const response = await member(
      request(buildApp()).post(`/api/conversations/${ROOM_ID}/messages`),
    )
      .set("Idempotency-Key", CLIENT_MESSAGE_ID)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, content: "Hello" })
      .expect(429);
    expect(response.headers["retry-after"]).toBe("8");
    expect(response.body).toEqual({
      success: false,
      code: "CHAT_SEND_RATE_LIMITED",
      message: "Too many chat messages were sent. Please try again shortly.",
    });
  });
});
