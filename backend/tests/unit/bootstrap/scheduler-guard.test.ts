import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks shared across tests
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockInitialize = vi.fn();
const mockListen = vi.fn((...args: any[]) => {
  const cb = typeof args[0] === "function" ? args[0] : args[1];
  if (cb) cb();
});
const mockCreateServer = vi.fn(() => ({ listen: mockListen }));

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
  socketService: { initialize: mockInitialize },
}));

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
        close: vi.fn().mockResolvedValue(void 0),
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
      close: vi.fn().mockResolvedValue(void 0),
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
    // Ensure production so default dev-enabling does not apply
    process.env.NODE_ENV = "production";
    delete process.env.SCHEDULER_ENABLED;
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
  });

  it("starts scheduler when explicitly enabled in production", async () => {
    process.env.SCHEDULER_ENABLED = "true";

    await import("../../../src/index");

    await vi.waitFor(() => expect(mockListen).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });
});
