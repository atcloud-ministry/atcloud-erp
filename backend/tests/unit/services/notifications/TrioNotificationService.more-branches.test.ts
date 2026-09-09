import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TrioNotificationService } from "../../../../src/services/notifications/TrioNotificationService";
import { UnifiedMessageController } from "../../../../src/controllers/unifiedMessageController";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { EventEmailService } from "../../../../src/services/email/domains/EventEmailService";
import { RoleEmailService } from "../../../../src/services/email/domains/RoleEmailService";
import { NotificationErrorHandler } from "../../../../src/services/notifications/NotificationErrorHandler";
import { TrioTransaction } from "../../../../src/services/notifications/TrioTransaction";
import { NOTIFICATION_CONFIG } from "../../../../src/config/notificationConfig";

vi.mock("../../../../src/controllers/unifiedMessageController");
vi.mock("../../../../src/services/infrastructure/SocketService");
vi.mock("../../../../src/services/notifications/NotificationErrorHandler");

function createMockMessage(id: string, recipientIds: string[]) {
  return {
    _id: { toString: () => id },
    title: "T",
    content: "C",
    type: "announcement",
    priority: "medium",
    createdAt: new Date("2026-09-09T12:00:00.000Z"),
    creator: {
      id: "system",
      firstName: "System",
      lastName: "Administrator",
      username: "system",
      gender: "male",
      authLevel: "Super Admin",
    },
    hideCreator: false,
    userStates: new Map(recipientIds.map((userId) => [userId, {}])),
    toJSON: vi.fn(() => {
      throw new Error("raw document serialization must not be used for realtime");
    }),
    save: vi.fn().mockResolvedValue(undefined),
    isActive: true,
  };
}

describe("TrioNotificationService - more branches", () => {
  beforeEach(() => {
    TrioNotificationService.resetMetrics();
    vi.clearAllMocks();

    // Set up spies for EventEmailService methods
    vi.spyOn(EventEmailService, "sendEventCreatedEmail").mockResolvedValue(
      true
    );
    // Co-organizer assignment is routed via RoleEmailService in the facade
    vi.spyOn(
      RoleEmailService,
      "sendCoOrganizerAssignedEmail"
    ).mockResolvedValue(true);
    vi.spyOn(EventEmailService, "sendEventReminderEmail").mockResolvedValue(
      true
    );

    // Set up spy for RoleEmailService method
    vi.spyOn(RoleEmailService, "sendNewLeaderSignupEmail").mockResolvedValue(
      true
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("websocket fails for all recipients -> throws and rolls back message (marks inactive)", async () => {
    vi.useFakeTimers();

    const mockMessage = createMockMessage("m1", ["u1", "u2"]) as any;

    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);
    // Make every websocket emission fail (emitWithRetry will retry and then fail)
    vi.mocked(socketService.emitSystemMessageUpdate).mockImplementation(() => {
      throw new Error("ws down");
    });
    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    const req = {
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1", "u2"],
      options: { enableRollback: true },
    };

    const promise = TrioNotificationService.createTrio(req as any);
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("All WebSocket emissions failed");
    expect(res.rollbackCompleted).toBe(true);
    // Message rollback executed
    expect(mockMessage.isActive).toBe(false);
    expect(mockMessage.save).toHaveBeenCalled();
  });

  it("websocket fails for all recipients but rollback disabled -> no rollback executed", async () => {
    vi.useFakeTimers();

    const mockMessage = createMockMessage("m2", ["u1"]) as any;

    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);
    vi.mocked(socketService.emitSystemMessageUpdate).mockImplementation(() => {
      throw new Error("ws down");
    });
    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    const req = {
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
      options: { enableRollback: false },
    };

    const promise = TrioNotificationService.createTrio(req as any);
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.success).toBe(false);
    expect(res.rollbackCompleted).toBe(false);
    // No rollback should have occurred
    expect(mockMessage.isActive).toBe(true);
    expect(mockMessage.save).not.toHaveBeenCalled();
  });

  it("unknown email template -> retries and fails before message creation", async () => {
    vi.useFakeTimers();

    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    const req = {
      email: {
        to: "x@example.com",
        template: "unknown-template" as any,
        data: {},
      },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    };

    const promise = TrioNotificationService.createTrio(req as any);
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Email failed after");
    // Message creation should not be attempted
    expect(
      UnifiedMessageController.createTargetedSystemMessage
    ).not.toHaveBeenCalled();
  });

  it("maps remaining templates to correct EmailService methods", async () => {
    const mockMessage = createMockMessage("m3", ["u1"]) as any;
    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);
    vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
      undefined
    );

    // Stub email methods to succeed
    vi.mocked(EventEmailService.sendEventCreatedEmail).mockResolvedValue(
      true as any
    );
    vi.mocked(RoleEmailService.sendCoOrganizerAssignedEmail).mockResolvedValue(
      true as any
    );
    vi.mocked(RoleEmailService.sendNewLeaderSignupEmail).mockResolvedValue(
      true as any
    );

    // event-created
    await TrioNotificationService.createTrio({
      email: {
        to: "a@x.com",
        template: "event-created",
        data: { userName: "U", event: { id: 1 } },
      },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);
    expect(EventEmailService.sendEventCreatedEmail).toHaveBeenCalledWith(
      "a@x.com",
      "U",
      { id: 1 }
    );

    // co-organizer-assigned
    await TrioNotificationService.createTrio({
      email: {
        to: "b@x.com",
        template: "co-organizer-assigned",
        data: {
          assignedUser: { id: "u2" },
          event: { id: 2 },
          assignedBy: { id: "admin" },
        },
      },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);
    expect(RoleEmailService.sendCoOrganizerAssignedEmail).toHaveBeenCalledWith(
      "b@x.com",
      { id: "u2" },
      { id: 2 },
      { id: "admin" }
    );

    // new-leader-signup
    await TrioNotificationService.createTrio({
      email: {
        template: "new-leader-signup",
        data: {
          newUser: { id: "new" },
          adminEmail: "admin@x.com",
          adminUsers: [{ id: "a1" }],
        },
      },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);
    expect(RoleEmailService.sendNewLeaderSignupEmail).toHaveBeenCalledWith(
      { id: "new" },
      "admin@x.com",
      [{ id: "a1" }]
    );
  });

  it("handles rollback failure (catch path) when transaction.rollback throws", async () => {
    vi.useFakeTimers();

    const mockMessage = createMockMessage("m4", ["u1"]) as any;

    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);

    // Force websocket emission to fail so createTrio enters the catch block
    vi.mocked(socketService.emitSystemMessageUpdate).mockImplementation(() => {
      throw new Error("ws down hard");
    });

    // Force rollback itself to fail to hit the catch branch inside createTrio
    const rollbackSpy = vi
      .spyOn(TrioTransaction.prototype as any, "rollback")
      .mockRejectedValue(new Error("rollback boom"));

    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    const req = {
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
      // leave enableRollback undefined so it's enabled by default
    };

    const promise = TrioNotificationService.createTrio(req as any);
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.success).toBe(false);
    // Because rollback threw, rollbackCompleted should remain false
    expect(res.rollbackCompleted).toBe(false);
    expect(rollbackSpy).toHaveBeenCalled();
  });

  it("non-Error thrown value hits String(error) branch and records TypeError", async () => {
    vi.useFakeTimers();
    // Ensure a clean metrics baseline for this test (guard against any stray async effects)
    TrioNotificationService.resetMetrics();

    const mockMessage = createMockMessage("m5", ["u1"]) as any;

    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);

    // Throw a non-Error object with null prototype, so constructor.name is undefined
    const weirdError = Object.create(null);
    vi.mocked(socketService.emitSystemMessageUpdate).mockImplementation(() => {
      throw weirdError;
    });

    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    // Snapshot the primitive TypeError count to avoid shallow-copy aliasing of errorsByType
    const beforeTypeError =
      (TrioNotificationService.getMetrics().errorsByType as any).TypeError || 0;

    const promise = TrioNotificationService.createTrio({
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
      options: { enableRollback: false },
    } as any);
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.success).toBe(false);
    // Robustly assert that the error was stringified (content may vary by runtime path)
    const errStr = String(res.error);
    expect(typeof errStr).toBe("string");
    expect(errStr.length).toBeGreaterThan(0);

    const afterTypeError =
      (TrioNotificationService.getMetrics().errorsByType as any).TypeError || 0;
    // The thrown non-Error triggers a TypeError during string coercion in emitWebSocketEvents
    expect(afterTypeError).toBe(beforeTypeError + 1);
  });

  it("sendEmailWithTimeout early return when emailRequest is falsy", async () => {
    // Call private method via any-cast to exercise early return branch
    const tx = new TrioTransaction();
    // @ts-ignore access private for test
    const result = await (TrioNotificationService as any).sendEmailWithTimeout(
      null,
      tx
    );
    expect(result).toBeNull();
  });

  it("event-reminder defaults reminderType and timeUntilEvent when missing", async () => {
    const mockMessage = createMockMessage("m6", ["u1"]) as any;
    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);
    vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
      undefined
    );

    const sendReminderSpy = vi
      .mocked(EventEmailService.sendEventReminderEmail)
      .mockResolvedValue(true as any);

    await TrioNotificationService.createTrio({
      email: {
        to: "u@example.com",
        template: "event-reminder",
        data: {
          event: { id: "e1", title: "E" },
          user: { id: "u1" },
          // no reminderType, no timeUntilEvent -> exercise defaults
        },
      },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);

    expect(sendReminderSpy).toHaveBeenCalledWith(
      { id: "e1", title: "E" },
      { id: "u1" },
      "upcoming",
      "24 hours"
    );
  });

  it("sendEmailWithTimeout uses production backoff base delay when NODE_ENV != test", async () => {
    // Force production-like branch for backoff calculation
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.useFakeTimers();
    const st = vi.spyOn(global, "setTimeout");

    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    const promise = TrioNotificationService.createTrio({
      email: {
        to: "x@example.com",
        template: "unknown-template" as any,
        data: {},
      },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);

    // Flush timers so the internal backoff waits complete deterministically
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.success).toBe(false);

    // Expect backoff delays used 2000ms and 4000ms (2^1*1000, 2^2*1000)
    const delays = st.mock.calls.map((c) => c[1]);
    expect(delays).toContain(2000);
    expect(delays).toContain(4000);

    st.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("emitWithRetry backs off and succeeds before exhausting retries", async () => {
    vi.useFakeTimers();

    const message = createMockMessage("m", ["u1"]) as any;

    // Make first two emit attempts throw, third succeed
    let call = 0;
    vi.mocked(socketService.emitSystemMessageUpdate).mockImplementation(() => {
      call += 1;
      if (call < 3) throw new Error("ws fail");
      // third call succeeds (no-op)
    });

    // Call private method via any-cast
    const p: Promise<void> = (TrioNotificationService as any).emitWithRetry(
      "u1",
      message
    );

    // Advance timers to satisfy backoff waits: 500ms (after attempt 1) then 1000ms (after attempt 2)
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(p).resolves.toBeUndefined();
    expect(call).toBe(3);
  });

  it("recordError falls back to UnknownError when constructor.name is missing", () => {
    TrioNotificationService.resetMetrics();
    const beforeUnknown =
      (TrioNotificationService.getMetrics().errorsByType as any).UnknownError ||
      0;

    // Provide an object whose constructor exists but with an undefined name
    // so error.constructor.name is falsy and falls back to "UnknownError"
    const obj: any = {};
    obj.constructor = { name: undefined };
    // @ts-ignore access private method for coverage
    (TrioNotificationService as any).recordError(obj);

    const afterUnknown =
      (TrioNotificationService.getMetrics().errorsByType as any).UnknownError ||
      0;
    expect(afterUnknown).toBe(beforeUnknown + 1);
  });

  it("createTrio catch stringifies non-Error when internal step rejects with a string", async () => {
    vi.useFakeTimers();

    // Spy on private email step to force a non-Error rejection
    const emailSpy = vi
      // @ts-ignore accessing private for test
      .spyOn(TrioNotificationService as any, "sendEmailWithTimeout")
      .mockRejectedValue("oops" as any);

    vi.mocked(NotificationErrorHandler.handleTrioFailure).mockResolvedValue({
      success: false,
    } as any);

    const res = await TrioNotificationService.createTrio({
      email: { to: "x@example.com", template: "welcome", data: { name: "X" } },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);

    await vi.runAllTimersAsync();

    expect(res.success).toBe(false);
    expect(res.error).toBe("oops");

    emailSpy.mockRestore();
  });

  it("sendEmailWithTimeout handles timeout branch (race) then succeeds on retry", async () => {
    vi.useFakeTimers();

    // Speed up email timeout for this test
    const originalTimeout = NOTIFICATION_CONFIG.timeouts.email;
    NOTIFICATION_CONFIG.timeouts.email = 1000;

    // First call hangs (never resolves), second call succeeds
    let call = 0;
    const execSpy = vi
      // @ts-ignore access private method for test
      .spyOn(TrioNotificationService as any, "executeEmailSend")
      .mockImplementation(() => {
        call += 1;
        if (call === 1) {
          return new Promise(() => {}); // never resolves -> triggers timeout path
        }
        return Promise.resolve({ id: "em1" });
      });

    // Ensure message + websocket steps are smooth
    const mockMessage = createMockMessage("m-timeout", ["u1"]) as any;
    vi.mocked(
      UnifiedMessageController.createTargetedSystemMessage
    ).mockResolvedValue(mockMessage);
    vi.mocked(socketService.emitSystemMessageUpdate).mockResolvedValue(
      undefined
    );

    const promise = TrioNotificationService.createTrio({
      email: { to: "x@example.com", template: "welcome", data: { name: "X" } },
      systemMessage: { title: "T", content: "C" },
      recipients: ["u1"],
    } as any);

    // Advance to trigger timeout (1000ms) and then the backoff wait (200ms for attempt 1)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(200);

    const res = await promise;

    expect(res.success).toBe(true);
    expect(res.emailId).toBe("em1");
    expect(call).toBeGreaterThanOrEqual(2);

    execSpy.mockRestore();
    NOTIFICATION_CONFIG.timeouts.email = originalTimeout;
  });

  it("executeEmailSend early return when emailRequest is falsy", async () => {
    // Call private method via any-cast to exercise early return branch in executeEmailSend
    // @ts-ignore access private for test
    const res = await (TrioNotificationService as any).executeEmailSend(null);
    expect(res).toBeNull();
  });
});
