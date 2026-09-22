import { Router } from "express";
import SystemMessagesRetrievalController from "../controllers/message/SystemMessagesRetrievalController";
import SystemMessagesReadController from "../controllers/message/SystemMessagesReadController";
import SystemMessagesCreationController from "../controllers/message/SystemMessagesCreationController";
import SystemMessagesDeletionController from "../controllers/message/SystemMessagesDeletionController";
import BellNotificationsRetrievalController from "../controllers/message/BellNotificationsRetrievalController";
import BellNotificationsReadController from "../controllers/message/BellNotificationsReadController";
import BellNotificationsBulkReadController from "../controllers/message/BellNotificationsBulkReadController";
import BellNotificationsRemovalController from "../controllers/message/BellNotificationsRemovalController";
import UnreadCountsController from "../controllers/message/UnreadCountsController";
import MessageCleanupController from "../controllers/message/MessageCleanupController";
import WelcomeMessageStatusController from "../controllers/message/WelcomeMessageStatusController";
import WelcomeNotificationController from "../controllers/message/WelcomeNotificationController";
import EventCreatedController from "../controllers/emailNotifications/EventCreatedController";
import SystemAuthorizationChangeController from "../controllers/emailNotifications/SystemAuthorizationChangeController";
import CoOrganizerAssignedController from "../controllers/emailNotifications/CoOrganizerAssignedController";
import { authenticate, authorizePermission } from "../middleware/auth";
import {
  validateSystemMessage,
  validateError,
  handleValidationErrors,
} from "../middleware/validation";
import { param } from "express-validator";
import { PERMISSIONS } from "../utils/roleUtils";

const router = Router();
const requireNotificationManagement = authorizePermission(
  PERMISSIONS.MANAGE_NOTIFICATIONS,
);

// All routes require authentication
router.use(authenticate);

// ===== SYSTEM MESSAGES =====

/**
 * @route GET /api/notifications/system
 * @desc Get all system messages for current user
 * @access Private
 * @query {string} [type] - Filter by message type
 * @query {string} [priority] - Filter by priority
 * @query {boolean} [isRead] - Filter by read status
 * @query {number} [page=1] - Page number
 * @query {number} [limit=50] - Number of items per page
 */
router.get("/system", SystemMessagesRetrievalController.getSystemMessages);

/**
 * @route PATCH /api/notifications/system/:messageId/read
 * @desc Mark a system message as read
 * @access Private
 */
router.patch(
  "/system/:messageId/read",
  [param("messageId").notEmpty().withMessage("Message ID is required")],
  handleValidationErrors,
  SystemMessagesReadController.markSystemMessageAsRead
);

/**
 * @route POST /api/notifications/system
 * @desc Create a new system message
 * @access Private (MANAGE_NOTIFICATIONS)
 */
router.post(
  "/system",
  requireNotificationManagement,
  validateSystemMessage,
  validateError,
  SystemMessagesCreationController.createSystemMessage
);

/**
 * @route DELETE /api/notifications/system/:messageId
 * @desc Delete a system message
 * @access Private
 */
router.delete(
  "/system/:messageId",
  [param("messageId").notEmpty().withMessage("Message ID is required")],
  handleValidationErrors,
  SystemMessagesDeletionController.deleteSystemMessage
);

// ===== BELL NOTIFICATIONS =====

/**
 * @route GET /api/notifications/bell
 * @desc Get bell notifications for current user
 * @access Private
 */
router.get("/bell", BellNotificationsRetrievalController.getBellNotifications);

/**
 * @route PATCH /api/notifications/bell/:messageId/read
 * @desc Mark a bell notification as read
 * @access Private
 */
router.patch(
  "/bell/:messageId/read",
  [param("messageId").notEmpty().withMessage("Message ID is required")],
  handleValidationErrors,
  BellNotificationsReadController.markBellNotificationAsRead
);

/**
 * @route PATCH /api/notifications/bell/read-all
 * @desc Mark all bell notifications as read
 * @access Private
 */
router.patch(
  "/bell/read-all",
  BellNotificationsBulkReadController.markAllBellNotificationsAsRead
);

/**
 * @route DELETE /api/notifications/bell/:messageId
 * @desc Remove a bell notification
 * @access Private
 */
router.delete(
  "/bell/:messageId",
  [param("messageId").notEmpty().withMessage("Message ID is required")],
  handleValidationErrors,
  BellNotificationsRemovalController.removeBellNotification
);

// ===== EMAIL NOTIFICATIONS =====
// Note: These are manual trigger endpoints for administrative use

/**
 * @route POST /api/notifications/email/event-created
 * @desc Manually trigger event creation notification emails
 * @access Private (MANAGE_NOTIFICATIONS)
 */
router.post(
  "/email/event-created",
  requireNotificationManagement,
  EventCreatedController.sendEventCreatedNotification
);

/**
 * @route POST /api/notifications/email/role-change
 * @desc Manually trigger role change notification emails
 * @access Private (MANAGE_NOTIFICATIONS)
 */
router.post(
  "/email/role-change",
  requireNotificationManagement,
  SystemAuthorizationChangeController.sendSystemAuthorizationChangeNotification
);

/**
 * @route POST /api/notifications/email/co-organizer-assigned
 * @desc Manually trigger co-organizer assignment notification emails
 * @access Private (MANAGE_NOTIFICATIONS)
 */
router.post(
  "/email/co-organizer-assigned",
  requireNotificationManagement,
  CoOrganizerAssignedController.sendCoOrganizerAssignedNotification
);

// ===== UTILITY ENDPOINTS =====

/**
 * @route GET /api/notifications/unread-counts
 * @desc Get unread counts for both notifications and system messages
 * @access Private
 */
router.get("/unread-counts", UnreadCountsController.getUnreadCounts);

/**
 * @route POST /api/notifications/cleanup
 * @desc Clean up expired notifications and messages
 * @access Private (MANAGE_NOTIFICATIONS)
 */
router.post(
  "/cleanup",
  requireNotificationManagement,
  MessageCleanupController.cleanupExpiredMessages,
);

// ===== WELCOME SYSTEM =====

/**
 * @route GET /api/notifications/welcome-status
 * @desc Check if user has received welcome message
 * @access Private
 */
router.get(
  "/welcome-status",
  WelcomeMessageStatusController.checkWelcomeMessageStatus
);

/**
 * @route POST /api/notifications/welcome
 * @desc Send welcome notification to user
 * @access Private
 */
router.post("/welcome", WelcomeNotificationController.sendWelcomeNotification);

export default router;
