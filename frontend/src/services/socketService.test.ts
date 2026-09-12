import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventUpdate } from "../types/realtime";
import {
  ConversationRoomJoinError,
  decodeConnectionLimitPayload,
  SocketRoomJoinError,
  SocketServiceFrontend,
  type SocketRoomAck,
} from "./socketService";

const fakeIo = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeSocket {
    connected = false;
    active = true;
    connectCalls = 0;
    disconnectCalls = 0;
    emitted: Array<{ event: string; args: unknown[] }> = [];
    joinAcks: SocketRoomAck[] = [];
    conversationJoinAcks: Array<
      | { ok: true; conversationId: string }
      | { ok: false; code: "AUTHORIZATION_FAILED" | "RATE_LIMITED" }
    > = [];
    deferJoinAcks = false;
    pendingJoinAcks: Array<{
      eventId: string;
      ack: (result: SocketRoomAck) => void;
    }> = [];
    private listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    off(event: string, listener?: Listener) {
      if (!listener) this.listeners.delete(event);
      else this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      this.emitted.push({ event, args });
      if (event === "join_event_room") {
        const eventId = args[0] as string;
        const ack = args[1] as ((result: SocketRoomAck) => void) | undefined;
        if (ack && this.deferJoinAcks) {
          this.pendingJoinAcks.push({ eventId, ack });
        } else {
          ack?.(this.joinAcks.shift() ?? { ok: true, eventId });
        }
      } else if (event === "join_conversation_room") {
        const conversationId = args[0] as string;
        const ack = args[1] as
          | ((result: unknown) => void)
          | undefined;
        ack?.(
          this.conversationJoinAcks.shift() ?? {
            ok: true,
            conversationId,
          },
        );
      }
      return this;
    }

    connect() {
      this.connectCalls += 1;
      this.active = true;
      return this;
    }

    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
      this.active = false;
      return this;
    }

    removeAllListeners() {
      this.listeners.clear();
      return this;
    }

    serverEmit(event: string, ...args: unknown[]) {
      if (event === "connect") {
        this.connected = true;
        this.active = true;
      } else if (event === "disconnect") {
        this.connected = false;
      }

      Array.from(this.listeners.get(event) ?? []).forEach((listener) => {
        listener(...args);
      });
    }

    emittedCount(event: string) {
      return this.emitted.filter((entry) => entry.event === event).length;
    }

    respondToNextJoin(result?: SocketRoomAck) {
      const pending = this.pendingJoinAcks.shift();
      if (!pending) throw new Error("No pending join ack");
      pending.ack(result ?? { ok: true, eventId: pending.eventId });
    }
  }

  const sockets: FakeSocket[] = [];
  const io = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });

  return { io, sockets };
});

vi.mock("socket.io-client", () => ({ io: fakeIo.io }));

describe("SocketServiceFrontend", () => {
  beforeEach(() => {
    vi.useRealTimers();
    fakeIo.io.mockClear();
    fakeIo.sockets.length = 0;
  });

  it("shares one connection and disconnects after the final consumer", () => {
    vi.useFakeTimers();
    const service = new SocketServiceFrontend();

    const releaseFirst = service.acquire("token", "https://socket.test");
    const releaseSecond = service.acquire("token", "https://socket.test");
    const socket = fakeIo.sockets[0];

    expect(fakeIo.io).toHaveBeenCalledTimes(1);
    expect(service.connectionStatus.consumers).toBe(2);

    releaseFirst();
    vi.runAllTimers();
    expect(socket.disconnectCalls).toBe(0);

    releaseSecond();
    vi.runAllTimers();
    expect(socket.disconnectCalls).toBe(1);
    expect(service.connectionStatus.consumers).toBe(0);
  });

  it("dispatches to multiple subscribers and removes only the requested one", () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = service.on("event_update", first);
    service.on("event_update", second);

    const update: EventUpdate = {
      eventId: "event-1",
      updateType: "guest_updated",
      data: null,
      timestamp: "2026-07-09T12:00:00.000Z",
    };

    socket.serverEmit("event_update", update);
    socket.serverEmit("event_update", update);

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    stopFirst();
    socket.serverEmit("event_update", {
      ...update,
      timestamp: "2026-07-09T12:00:01.000Z",
    });

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("reference-counts rooms and rejoins them after Socket.IO reconnects", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];

    await service.joinEventRoom("event-1");
    await service.joinEventRoom("event-1");
    expect(service.connectionStatus.pendingRooms).toEqual(["event-1"]);

    socket.serverEmit("connect");
    expect(socket.emittedCount("join_event_room")).toBe(1);

    service.leaveEventRoom("event-1");
    expect(socket.emittedCount("leave_event_room")).toBe(0);

    socket.serverEmit("disconnect", "transport close");
    expect(socket.connectCalls).toBe(0);
    socket.serverEmit("connect");
    expect(socket.emittedCount("join_event_room")).toBe(2);

    service.leaveEventRoom("event-1");
    expect(socket.emittedCount("leave_event_room")).toBe(1);
    expect(service.connectionStatus.joinedRooms).toEqual([]);
  });

  it("reference-counts conversation rooms and rejoins them after reconnect", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");

    await service.joinConversationRoom("conversation-1");
    await service.joinConversationRoom("conversation-1");
    expect(socket.emittedCount("join_conversation_room")).toBe(1);
    expect(service.connectionStatus.joinedConversationRooms).toEqual([
      "conversation-1",
    ]);

    service.leaveConversationRoom("conversation-1");
    expect(socket.emittedCount("leave_conversation_room")).toBe(0);
    socket.serverEmit("disconnect", "transport close");
    socket.serverEmit("connect");
    expect(socket.emittedCount("join_conversation_room")).toBe(2);

    service.leaveConversationRoom("conversation-1");
    expect(socket.emittedCount("leave_conversation_room")).toBe(1);
    expect(service.connectionStatus.joinedConversationRooms).toEqual([]);
  });

  it("does not retain a conversation room after a live authorization denial", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");
    socket.conversationJoinAcks.push({
      ok: false,
      code: "AUTHORIZATION_FAILED",
    });

    await expect(
      service.joinConversationRoom("conversation-1"),
    ).rejects.toMatchObject({
      name: "ConversationRoomJoinError",
      conversationId: "conversation-1",
      code: "AUTHORIZATION_FAILED",
    });
    expect(service.connectionStatus.joinedConversationRooms).toEqual([]);
    expect(service.connectionStatus.pendingConversationRooms).toEqual([]);
    expect(ConversationRoomJoinError).toBeDefined();
  });

  it("re-authenticates after the server disconnects sockets for an authorization change", async () => {
    const service = new SocketServiceFrontend();
    const release = service.acquire("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");

    await service.joinEventRoom("event-1");
    socket.serverEmit("disconnect", "io server disconnect");

    expect(socket.connectCalls).toBe(1);
    expect(service.connectionStatus.connecting).toBe(true);
    expect(service.connectionStatus.pendingRooms).toEqual(["event-1"]);
    service.leaveEventRoom("event-1");
    release();
  });

  it("does not reconnect a socket evicted by the per-account connection limit", () => {
    const service = new SocketServiceFrontend();
    const limited = vi.fn();
    service.on("connection_limit", limited);
    service.acquire("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");

    socket.serverEmit("connection_limit", {
      limit: 5,
      disconnectedAt: "2026-09-13T12:00:00.000Z",
    });
    socket.serverEmit("disconnect", "io server disconnect");

    expect(limited).toHaveBeenCalledWith({
      limit: 5,
      disconnectedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(socket.connectCalls).toBe(0);
    expect(service.connectionStatus).toMatchObject({
      connected: false,
      connecting: false,
      connectionLimited: true,
    });

    service.connect("token", "https://socket.test");
    expect(socket.connectCalls).toBe(0);
  });

  it("strictly validates the connection-limit control payload", () => {
    expect(
      decodeConnectionLimitPayload({
        limit: 5,
        disconnectedAt: "2026-09-13T12:00:00.000Z",
      }),
    ).toEqual({
      limit: 5,
      disconnectedAt: "2026-09-13T12:00:00.000Z",
    });
    expect(() =>
      decodeConnectionLimitPayload({
        limit: 5,
        disconnectedAt: "not-a-date",
      }),
    ).toThrow(/Invalid connection_limit payload/);
    expect(() =>
      decodeConnectionLimitPayload({
        limit: 5,
        disconnectedAt: "2026-09-13T12:00:00.000Z",
        userId: "should-not-cross-the-boundary",
      }),
    ).toThrow(/Invalid connection_limit payload/);
  });

  it("keeps retrying transient outages until an explicit terminal signal", () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");

    expect(fakeIo.io).toHaveBeenCalledWith(
      "https://socket.test",
      expect.objectContaining({ reconnectionAttempts: Infinity }),
    );
  });

  it("waits for a refreshed token after token-expiry disconnect", async () => {
    const service = new SocketServiceFrontend();
    service.connect("expired-token", "https://socket.test");
    const firstSocket = fakeIo.sockets[0];
    firstSocket.serverEmit("connect");
    await service.joinEventRoom("event-1");

    firstSocket.serverEmit("auth_expired", {
      expiredAt: "2026-09-08T18:00:00.000Z",
    });
    firstSocket.serverEmit("disconnect", "io server disconnect");
    expect(firstSocket.connectCalls).toBe(0);
    expect(service.connectionStatus.pendingRooms).toEqual(["event-1"]);

    service.updateAuthenticationToken("fresh-token");
    expect(fakeIo.sockets).toHaveLength(2);
    expect(firstSocket.disconnectCalls).toBe(1);
    const secondSocket = fakeIo.sockets[1];
    secondSocket.serverEmit("connect");
    expect(secondSocket.emittedCount("join_event_room")).toBe(1);
    service.disconnect();
  });

  it("replaces an existing socket when HTTP refreshes its access token", () => {
    const service = new SocketServiceFrontend();
    service.connect("first-token", "https://socket.test");
    const firstSocket = fakeIo.sockets[0];

    service.updateAuthenticationToken("second-token");

    expect(firstSocket.disconnectCalls).toBe(1);
    expect(fakeIo.sockets).toHaveLength(2);
    expect(fakeIo.io).toHaveBeenLastCalledWith(
      "https://socket.test",
      expect.objectContaining({ auth: { token: "second-token" } }),
    );
  });

  it("retains room ownership when a pending join is interrupted by disconnect", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");
    socket.deferJoinAcks = true;

    const join = service.joinEventRoom("event-1");
    socket.serverEmit("disconnect", "transport close");

    await expect(join).rejects.toMatchObject({
      name: "SocketRoomJoinError",
      code: "AUTHORIZATION_FAILED",
    });
    expect(service.connectionStatus.pendingRooms).toEqual(["event-1"]);

    socket.serverEmit("connect");
    expect(socket.emittedCount("join_event_room")).toBe(2);
    socket.respondToNextJoin();
    socket.respondToNextJoin();
    await Promise.resolve();
    service.disconnect();
  });

  it("records a room only after an accepted ack and allows retry after denial", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");
    socket.joinAcks.push({ ok: false, code: "RATE_LIMITED" });

    await expect(service.joinEventRoom("event-1")).rejects.toMatchObject({
      name: "SocketRoomJoinError",
      eventId: "event-1",
      code: "RATE_LIMITED",
    });
    expect(service.connectionStatus.joinedRooms).toEqual([]);
    expect(service.connectionStatus.pendingRooms).toEqual([]);

    socket.joinAcks.push({ ok: true, eventId: "event-1" });
    await expect(service.joinEventRoom("event-1")).resolves.toBeUndefined();
    expect(service.connectionStatus.joinedRooms).toEqual(["event-1"]);
    expect(SocketRoomJoinError).toBeDefined();
  });

  it("keeps a room pending until the server acknowledges it", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");
    socket.deferJoinAcks = true;

    const join = service.joinEventRoom("event-1");
    expect(service.connectionStatus.joinedRooms).toEqual([]);
    expect(service.connectionStatus.pendingRooms).toEqual(["event-1"]);

    socket.respondToNextJoin();
    await join;
    expect(service.connectionStatus.joinedRooms).toEqual(["event-1"]);
    expect(service.connectionStatus.pendingRooms).toEqual([]);
  });

  it("compensates when the final subscriber leaves before a successful ack", async () => {
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");
    socket.deferJoinAcks = true;

    const join = service.joinEventRoom("event-1");
    service.leaveEventRoom("event-1");
    socket.respondToNextJoin();

    await expect(join).resolves.toBeUndefined();
    expect(socket.emittedCount("leave_event_room")).toBe(1);
    expect(service.connectionStatus.joinedRooms).toEqual([]);
    expect(service.connectionStatus.pendingRooms).toEqual([]);
  });

  it("compensates for a successful ack that arrives after the join timeout", async () => {
    vi.useFakeTimers();
    const service = new SocketServiceFrontend();
    service.connect("token", "https://socket.test");
    const socket = fakeIo.sockets[0];
    socket.serverEmit("connect");
    socket.deferJoinAcks = true;

    const join = service.joinEventRoom("event-1");
    const rejectedJoin = expect(join).rejects.toMatchObject({
      name: "SocketRoomJoinError",
      code: "AUTHORIZATION_FAILED",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejectedJoin;

    socket.respondToNextJoin();
    expect(socket.emittedCount("leave_event_room")).toBe(1);
    expect(service.connectionStatus.joinedRooms).toEqual([]);
    expect(service.connectionStatus.pendingRooms).toEqual([]);
  });

  it("reattaches subscribers when authentication replaces the socket", () => {
    const service = new SocketServiceFrontend();
    const handler = vi.fn();
    service.on("user_update", handler);

    service.connect("first-token", "https://socket.test");
    const firstSocket = fakeIo.sockets[0];
    service.connect("second-token", "https://socket.test");
    const secondSocket = fakeIo.sockets[1];

    firstSocket.serverEmit("user_update", { userId: "old" });
    secondSocket.serverEmit("user_update", { userId: "current" });

    expect(firstSocket.disconnectCalls).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ userId: "current" });
  });
});
