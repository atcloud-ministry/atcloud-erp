import type { Request, Response } from "express";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { eventReminderDispatchService } from "../../services/notifications/EventReminderDispatchService";
import type { EventReminderRequest } from "./types";

const VALID_REMINDER_TYPES = new Set(["1h", "24h", "1week"]);

export default class EventReminderController {
  static async sendEventReminderNotification(
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      const { eventId, eventData, reminderType }: EventReminderRequest = req.body;

      if (!eventId || !eventData || !eventData.title) {
        res.status(400).json({
          success: false,
          message: "Event ID and event data are required",
        });
        return;
      }

      if (reminderType && !VALID_REMINDER_TYPES.has(reminderType)) {
        res.status(400).json({
          success: false,
          message: "Invalid reminder type. Must be '1h', '24h', or '1week'",
        });
        return;
      }

      const result = await eventReminderDispatchService.dispatch({
        eventId,
        eventData,
        reminderType,
      });

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      console.error("Error sending event reminder notifications:", error);
      CorrelatedLogger.fromRequest(req, "EmailNotificationController").error(
        "sendEventReminderNotification failed",
        error as Error,
      );
      res.status(500).json({
        success: false,
        message: "Failed to send event reminder notifications",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
