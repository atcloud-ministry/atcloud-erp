import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks shared across tests
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockInitialize = vi.fn();
const mockSocketShutdown = vi.fn().mockResolvedValue(undefined);
const mockHttpEventHandlers = new Map<string, (...args: any[]) => void>();
const mockListen = vi.fn((...args: any[]) => {
  const cb = typeof args[0] === "function" ? args[0] : args[1];
  if (cb) cb();
});
const mockOnce = vi.fn((event: string, handler: (...args: any[]) => void) => {
  mockHttpEventHandlers.set(event, handler);
});
const mockOff = vi.fn((event: string, handler: (...args: any[]) => void) => {
  if (mockHttpEventHandlers.get(event) === handler) {
    mockHttpEventHandlers.delete(event);
  }
});
const mockClose = vi.fn((callback?: (error?: Error) => void) => callback?.());
const mockCloseIdleConnections = vi.fn();
const mockCloseAllConnections = vi.fn();
const mockCreateServer = vi.fn(() => ({
  listen: mockListen,
  close: mockClose,
  closeIdleConnections: mockCloseIdleConnections,
  closeAllConnections: mockCloseAllConnections,
  once: mockOnce,
  off: mockOff,
  listening: true,
}));
const mockReliabilityInitialize = vi.fn().mockResolvedValue(undefined);
const mockReliabilityStart = vi.fn();
const mockReliabilityStop = vi.fn().mockResolvedValue(undefined);
const mockReliabilityStatus = vi.fn(() => ({
  notificationOutbox: { workerStarted: false },
}));
const mockMongoClose = vi.fn().mockResolvedValue(void 0);

// Mock modules before importing index.ts
vi.mock("fs", () => ({
  default: {
    existsSync: () => true,
    mkdirSync: () => void 0,
  },
}));

vi.mock("path", async (orig) => {
  // pass-through for path; not critical in this test
  const m = await (orig as any)();
  return { ...m };
});

vi.mock("http", () => ({ createServer: mockCreateServer }));

// Mock app and related modules (correct relative paths)
vi.mock("../../../src/app", () => ({ default: {} as any }));

vi.mock("../../../src/config/swagger", () => ({ setupSwagger: vi.fn() }));

vi.mock("../../../src/models", () => ({
  SystemConfig: { initializeDefaults: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../src/services/LockService", () => ({
  lockService: { constructor: { name: "TestLockService" } },
}));

vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    initialize: mockInitialize,
    shutdown: mockSocketShutdown,
  },
}));

vi.mock(
  "../../../src/services/reliability/ReliabilityFoundationService",
  () => ({
    reliabilityFoundationService: {
      initialize: mockReliabilityInitialize,
      start: mockReliabilityStart,
      stop: mockReliabilityStop,
      getStatusSnapshot: mockReliabilityStatus,
    },
  }),
);

// Partially mock mongoose: preserve Schema and other exports, override connect/connection only
vi.mock("mongoose", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      connect: vi.fn().mockResolvedValue(void 0),
      connection: {
        db: {
          admin: () => ({
            serverStatus: vi.fn().mockResolvedValue({ version: "6.0" }),
          }),
        },
        close: mockMongoClose,
        // readyState used by some helpers
        readyState: 1,
        on: vi.fn(),
      },
    },
    connection: {
      db: {
        admin: () => ({
          serverStatus: vi.fn().mockResolvedValue({ version: "6.0" }),
        }),
      },
      close: mockMongoClose,
      readyState: 1,
      on: vi.fn(),
    },
  };
});

vi.mock("../../../src/services/EventReminderScheduler", () => ({
  default: class {
    static getInstance() {
      return { start: mockStart, stop: mockStop } as any;
    }
  },
}));

vi.mock("../../../src/services/MaintenanceScheduler", () => ({
  default: class {
    static getInstance() {
      return { start: vi.fn(), stop: vi.fn() } as any;
    }
  },
}));

describe("Server bootstrap scheduler guard (Option A)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHttpEventHandlers.clear();
    // Ensure production so default dev-enabling does not apply
    process.env.NODE_ENV = "production";
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.NOTIFICATION_OUTBOX_ENABLED;
    process.env.JWT_ACCESS_SECRET =
      "scheduler-test-access-secret-at-least-thirty-two-characters";
    process.env.JWT_REFRESH_SECRET =
      "scheduler-test-refresh-secret-at-least-thirty-two-characters";
  });

  it("does not start scheduler when SCHEDULER_ENABLED is not true", async () => {
    await import("../../../src/index");

    // Wait for async operations to complete
    await vi.waitFor(
      () => {
        expect(mockCreateServer).toHaveBeenCalled();
        expect(mockListen).toHaveBeenCalled();
      },
      { timeout: 1000 }
    );

    // Critical assertion: scheduler start was NOT called
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockReliabilityInitialize).toHaveBeenCalledOnce();
    expect(mockReliabilityStart).toHaveBeenCalledOnce();
  });

  it("starts scheduler when explicitly enabled in production", async () => {
    process.env.SCHEDULER_ENABLED = "true";

    await import("../../../src/index");

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("fails closed before Socket.IO or HTTP starts when reliability initialization fails", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mockReliabilityInitialize.mockRejectedValueOnce(
      new Error("transaction topology unsupported"),
    );

    await import("../../../src/index");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), {
      timeout: 1000,
    });
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockReliabilityStart).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("does not start workers and cleans up when the HTTP listener fails", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    mockListen.mockImplementationOnce(() => {
      mockHttpEventHandlers.get("error")?.(
        Object.assign(new Error("address unavailable"), {
          code: "EADDRINUSE",
        }),
      );
    });

    await import("../../../src/index");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), {
      timeout: 1000,
    });
    expect(mockReliabilityInitialize).toHaveBeenCalledOnce();
    expect(mockInitialize).toHaveBeenCalledOnce();
    expect(mockReliabilityStart).not.toHaveBeenCalled();
    expect(mockSocketShutdown).toHaveBeenCalledOnce();
    expect(mockReliabilityStop).toHaveBeenCalledOnce();
    expect(mockMongoClose).toHaveBeenCalledOnce();
    exit.mockRestore();
  });

  it("drains HTTP producers before stopping the outbox worker and MongoDB", async () => {
    const priorHandlers = new Set(process.listeners("SIGTERM"));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await import("../../../src/index");
    await vi.waitFor(() => expect(mockListen).toHaveBeenCalled(), {
      timeout: 1000,
    });

    const shutdownHandler = process
      .listeners("SIGTERM")
      .find((handler) => !priorHandlers.has(handler));
    expect(shutdownHandler).toBeDefined();
    await (shutdownHandler as () => Promise<void>)();

    expect(mockClose).toHaveBeenCalledOnce();
    expect(mockCloseIdleConnections).toHaveBeenCalledOnce();
    expect(mockCloseAllConnections).not.toHaveBeenCalled();
    expect(mockSocketShutdown).toHaveBeenCalledOnce();
    expect(mockReliabilityStop).toHaveBeenCalledOnce();
    expect(mockMongoClose).toHaveBeenCalledOnce();
    expect(mockClose.mock.invocationCallOrder[0]).toBeLessThan(
      mockReliabilityStop.mock.invocationCallOrder[0],
    );
    expect(mockReliabilityStop.mock.invocationCallOrder[0]).toBeLessThan(
      mockMongoClose.mock.invocationCallOrder[0],
    );
    expect(exit).toHaveBeenCalledWith(0);

    process.removeListener("SIGTERM", shutdownHandler!);
    exit.mockRestore();
  });
});
