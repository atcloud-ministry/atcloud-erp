import mongoose from "mongoose";
import type { EventReminderRequest } from "../../controllers/emailNotifications/types";
import { UnifiedMessageController } from "../../controllers/unifiedMessageController";
import { EmailRecipientUtils } from "../../utils/emailRecipientUtils";
import { EmailService } from "../infrastructure/EmailServiceFacade";
import { CachePatterns } from "../infrastructure/CacheService";

export interface EventReminderDispatchResult {
  readonly message: string;
  readonly recipientCount?: number;
  readonly systemMessageCreated?: boolean;
  readonly alreadySent?: boolean;
  readonly preventedDuplicate?: boolean;
  readonly details?: {
    readonly emailsSent: number;
    readonly totalParticipants: number;
    readonly totalGuests: number;
    readonly totalEmailRecipients: number;
    readonly systemMessageSuccess: boolean;
  };
}

type EventParticipant = {
  email: string;
  firstName: string;
  lastName: string;
  _id?: unknown;
};

type EventGuest = {
  email: string;
  firstName: string;
  lastName: string;
};

/**
 * Transport-neutral event-reminder operation shared by HTTP and workers.
 * Authentication and authorization remain the responsibility of the caller.
 */
export class EventReminderDispatchService {
  async dispatch(
    request: EventReminderRequest,
  ): Promise<EventReminderDispatchResult> {
    const { eventId, eventData, reminderType } = request;

    if (reminderType === "24h") {
      try {
        const Event = mongoose.model("Event");
        const updateResult = await Event.findOneAndUpdate(
          {
            _id: eventId,
            $or: [
              { "24hReminderSent": false },
              { "24hReminderSent": null },
              { "24hReminderSent": { $exists: false } },
            ],
          },
          {
            "24hReminderSent": true,
            "24hReminderSentAt": new Date(),
            "24hReminderProcessingBy": "event-reminder-dispatch",
          },
          { new: false, runValidators: false },
        );

        if (!updateResult) {
          console.log(
            `🛡️ DUPLICATE PREVENTION: 24h reminder already sent for event ${eventId}`,
          );
          return {
            message: "24h reminder already sent for this event",
            alreadySent: true,
            preventedDuplicate: true,
          };
        }

        console.log(
          `🔒 ATOMIC LOCK: Successfully claimed event ${eventId} for 24h reminder processing`,
        );
        await CachePatterns.invalidateEventCache(eventId);
      } catch (error) {
        console.warn(
          `⚠️ Atomic deduplication check failed for event ${eventId}:`,
          error,
        );
      }
    }

    let eventParticipants: EventParticipant[] = [];
    try {
      eventParticipants = await EmailRecipientUtils.getEventParticipants(eventId);
    } catch (error) {
      console.warn(
        `⚠️ Failed to fetch event participants for ${eventId}; continuing with none:`,
        error,
      );
    }
    if (!Array.isArray(eventParticipants)) eventParticipants = [];

    let eventGuests: EventGuest[] = [];
    try {
      const guests = await EmailRecipientUtils.getEventGuests(eventId);
      eventGuests = Array.isArray(guests) ? guests : [];
    } catch (error) {
      console.warn(
        `⚠️ Failed to fetch event guests for ${eventId}; continuing without guests:`,
        error,
      );
    }

    const totalEmailRecipients = eventParticipants.length + eventGuests.length;
    if (totalEmailRecipients === 0) {
      console.warn(`No participants or guests found for event reminder: ${eventId}`);
      return {
        message: "Event reminder notification sent to 0 recipient(s)",
        recipientCount: 0,
      };
    }

    const reminderEventData = {
      title: eventData.title,
      date: eventData.date || "TBD",
      time: eventData.time || "TBD",
      location: eventData.location || "TBD",
      zoomLink: eventData.zoomLink,
      format: eventData.format || "in-person",
    };
    const reminder = reminderType || "24h";
    const emailResults = await EmailService.sendEventReminderEmailBulk(
      [
        ...eventParticipants.map((participant) => ({
          email: participant.email,
          name:
            `${participant.firstName} ${participant.lastName}`.trim() ||
            participant.email,
        })),
        ...eventGuests.map((guest) => ({
          email: guest.email,
          name: `${guest.firstName} ${guest.lastName}`.trim() || guest.email,
        })),
      ],
      reminderEventData,
      reminder,
    );
    const successCount = (emailResults || []).filter(
      (sent: boolean) => sent === true,
    ).length;

    console.log(
      `Event reminder notification sent: ${eventData.title} (${eventId}) - ${reminder} reminder to ${successCount}/${totalEmailRecipients} recipients (participants + guests, deduped)`,
    );

    let systemMessageSuccess = false;
    try {
      const participantIds = eventParticipants
        .map((participant) => participant._id)
        .filter((id): id is unknown => id !== undefined)
        .map((id) => (typeof id === "string" ? id : String(id)));

      if (participantIds.length > 0) {
        const reminderText =
          reminder === "1h"
            ? "1 hour"
            : reminder === "24h"
              ? "24 hours"
              : "1 week";

        await UnifiedMessageController.createTargetedSystemMessage(
          {
            title: `Event Reminder: ${eventData.title}`,
            content: `This is a ${reminderText} reminder for the event "${eventData.title}" scheduled for ${eventData.date} at ${eventData.time}. Location: ${eventData.location || "TBD"}. Don't forget to attend!`,
            type: "announcement",
            priority: "medium",
            hideCreator: true,
          },
          participantIds,
          {
            id: "system",
            firstName: "System",
            lastName: "Administrator",
            username: "system",
            avatar: "/default-avatar-male.jpg",
            gender: "male",
            authLevel: "Super Admin",
            roleInAtCloud: "System",
          },
        );
        systemMessageSuccess = true;
        console.log(
          `✅ System message and bell notifications created for ${participantIds.length} participants`,
        );
      }
    } catch (error) {
      console.error(
        "❌ CRITICAL: Failed to create event reminder system message:",
        error,
      );
      console.error(
        "   This means users will not receive system messages or bell notifications!",
      );
      if (error instanceof Error) {
        console.error("   Error details:", error.message);
        console.error("   Stack trace:", error.stack);
      }
    }

    return {
      message: `Event reminder notification sent to ${successCount} recipient(s)`,
      recipientCount: successCount,
      systemMessageCreated: systemMessageSuccess,
      details: {
        emailsSent: successCount,
        totalParticipants: eventParticipants.length,
        totalGuests: eventGuests.length,
        totalEmailRecipients,
        systemMessageSuccess,
      },
    };
  }
}

export const eventReminderDispatchService = new EventReminderDispatchService();
