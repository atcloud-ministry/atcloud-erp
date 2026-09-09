import { beforeEach, describe, expect, it, vi } from "vitest";
import { socketService } from "../../../../src/services/infrastructure/SocketService";

describe("SocketService shutdown", () => {
  beforeEach(() => {
    (socketService as any).io = null;
    (socketService as any).authenticatedSockets = new Map();
    (socketService as any).userSockets = new Map();
    (socketService as any).userAuthorizationRevisions = new Map();
    (socketService as any).resourceAuthorizationRevisions = new Map();
    (socketService as any).eventJoinGuards = new Map();
  });

  it("closes Socket.IO and clears in-memory authorization state", async () => {
    const close = vi.fn((callback: () => void) => callback());
    (socketService as any).io = { close };
    (socketService as any).authenticatedSockets.set("socket-1", {});
    (socketService as any).userSockets.set("user-1", new Set(["socket-1"]));
    (socketService as any).userAuthorizationRevisions.set("user-1", 2);
    (socketService as any).resourceAuthorizationRevisions.set("program:1", 3);
    (socketService as any).eventJoinGuards.set("socket-1", {});

    await socketService.shutdown();

    expect(close).toHaveBeenCalledOnce();
    expect((socketService as any).io).toBeNull();
    expect((socketService as any).authenticatedSockets.size).toBe(0);
    expect((socketService as any).userSockets.size).toBe(0);
    expect((socketService as any).userAuthorizationRevisions.size).toBe(0);
    expect((socketService as any).resourceAuthorizationRevisions.size).toBe(0);
    expect((socketService as any).eventJoinGuards.size).toBe(0);
  });

  it("is idempotent before initialization and after shutdown", async () => {
    await expect(socketService.shutdown()).resolves.toBeUndefined();
    await expect(socketService.shutdown()).resolves.toBeUndefined();
  });

  it("rejects an invalid shutdown timeout", async () => {
    await expect(socketService.shutdown(0)).rejects.toThrow(
      "Socket shutdown timeout is invalid",
    );
  });
});
