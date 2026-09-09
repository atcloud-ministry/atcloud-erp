import { Router } from "express";
import EventCreatedController from "../controllers/emailNotifications/EventCreatedController";
import SystemAuthorizationChangeController from "../controllers/emailNotifications/SystemAuthorizationChangeController";
import AtCloudRoleChangeController from "../controllers/emailNotifications/AtCloudRoleChangeController";
import NewLeaderSignupController from "../controllers/emailNotifications/NewLeaderSignupController";
import CoOrganizerAssignedController from "../controllers/emailNotifications/CoOrganizerAssignedController";
import EventReminderController from "../controllers/emailNotifications/EventReminderController";
import { authenticate, authorizePermission } from "../middleware/auth";
import EventReminderScheduler from "../services/EventReminderScheduler";
import { PERMISSIONS } from "../utils/roleUtils";

const router = Router();

// All routes are manual notification-management triggers.
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.MANAGE_NOTIFICATIONS));

// Event creation notifications
router.post(
  "/event-created",
  EventCreatedController.sendEventCreatedNotification
);

// Role change notifications
router.post(
  "/system-authorization-change",
  SystemAuthorizationChangeController.sendSystemAuthorizationChangeNotification
);
router.post(
  "/atcloud-role-change",
  AtCloudRoleChangeController.sendAtCloudRoleChangeNotification
);

// Admin notifications
router.post(
  "/new-leader-signup",
  NewLeaderSignupController.sendNewLeaderSignupNotification
);

// Event management notifications
router.post(
  "/co-organizer-assigned",
  CoOrganizerAssignedController.sendCoOrganizerAssignedNotification
);
router.post(
  "/event-reminder",
  EventReminderController.sendEventReminderNotification
);

// Additional notifications (to be implemented)
router.post("/password-reset", (req, res) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
});

router.post("/email-verification", (req, res) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
});

router.post("/security-alert", (req, res) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
});

router.post(
  "/schedule-reminder",
  async (req, res) => {
    try {
      const scheduler = EventReminderScheduler.getInstance();

      // Manually trigger 24h reminder check (simplified version)
      await scheduler.triggerManualCheck(req.userId);

      res.status(200).json({
        success: true,
        message: "Manual 24h reminder check triggered successfully",
      });
    } catch (error) {
      console.error("Error triggering manual reminder check:", error);
      res.status(500).json({
        success: false,
        message: "Failed to trigger manual reminder check",
      });
    }
  },
);

router.post("/event-role-removal", (req, res) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
});

router.post("/event-role-move", (req, res) => {
  res.status(501).json({ success: false, message: "Not implemented yet" });
});

export { router as emailNotificationRouter };
