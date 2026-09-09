import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EventReminderScheduler from "../../../src/services/EventReminderScheduler";
import { workerAuthorizationService } from "../../../src/services/authorization/WorkerAuthorizationService";

const dispatchMocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock("../../../src/models", () => ({
  Event: { find: vi.fn() },
}));

vi.mock(
  "../../../src/services/notifications/EventReminderDispatchService",
  () => ({
    eventReminderDispatchService: { dispatch: dispatchMocks.dispatch },
  }),
);

describe("EventReminderScheduler dispatch boundary", () => {
  const originalEnvironment = { ...process.env };
  const fetchSpy = vi.fn();
  let scheduler: EventReminderScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnvironment,
      NODE_ENV: "test",
      SCHEDULER_TEST_FORCE: "true",
    };
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    scheduler = EventReminderScheduler.getInstance();
    const schedulerInternals = scheduler as unknown as {
      getEventsNeedingReminders: () => Promise<unknown[]>;
    };
    vi.spyOn(schedulerInternals, "getEventsNeedingReminders").mockResolvedValue([
      {
        _id: "event-123",
        title: "Direct Dispatch Event",
        date: "2099-01-01",
        time: "10:00",
        location: "Room A",
        format: "in-person",
      },
    ]);
    dispatchMocks.dispatch.mockResolvedValue({ message: "sent" });
  });

  afterEach(() => {
    scheduler.stop();
    process.env = { ...originalEnvironment };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses an authorized manual worker context and never self-calls HTTP", async () => {
    const contextSpy = vi.spyOn(workerAuthorizationService, "createRunContext");

    await scheduler.triggerManualCheck("admin-user-id");

    expect(contextSpy).toHaveBeenCalledWith(
      "event-reminder",
      "manual",
      "admin-user-id",
    );
    expect(dispatchMocks.dispatch).toHaveBeenCalledWith({
      eventId: "event-123",
      eventData: {
        title: "Direct Dispatch Event",
        date: "2099-01-01",
        time: "10:00",
        location: "Room A",
        zoomLink: undefined,
        format: "in-person",
      },
      reminderType: "24h",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
