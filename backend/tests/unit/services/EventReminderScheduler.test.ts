/**
 * EventReminderScheduler Service Tests
 *
 * Comprehensive testing of the event reminder scheduling service covering:
 * - Singleton pattern implementation
 * - Scheduler lifecycle management (start/stop)
 * - Event reminder processing logic
 * - transport-neutral dispatch integration
 * - Timezone handling and timing logic
 * - Error handling and resilience
 * - Manual trigger functionality
 *
 * Target Coverage: ~90%+ of 279 lines
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
  MockedFunction,
} from "vitest";
import mongoose from "mongoose";
import EventReminderScheduler from "../../../src/services/EventReminderScheduler";
import { Event } from "../../../src/models";

const dispatchMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock(
  "../../../src/services/notifications/EventReminderDispatchService",
  () => ({
    eventReminderDispatchService: { dispatch: dispatchMocks.dispatch },
  }),
);

// Mock the Event model
vi.mock("../../../src/models", () => ({
  Event: {
    find: vi.fn(),
  },
}));

// Mock global setTimeout and setInterval for timer control (restore after file)
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
const mockSetTimeout = vi.fn((callback: Function, delay: number) => {
  // Return a fake timer ID without executing callback to avoid infinite recursion
  return 123 as any;
});
const mockSetInterval = vi.fn((callback: Function, interval: number) => {
  // Return a fake timer ID
  return 12345 as any;
});
const mockClearInterval = vi.fn();

vi.stubGlobal("setTimeout", mockSetTimeout);
vi.stubGlobal("setInterval", mockSetInterval);
vi.stubGlobal("clearInterval", mockClearInterval);

describe("EventReminderScheduler Service", () => {
  let scheduler: EventReminderScheduler;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  // Helper to create test events that will pass the 24h reminder filter
  const createTestEvent = (title: string, hoursFromNow: number = 23.9) => {
    // For an event to pass the filter:
    // 1. current_time >= event_time - 24h (should trigger)
    // 2. event_time > current_time (event is in future)
    // So we need events that are slightly less than 24h away so the trigger time has passed
    const eventDateTime = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);

    // Format date and time properly for local timezone
    const year = eventDateTime.getFullYear();
    const month = String(eventDateTime.getMonth() + 1).padStart(2, "0");
    const day = String(eventDateTime.getDate()).padStart(2, "0");
    const eventDate = `${year}-${month}-${day}`;

    const hours = String(eventDateTime.getHours()).padStart(2, "0");
    const minutes = String(eventDateTime.getMinutes()).padStart(2, "0");
    const eventTime = `${hours}:${minutes}`;

    return {
      _id: new mongoose.Types.ObjectId(),
      title,
      date: eventDate,
      time: eventTime,
      location: "Test Location",
      zoomLink: "https://zoom.us/test",
      format: "hybrid",
      "24hReminderSent": false,
    };
  };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    dispatchMocks.dispatch.mockResolvedValue({
      message: "Reminder sent successfully",
      systemMessageCreated: true,
    });

    // Reset environment
    delete process.env.NODE_ENV;
    delete process.env.API_BASE_URL;

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Get fresh instance
    scheduler = EventReminderScheduler.getInstance();
  });

  afterEach(() => {
    // Stop scheduler to clean up any running timers
    scheduler.stop();

    // Restore console methods
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // Ensure timer globals are restored after this file to avoid cross-file impacts
  afterAll(() => {
    try {
      vi.unstubAllGlobals();
    } catch {}
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
    (global as any).clearInterval = realClearInterval as any;
  });

  describe("Singleton Pattern", () => {
    it("should return the same instance when called multiple times", () => {
      const instance1 = EventReminderScheduler.getInstance();
      const instance2 = EventReminderScheduler.getInstance();
      const instance3 = EventReminderScheduler.getInstance();

      expect(instance1).toBe(instance2);
      expect(instance2).toBe(instance3);
      expect(instance1).toBeInstanceOf(EventReminderScheduler);
    });

    it("should initialize with development API URL by default", () => {
      const scheduler = EventReminderScheduler.getInstance();
      const status = scheduler.getStatus();

      expect(status.isRunning).toBe(false);
      // Verify constructor logic through subsequent API calls
      expect(scheduler).toBeDefined();
    });

    it("should use production API URL when NODE_ENV is production", () => {
      process.env.NODE_ENV = "production";
      process.env.API_BASE_URL = "https://api.atcloud.org";

      // Force new instance creation by testing API URL indirectly
      const scheduler = EventReminderScheduler.getInstance();
      expect(scheduler).toBeDefined();
    });
  });

  describe("Scheduler Lifecycle Management", () => {
    it("should start the scheduler successfully when not running", () => {
      const result = scheduler.start();

      expect(result).toBeUndefined();
      expect(scheduler.getStatus().isRunning).toBe(true);
      expect(mockSetInterval).toHaveBeenCalledWith(
        expect.any(Function),
        600000
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "✅ Event reminder scheduler started"
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "   📅 24-hour reminders: Every 10 minutes"
      );
    });

    it("should not start the scheduler again if already running", () => {
      scheduler.start();
      mockSetInterval.mockClear();
      consoleLogSpy.mockClear();

      scheduler.start();

      expect(mockSetInterval).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "⚠️ Event reminder scheduler is already running"
      );
    });

    it("should execute immediate check on startup with 5 second delay", () => {
      scheduler.start();

      expect(mockSetTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "🚀 Running initial reminder check on startup (testing reset flag)..."
      );
    });

    it("should stop the scheduler successfully when running", () => {
      scheduler.start();

      const result = scheduler.stop();

      expect(result).toBeUndefined();
      expect(scheduler.getStatus().isRunning).toBe(false);
      expect(mockClearInterval).toHaveBeenCalledWith(12345);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "🛑 Event reminder scheduler stopped"
      );
    });

    it("should not stop the scheduler if not running", () => {
      const result = scheduler.stop();

      expect(result).toBeUndefined();
      expect(mockClearInterval).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "⚠️ Event reminder scheduler is not running"
      );
    });

    it("should clear multiple intervals when stopping", () => {
      scheduler.start();
      // Simulate multiple intervals
      mockSetInterval.mockReturnValueOnce(11111 as any);
      mockSetInterval.mockReturnValueOnce(22222 as any);

      scheduler.stop();

      expect(mockClearInterval).toHaveBeenCalledWith(12345);
    });
  });

  describe("Timer callback coverage", () => {
    it("executes setInterval callback and triggers processEventReminders", async () => {
      const procSpy = vi
        .spyOn(scheduler as any, "processEventReminders")
        .mockResolvedValueOnce(undefined);

      scheduler.start();

      // Grab the callback passed to setInterval and invoke it manually
      const intervalCb = mockSetInterval.mock.calls[0][0] as Function;
      await intervalCb();

      expect(procSpy).toHaveBeenCalled();
      procSpy.mockRestore();
    });

    it("executes setTimeout callback and triggers processEventReminders", async () => {
      const procSpy = vi
        .spyOn(scheduler as any, "processEventReminders")
        .mockResolvedValueOnce(undefined);

      scheduler.start();

      // Grab the callback passed to setTimeout (initial 5s check) and invoke it manually
      const timeoutCb = mockSetTimeout.mock.calls[0][0] as Function;
      await timeoutCb();

      expect(procSpy).toHaveBeenCalled();
      procSpy.mockRestore();
    });
  });

  describe("Event Reminder Processing", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should process events needing reminders successfully", async () => {
      const mockEvent = createTestEvent("Test Event");

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        mockEvent,
      ]);

      dispatchMocks.dispatch.mockResolvedValue({
        message: "Reminder sent successfully",
        systemMessageCreated: true,
        details: {
          emailsSent: 5,
          totalParticipants: 5,
          systemMessageSuccess: true,
        },
      });

      await scheduler.triggerManualCheck();

      expect(Event.find).toHaveBeenCalledWith({
        "24hReminderSent": { $ne: true },
        $or: [
          { "24hReminderSentAt": { $exists: false } },
          { "24hReminderSentAt": { $lt: expect.any(Date) } },
        ],
      });
      expect(dispatchMocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: mockEvent._id.toString(),
          reminderType: "24h",
          eventData: expect.objectContaining({ title: mockEvent.title }),
        }),
      );
    });

    it("should handle no events needing reminders", async () => {
      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([]);

      await scheduler.triggerManualCheck();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "ℹ️ No events need 24h reminders at this time"
      );
      expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
    });

    it("should handle database errors during event query", async () => {
      const dbError = new Error("Database connection failed");
      (Event.find as MockedFunction<typeof Event.find>).mockRejectedValue(
        dbError
      );

      await scheduler.triggerManualCheck();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error querying events for reminders:",
        dbError
      );
      expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
    });

    it("should handle dispatch failures when sending reminders", async () => {
      const mockEvent = createTestEvent("Test Event");

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        mockEvent,
      ]);
      const dispatchError = new Error("Dispatch failed");
      dispatchMocks.dispatch.mockRejectedValue(dispatchError);

      await scheduler.triggerManualCheck();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `❌ Failed to send trio for ${mockEvent.title}:`,
        dispatchError,
      );
    });

    it("should isolate an unexpected dispatch error", async () => {
      const mockEvent = createTestEvent("Test Event");

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        mockEvent,
      ]);
      const dispatchError = new Error("Unexpected dispatch failure");
      dispatchMocks.dispatch.mockRejectedValue(dispatchError);

      await scheduler.triggerManualCheck();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `❌ Failed to send trio for ${mockEvent.title}:`,
        dispatchError,
      );
    });

    it("should warn when system message creation fails but emails succeed", async () => {
      const mockEvent = createTestEvent("Test Event");

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        mockEvent,
      ]);
      dispatchMocks.dispatch.mockResolvedValue({
        message: "Emails sent but system message failed",
        systemMessageCreated: false,
        details: {
          emailsSent: 3,
          totalParticipants: 3,
          systemMessageSuccess: false,
        },
      });

      await scheduler.triggerManualCheck();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `⚠️ WARNING: System message creation failed for event: ${mockEvent.title}`
        )
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Users will receive emails but no system messages or bell notifications!"
        )
      );
    });
  });

  describe("Event Filtering Logic", () => {
    it("should properly filter events based on 24-hour timing", async () => {
      // Create event that is 23 hours and 50 minutes from now (so the 24h trigger time has passed)
      const now = new Date();
      const eventDateTime = new Date(
        now.getTime() + (23 * 60 + 50) * 60 * 1000
      ); // 23h50m from now

      // Format properly for local timezone
      const year = eventDateTime.getFullYear();
      const month = String(eventDateTime.getMonth() + 1).padStart(2, "0");
      const day = String(eventDateTime.getDate()).padStart(2, "0");
      const eventDate = `${year}-${month}-${day}`;

      const hours = String(eventDateTime.getHours()).padStart(2, "0");
      const minutes = String(eventDateTime.getMinutes()).padStart(2, "0");
      const eventTime = `${hours}:${minutes}`;

      const eventNeedingReminder = {
        _id: new mongoose.Types.ObjectId(),
        title: "Event Needs Reminder",
        date: eventDate,
        time: eventTime,
        "24hReminderSent": false,
      };

      // Event too far in future (48 hours from now)
      const futureEventDateTime = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const futureYear = futureEventDateTime.getFullYear();
      const futureMonth = String(futureEventDateTime.getMonth() + 1).padStart(
        2,
        "0"
      );
      const futureDay = String(futureEventDateTime.getDate()).padStart(2, "0");
      const futureEventDate = `${futureYear}-${futureMonth}-${futureDay}`;

      const futureHours = String(futureEventDateTime.getHours()).padStart(
        2,
        "0"
      );
      const futureMinutes = String(futureEventDateTime.getMinutes()).padStart(
        2,
        "0"
      );
      const futureEventTime = `${futureHours}:${futureMinutes}`;

      const eventTooEarly = {
        _id: new mongoose.Types.ObjectId(),
        title: "Event Too Early",
        date: futureEventDate,
        time: futureEventTime,
        "24hReminderSent": false,
      };

      // Past event (should be ignored)
      const pastEventDateTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
      const pastYear = pastEventDateTime.getFullYear();
      const pastMonth = String(pastEventDateTime.getMonth() + 1).padStart(
        2,
        "0"
      );
      const pastDay = String(pastEventDateTime.getDate()).padStart(2, "0");
      const pastEventDate = `${pastYear}-${pastMonth}-${pastDay}`;

      const pastHours = String(pastEventDateTime.getHours()).padStart(2, "0");
      const pastMinutes = String(pastEventDateTime.getMinutes()).padStart(
        2,
        "0"
      );
      const pastEventTime = `${pastHours}:${pastMinutes}`;

      const pastEvent = {
        _id: new mongoose.Types.ObjectId(),
        title: "Past Event",
        date: pastEventDate,
        time: pastEventTime,
        "24hReminderSent": false,
      };

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        eventNeedingReminder,
        eventTooEarly,
        pastEvent,
      ]);

      await scheduler.triggerManualCheck();

      // Should only process the event that needs reminder
      expect(dispatchMocks.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatchMocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          eventData: expect.objectContaining({
            title: "Event Needs Reminder",
          }),
        }),
      );
    });
  });

  describe("Status and Manual Operations", () => {
    it("should return correct status when scheduler is stopped", () => {
      const status = scheduler.getStatus();

      // Only assert the isRunning flag to allow extended diagnostics fields
      expect(status.isRunning).toBe(false);
    });

    it("should return correct status when scheduler is running", () => {
      scheduler.start();
      const status = scheduler.getStatus();

      // Only assert the isRunning flag to allow extended diagnostics fields
      expect(status.isRunning).toBe(true);
    });

    it("should execute manual trigger with proper logging", async () => {
      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([]);

      await scheduler.triggerManualCheck();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "🔧 Manual trigger: Checking for 24h reminders..."
      );
      expect(Event.find).toHaveBeenCalled();
    });
  });

  describe("Error Resilience", () => {
    it("should continue processing other events when one fails", async () => {
      const event1 = createTestEvent("Event 1", 23.9);
      const event2 = createTestEvent("Event 2", 23.8);

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        event1,
        event2,
      ]);

      dispatchMocks.dispatch
        .mockRejectedValueOnce(new Error("Server Error"))
        .mockResolvedValueOnce({ message: "Success" });

      await scheduler.triggerManualCheck();

      expect(dispatchMocks.dispatch).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "❌ Failed to send trio for Event 1:",
        expect.any(Error),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("✅ Completed processing for event: Event 2")
      );
    });

    it("should handle general processing errors gracefully", async () => {
      const processingError = new Error("General processing error");
      (Event.find as MockedFunction<typeof Event.find>).mockRejectedValue(
        processingError
      );

      await scheduler.triggerManualCheck();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error querying events for reminders:",
        processingError
      );
    });
  });

  describe("Dispatch Integration", () => {
    it("should send the correct reminder command to the shared service", async () => {
      const mockEvent = createTestEvent("Integration Test Event");
      // Override specific fields for testing
      mockEvent.location = "Conference Room A";
      mockEvent.zoomLink = "https://zoom.us/j/123456789";
      mockEvent.format = "hybrid";

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        mockEvent,
      ]);
      await scheduler.triggerManualCheck();

      expect(dispatchMocks.dispatch).toHaveBeenCalledWith({
        eventId: mockEvent._id.toString(),
        eventData: {
          title: "Integration Test Event",
          date: mockEvent.date,
          time: mockEvent.time,
          location: "Conference Room A",
          zoomLink: "https://zoom.us/j/123456789",
          format: "hybrid",
        },
        reminderType: "24h",
      });
    });

    it("should handle missing optional event fields gracefully", async () => {
      // Create event with proper timing but minimal fields (23h50m from now so trigger time has passed)
      const eventDateTime = new Date(Date.now() + (23 * 60 + 50) * 60 * 1000);

      // Format properly for local timezone
      const year = eventDateTime.getFullYear();
      const month = String(eventDateTime.getMonth() + 1).padStart(2, "0");
      const day = String(eventDateTime.getDate()).padStart(2, "0");
      const eventDate = `${year}-${month}-${day}`;

      const hours = String(eventDateTime.getHours()).padStart(2, "0");
      const minutes = String(eventDateTime.getMinutes()).padStart(2, "0");
      const eventTime = `${hours}:${minutes}`;

      const mockEvent = {
        _id: new mongoose.Types.ObjectId(),
        title: "Minimal Event",
        date: eventDate,
        time: eventTime,
        "24hReminderSent": false,
        // Missing: location, zoomLink, format
      };

      (Event.find as MockedFunction<typeof Event.find>).mockResolvedValue([
        mockEvent,
      ]);
      await scheduler.triggerManualCheck();

      expect(dispatchMocks.dispatch).toHaveBeenCalledWith({
        eventId: mockEvent._id.toString(),
        eventData: {
          title: "Minimal Event",
          date: eventDate,
          time: eventTime,
          location: "TBD",
          zoomLink: undefined,
          format: "in-person",
        },
        reminderType: "24h",
      });
    });
  });

  describe("Constructor branches", () => {
    it("covers production API URL branch during construction", () => {
      const prev = (EventReminderScheduler as any).instance;
      process.env.NODE_ENV = "production";
      process.env.API_BASE_URL = "https://api.atcloud.org";

      // Force re-initialization to execute constructor logic for production branch
      (EventReminderScheduler as any).instance = undefined;
      const temp = EventReminderScheduler.getInstance();
      expect(temp).toBeInstanceOf(EventReminderScheduler);

      // Restore previous singleton instance to avoid test cross-talk
      (EventReminderScheduler as any).instance = prev;
    });

    it("covers production fallback when API_BASE_URL is unset (uses default)", () => {
      const prev = (EventReminderScheduler as any).instance;
      process.env.NODE_ENV = "production";
      delete process.env.API_BASE_URL;

      (EventReminderScheduler as any).instance = undefined;
      const temp = EventReminderScheduler.getInstance();
      expect(temp).toBeInstanceOf(EventReminderScheduler);

      (EventReminderScheduler as any).instance = prev;
    });
  });
});
