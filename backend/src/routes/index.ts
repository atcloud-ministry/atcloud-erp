import { Router } from "express";
import authRoutes from "./auth";
import userRoutes from "./users";
import eventRoutes from "./events";
import { emailNotificationRouter } from "./emailNotifications"; // Email notification system
import notificationRoutes from "./notifications"; // Unified notification system
import analyticsRoutes from "./analytics";
import searchRoutes from "./search";
import systemRoutes from "./system"; // System health and monitoring
import monitorRoutes from "./monitor"; // Request monitoring system
import guestRoutes from "./guests"; // Guest registration system
import guestMigrationRoutes from "./guestMigration"; // Guest migration admin endpoints
import feedbackRoutes from "./feedbackRoutes"; // Feedback system
import uploadsRoutes from "./uploads"; // Generic image/file uploads
import roleAssignmentRejectionRoutes from "./roleAssignmentRejectionRoutes"; // Role assignment rejection flow
import programRoutes from "./programs"; // Programs CRUD and listing
import publicEventsRoutes from "./publicEvents"; // Public events read-only endpoints
import shortLinkRoutes from "./shortLinks"; // Short link creation & lookup
import auditLogRoutes from "./auditLogs"; // Audit log admin endpoints
import rolesTemplatesRoutes from "./rolesTemplates"; // Role templates CRUD
import purchaseRoutes from "./purchases"; // Program purchases and checkout
import annualMembershipRoutes from "./annualMemberships"; // Annual membership suites
import webhookRoutes from "./webhooks"; // Stripe webhooks
import promoCodeRoutes from "./promoCodes"; // Promo code system
import adminPurchaseRoutes from "./admin/purchases"; // Admin payment records
import donationRoutes from "./donations"; // Donation system
import refundRequestRoutes from "./refundRequests"; // Refund approval workflow
import communityRoutes from "./community";
import adminUserRoutes from "./admin/users";
import userOptionsRoutes from "./userOptions";
import runtimeConfigRoutes from "./runtimeConfig";
import featureControlRoutes from "./admin/featureControls";
import recoveryControlRoutes from "./recoveryControls";
import readinessRoutes from "./readiness";
import directoryRoutes from "./directory";
import alumniHelpRequestRoutes from "./alumniHelpRequests";
import conversationRoutes from "./conversations";
import pushRoutes from "./push";

const router = Router();

// Mount non-versioned routes (canonical)
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/events", guestRoutes); // Mount guest routes under /events for guest-signup endpoint
router.use("/events", eventRoutes);
router.use("/", guestRoutes); // Mount guest routes at root for /guest-registrations endpoints
router.use("/email-notifications", emailNotificationRouter);
router.use("/notifications", notificationRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/search", searchRoutes);
router.use("/readiness", readinessRoutes);
router.use("/runtime-config", runtimeConfigRoutes);
router.use("/system/feature-controls", featureControlRoutes);
router.use("/system/recovery", recoveryControlRoutes);
router.use("/system", systemRoutes);
router.use("/monitor", monitorRoutes);
router.use("/guest-migration", guestMigrationRoutes);
router.use("/feedback", feedbackRoutes);
router.use("/uploads", uploadsRoutes);
router.use("/role-assignments/reject", roleAssignmentRejectionRoutes);
router.use("/programs", programRoutes);
router.use("/audit-logs", auditLogRoutes);
router.use("/public", publicEventsRoutes);
router.use("/public/short-links", shortLinkRoutes);
router.use("/roles-templates", rolesTemplatesRoutes);
router.use("/purchases", purchaseRoutes);
router.use("/annual-memberships", annualMembershipRoutes);
router.use("/webhooks", webhookRoutes);
router.use("/promo-codes", promoCodeRoutes);
router.use("/admin/purchases", adminPurchaseRoutes);
router.use("/donations", donationRoutes);
router.use("/refund-requests", refundRequestRoutes);
router.use("/community", communityRoutes);
router.use("/admin/users", adminUserRoutes);
router.use("/directory", directoryRoutes);
router.use("/alumni-help-requests", alumniHelpRequestRoutes);
router.use("/conversations", conversationRoutes);
router.use("/push", pushRoutes);
router.use("/user-options", userOptionsRoutes);

// Health check endpoint
router.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "@Cloud Sign-up System API is running",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// API info endpoint
router.get(`/`, (req, res) => {
  res.status(200).json({
    success: true,
    message: "@Cloud Sign-up System API",
    version: "1.0.0",
    endpoints: {
      auth: `/auth`,
      users: `/users`,
      community: `/community/members`,
      adminUsers: `/admin/users`,
      userOptions: `/user-options`,
      events: `/events`,
      notifications: `/notifications`,
      emailNotifications: `/email-notifications`,
      analytics: `/analytics`,
      feedback: `/feedback`,
      uploads: `/uploads`,
    },
    documentation: {
      auth: {
        register: "POST /auth/register",
        login: "POST /auth/login",
        logout: "POST /auth/logout",
        refreshToken: "POST /auth/refresh-token",
        verifyEmail: "GET /auth/verify-email/:token",
        forgotPassword: "POST /auth/forgot-password",
        resetPassword: "POST /auth/reset-password",
        profile: "GET /auth/profile",
      },
      users: {
        getProfile: "GET /users/profile",
        updateProfile: "PUT /users/profile",
        getUserById: "GET /users/:id (requires MANAGE_USERS; legacy)",
        getAllUsers: "GET /users (requires MANAGE_USERS; legacy)",
        updateUserRole: "PUT /users/:id/role (admin)",
        deactivateUser: "PUT /users/:id/deactivate (admin)",
        reactivateUser: "PUT /users/:id/reactivate (admin)",
      },
      community: {
        listMembers: "GET /community/members",
        getMember: "GET /community/members/:id",
      },
      adminUsers: {
        listUsers: "GET /admin/users (requires MANAGE_USERS)",
        getUser: "GET /admin/users/:id (requires MANAGE_USERS)",
      },
      userOptions: {
        list:
          "GET /user-options?context=event-organizer|program-mentor|event-role-assignee",
      },
      events: {
        getAllEvents: "GET /events",
        getEventById: "GET /events/:id",
        createEvent: "POST /events (leader+)",
        updateEvent: "PUT /events/:id",
        deleteEvent: "DELETE /events/:id",
        signUpForEvent: "POST /events/:id/signup",
        cancelSignup: "POST /events/:id/cancel",
        getUserEvents: "GET /events/user/registered",
        getCreatedEvents: "GET /events/user/created",
        getEventParticipants: "GET /events/:id/participants",
      },
      notifications: {
        getSystemMessages: "GET /notifications/system",
        markAsRead: "PATCH /notifications/system/:messageId/read",
        deleteMessage: "DELETE /notifications/system/:messageId",
        getBellNotifications: "GET /notifications/bell",
        markBellAsRead: "PATCH /notifications/bell/:messageId/read",
        clearBellNotifications: "DELETE /notifications/bell/:messageId",
        getUnreadCounts: "GET /notifications/unread-counts",
        cleanup: "POST /notifications/cleanup",
        sendWelcome: "POST /notifications/welcome",
      },
      emailNotifications: {
        roleChange: "POST /email-notifications/role-change",
        eventCreated: "POST /email-notifications/event-created",
        coOrganizerAssigned: "POST /email-notifications/co-organizer-assigned",
        newLeaderSignup: "POST /email-notifications/new-leader-signup",
        eventReminder: "POST /email-notifications/event-reminder",
      },
      feedback: {
        submitFeedback: "POST /feedback",
      },
    },
  });
});

// 404 handler for undefined routes
router.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    suggestion: `Try /api for available endpoints`,
  });
});

export default router;
