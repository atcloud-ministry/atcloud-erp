/**
 * Event Reminder Scheduler Service
 *
 * This service checks for events that need 24-hour reminders
 * and triggers the existing event reminder trio for registered participants.
 *
 * Simplified to only handle 24-hour reminders for better performance
 * and reduced complexity. Checks every 10 minutes with Pacific timezone
 * awareness for exact timing precision.
 */

import { Event } from "../models";
import { Logger } from "./LoggerService";
import { eventReminderDispatchService } from "./notifications/EventReminderDispatchService";
import {
  WORKER_CAPABILITIES,
  WORKER_SERVICE_KEYS,
  workerAuthorizationService,
  type WorkerRunContext,
  type WorkerRunTrigger,
} from "./authorization/WorkerAuthorizationService";

// Minimal event shape used by the scheduler
type ReminderEvent = {
  _id: unknown;
  title?: string;
  date?: string;
  time?: string;
  location?: string;
  zoomLink?: string;
  format?: string;
};

class EventReminderScheduler {
  private static instance: EventReminderScheduler;
  private isRunning: boolean = false;
  private intervals: NodeJS.Timeout[] = [];
  private lastRunAt: Date | null = null;
  private lastProcessedCount: number = 0;
  private runs: number = 0;
  private lastErrorAt: Date | null = null;
  private log = Logger.getInstance().child("EventReminderScheduler");

  public static getInstance(): EventReminderScheduler {
    if (!EventReminderScheduler.instance) {
      EventReminderScheduler.instance = new EventReminderScheduler();
    }
    return EventReminderScheduler.instance;
  }

  /**
   * Start the automated scheduler
   */
  public start(): void {
    if (this.isRunning) {
      console.log("⚠️ Event reminder scheduler is already running");
      this.log.warn("Scheduler already running");
      return;
    }

    // Run every 10 minutes to check for 24-hour reminders (600000 ms = 10 minutes)
    const tenMinuteInterval = setInterval(async () => {
      await this.runScheduledCheck("scheduled");
    }, 600000);

    this.intervals.push(tenMinuteInterval);
    this.isRunning = true;

    console.log("✅ Event reminder scheduler started");
    console.log("   📅 24-hour reminders: Every 10 minutes");
    this.log.info("Scheduler started", undefined, {
      schedule: "every 10 minutes",
    });

    // Run an immediate check on startup for debugging
    console.log(
      "🚀 Running initial reminder check on startup (testing reset flag)..."
    );
    this.log.debug("Initial reminder check scheduled (5s after start)");
    setTimeout(async () => {
      await this.runScheduledCheck("startup");
    }, 5000); // Wait 5 seconds for server to fully start
  }

  /**
   * Stop the scheduler
   */
  public stop(): void {
    if (!this.isRunning) {
      console.log("⚠️ Event reminder scheduler is not running");
      this.log.warn("Stop requested but scheduler not running");
      return;
    }

    // Clear all intervals
    this.intervals.forEach((interval) => clearInterval(interval));
    this.intervals = [];
    this.isRunning = false;
    console.log("🛑 Event reminder scheduler stopped");
    this.log.info("Scheduler stopped");
  }

  /**
   * Process events that need 24-hour reminders
   */
  private async runScheduledCheck(trigger: WorkerRunTrigger): Promise<void> {
    const context = workerAuthorizationService.createRunContext(
      WORKER_SERVICE_KEYS.EVENT_REMINDER,
      trigger,
    );
    try {
      await this.processEventReminders(context);
    } catch (error) {
      this.lastErrorAt = new Date();
      this.log.error("Event reminder worker authorization failed", error as Error, undefined, {
        runId: context.runId,
        trigger,
      });
    }
  }

  private async processEventReminders(context: WorkerRunContext): Promise<void> {
    await workerAuthorizationService.assertCapability(
      context,
      WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
    );

    try {
      this.lastRunAt = new Date();
      const eventsNeedingReminders = await this.getEventsNeedingReminders();
      this.lastProcessedCount = eventsNeedingReminders.length;
      this.runs += 1;

      if (eventsNeedingReminders.length === 0) {
        console.log(`ℹ️ No events need 24h reminders at this time`);
        this.log.info("No events need 24h reminders");
        return;
      }

      console.log(
        `📧 Found ${eventsNeedingReminders.length} events needing 24h reminders`
      );
      this.log.info("Events needing 24h reminders", undefined, {
        count: eventsNeedingReminders.length,
      });

      // Send reminders for each event
      for (const event of eventsNeedingReminders) {
        console.log(`🔒 Processing event: ${event.title} (${event._id})`);
        this.log.debug("Processing event for reminders", undefined, {
          eventId: String(event._id),
          title: event.title,
        });

        // Send the trio FIRST - let the API handle deduplication
        try {
          await this.sendEventReminderTrio(event, context);
          console.log(`✅ Completed processing for event: ${event.title}`);
          this.log.info("Completed processing event", undefined, {
            eventId: String(event._id),
            title: event.title,
          });
        } catch (error) {
          console.error(`❌ Failed to send trio for ${event.title}:`, error);
          this.log.error(
            `Failed to send trio for event`,
            error as Error,
            undefined,
            { eventId: String(event._id), title: event.title }
          );
        }
      }
    } catch (error) {
      console.error(`❌ Error processing 24h event reminders:`, error);
      this.log.error("Error processing 24h reminders", error as Error);
      this.lastErrorAt = new Date();
    }
  }

  /**
   * Get events that need 24-hour reminders based on exact timing
   * Uses Pacific Time (PST/PDT) to match event storage format
   */
  private async getEventsNeedingReminders(): Promise<ReminderEvent[]> {
    try {
      // Get current time - server is already in PDT timezone
      const now = new Date();

      console.log(`🌏 Checking for events needing 24h reminders:`);
      console.log(`   📅 Current time (PDT): ${now.toString()}`);
      this.log.debug("Checking events needing 24h reminders", undefined, {
        now: now.toISOString(),
      });

      // Get all events that haven't had their 24h reminder sent yet
      const candidateEvents = await Event.find({
        "24hReminderSent": { $ne: true },
        // Additional safeguard: Not sent in the last 30 minutes (prevents duplicates from timing overlaps)
        $or: [
          { "24hReminderSentAt": { $exists: false } },
          {
            "24hReminderSentAt": { $lt: new Date(Date.now() - 30 * 60 * 1000) },
          },
        ],
      });

      console.log(
        `   📋 Found ${candidateEvents.length} events without 24h reminders`
      );
      this.log.debug("Candidate events without 24h reminders", undefined, {
        count: candidateEvents.length,
      });

      // Filter: Find events where current_time >= event_time - 24h
      const events = candidateEvents.filter((event: ReminderEvent) => {
        const eventDateTimeString = `${String(event.date || "")}T${String(
          event.time || ""
        )}:00.000`;
        const eventDateTime = new Date(eventDateTimeString);
        const reminderTriggerTime = new Date(
          eventDateTime.getTime() - 24 * 60 * 60 * 1000
        );

        // Should trigger now? (current time >= 24h before event)
        const shouldTrigger = now >= reminderTriggerTime;

        // Event still in future? (don't send reminders for past events)
        const eventIsInFuture = eventDateTime > now;

        if (shouldTrigger && eventIsInFuture) {
          console.log(
            `   ✅ ${
              event.title
            } needs reminder (trigger time: ${reminderTriggerTime.toString()})`
          );
          this.log.debug("Event needs reminder", undefined, {
            eventId: String(event._id),
            title: event.title,
            triggerTime: reminderTriggerTime.toISOString(),
          });
        }

        return shouldTrigger && eventIsInFuture;
      });

      console.log(
        `   � Result: ${events.length} events need 24h reminders right now`
      );

      return events;
    } catch (error) {
      console.error("Error querying events for reminders:", error);
      this.log.error("Error querying events for reminders", error as Error);
      return [];
    }
  }

  /** Send the event reminder trio through the shared domain operation. */
  private async sendEventReminderTrio(
    event: ReminderEvent,
    context: WorkerRunContext,
  ): Promise<void> {
    console.log(`📤 Sending 24h reminder for: ${event.title}`);
    this.log.info("Sending 24h reminder", undefined, {
      eventId: String(event._id),
      title: event.title,
      runId: context.runId,
    });

    const result = await eventReminderDispatchService.dispatch({
      eventId: String(event._id),
      eventData: {
        title: event.title || "Untitled Event",
        date: event.date || "TBD",
        time: event.time || "TBD",
        location: event.location || "TBD",
        zoomLink: event.zoomLink,
        format: event.format || "in-person",
      },
      reminderType: "24h",
    });

    console.log(`✅ Event reminder trio sent successfully: ${result.message}`);
    this.log.info("Event reminder trio sent successfully", undefined, {
      ...result,
      runId: context.runId,
    });

    if (result.systemMessageCreated === false) {
      console.warn(
        `⚠️ WARNING: System message creation failed for event: ${event.title}`,
      );
      console.warn(
        "   Users will receive emails but no system messages or bell notifications!",
      );
      this.log.warn("System message creation failed for event", undefined, {
        eventId: String(event._id),
        title: event.title,
        runId: context.runId,
      });
    }

    if (result.details) {
      console.log(
        `   📊 Details: ${result.details.emailsSent}/${result.details.totalParticipants} emails sent, System msg: ${result.details.systemMessageSuccess ? "✅" : "❌"}`,
      );
      this.log.debug("Reminder details", undefined, result.details);
    }
  }

  /**
   * Get status of the scheduler
   */
  public getStatus(): { isRunning: boolean; uptime?: number } {
    return {
      isRunning: this.isRunning,
      uptime: process.uptime(),
      // extended diagnostics
      lastRunAt: this.lastRunAt ? this.lastRunAt.getTime() : undefined,
      lastProcessedCount: this.lastProcessedCount,
      runs: this.runs,
      lastErrorAt: this.lastErrorAt ? this.lastErrorAt.getTime() : undefined,
    } as unknown as { isRunning: boolean; uptime?: number };
  }

  /**
   * Manually trigger reminders for testing
   */
  public async triggerManualCheck(initiatedByUserId?: string): Promise<void> {
    const context = workerAuthorizationService.createRunContext(
      WORKER_SERVICE_KEYS.EVENT_REMINDER,
      "manual",
      initiatedByUserId,
    );

    // In test environment, avoid making external HTTP calls or heavy work.
    // The integration test only verifies the admin route responds with success.
    // Allow tests to force the heavy path by setting SCHEDULER_TEST_FORCE=true
    if (
      process.env.NODE_ENV === "test" &&
      process.env.SCHEDULER_TEST_FORCE !== "true"
    ) {
      await workerAuthorizationService.assertCapability(
        context,
        WORKER_CAPABILITIES.EVENT_REMINDER_SEND,
      );
      console.log("🔧 Manual trigger: skipped heavy processing in test env");
      this.log.debug("Manual trigger skipped in test env");
      return;
    }

    console.log(`🔧 Manual trigger: Checking for 24h reminders...`);
    this.log.info("Manual trigger: checking for 24h reminders");
    await this.processEventReminders(context);
  }
}

export default EventReminderScheduler;
