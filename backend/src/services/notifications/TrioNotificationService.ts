/**
 * TRIO NOTIFICATION SERVICE - Phase 2 Enhanced Architecture
 *
 * ⚠️  CORE SERVICE - DO NOT DELETE ⚠️
 *
 * Unified service for atomic trio notification creation with advanced features:
 * - Transaction-like behavior with rollback mechanisms
 * - Centralized error handling with recovery strategies
 * - Performance optimization and monitoring
 * - Configuration-driven timeouts and retries
 *
 * PURPOSE: Single point of control for all trio operations
 * SCOPE: Email + System Message + Bell notification coordination
 * FEATURES: Atomic operations, rollback, monitoring, configuration management
 */

import { UnifiedMessageController } from "../../controllers/unifiedMessageController";
import { EmailService } from "../infrastructure/EmailServiceFacade";
import { socketService } from "../infrastructure/SocketService";
import { NOTIFICATION_CONFIG } from "../../config/notificationConfig";
import { NotificationErrorHandler } from "./NotificationErrorHandler";
// Adjusted path: shared utilities copied under backend/src/shared
import { findUtcInstantFromLocal } from "@atcloud/shared-time";
import { TrioTransaction } from "./TrioTransaction";
import { Logger } from "../LoggerService";
import { serializeSystemMessageForRecipient } from "../../serializers/systemMessageRealtimeSerializer";

// Types for trio operations
export interface TrioRequest {
  email?: {
    to: string;
    template: string;
    data: any;
    priority?: "high" | "medium" | "low";
  };
  systemMessage: {
    title: string;
    content: string;
    type?: string;
    priority?: string;
    hideCreator?: boolean;
    targetRoles?: string[];
    metadata?: any;
  };
  recipients: string[]; // User IDs to receive the trio
  creator?: {
    id: string;
    firstName: string;
    lastName: string;
    username: string;
    avatar?: string;
    gender: string;
    authLevel: string;
    roleInAtCloud?: string;
  };
  options?: {
    enableRollback?: boolean;
    timeout?: number;
    retries?: number;
  };
}

export interface TrioResult {
  success: boolean;
  emailId?: string;
  messageId?: string;
  notificationsSent?: number;
  error?: string;
  rollbackCompleted?: boolean;
  metrics?: {
    duration: number;
    emailTime?: number;
    messageTime?: number;
    socketTime?: number;
  };
}

export interface TrioMetrics {
  totalRequests: number;
  successfulTrios: number;
  failedTrios: number;
  averageLatency: number;
  rollbackCount: number;
  errorsByType: Record<string, number>;
}

/**
 * Enhanced Trio Notification Service
 * Replaces ad-hoc trio creation with standardized, atomic operations
 */
export class TrioNotificationService {
  private static metrics: TrioMetrics = {
    totalRequests: 0,
    successfulTrios: 0,
    failedTrios: 0,
    averageLatency: 0,
    rollbackCount: 0,
    errorsByType: {},
  };

  // Structured logger (console preserved for test compatibility)
  private static log = Logger.getInstance().child("TrioNotificationService");

  /**
   * Create complete notification trio with transaction safety
   * This is the main entry point for all trio operations
   */
  static async createTrio(request: TrioRequest): Promise<TrioResult> {
    const startTime = Date.now();
    const transaction = new TrioTransaction();
    this.metrics.totalRequests++;

    try {
      console.log(
        `🔄 Starting trio creation for ${request.recipients.length} recipients`
      );
      this.log.info("Starting trio creation", undefined, {
        recipientsCount: request.recipients.length,
        hasEmail: Boolean(request.email),
        hasSystemMessage: Boolean(request.systemMessage),
        enableRollback: request.options?.enableRollback !== false,
      });

      // Step 1: Send email (if provided) with timeout and retry
      let emailResult: any = null;
      let emailTime = 0;

      if (request.email) {
        const emailStart = Date.now();
        emailResult = await this.sendEmailWithTimeout(
          request.email,
          transaction
        );
        emailTime = Date.now() - emailStart;
        console.log(`📧 Email sent in ${emailTime}ms`);
        this.log.info("Email sent", undefined, {
          template: request.email.template,
          duration: emailTime,
        });
      }

      // Step 2: Create system message (atomic database operation)
      const messageStart = Date.now();
      const messageResult = await this.createSystemMessage(
        request.systemMessage,
        request.recipients,
        request.creator,
        transaction
      );
      const messageTime = Date.now() - messageStart;
      console.log(`💬 System message created in ${messageTime}ms`);
      this.log.info("System message created", undefined, {
        duration: messageTime,
        messageId: messageResult?._id?.toString?.(),
      });

      // Step 3: Emit WebSocket events (with retry and error tolerance)
      const socketStart = Date.now();
      const socketResult = await this.emitWebSocketEvents(
        messageResult,
        this.getPersistedRecipientIds(messageResult),
        transaction
      );
      const socketTime = Date.now() - socketStart;
      console.log(`🔔 WebSocket events emitted in ${socketTime}ms`);
      this.log.info("WebSocket events emitted", undefined, {
        duration: socketTime,
        count: socketResult.count,
      });

      // Commit transaction if everything succeeded
      await transaction.commit();

      const totalDuration = Date.now() - startTime;
      this.updateMetrics(true, totalDuration);

      console.log(
        `✅ Trio creation completed successfully in ${totalDuration}ms`
      );
      this.log.info("Trio creation completed", undefined, {
        duration: totalDuration,
      });

      return {
        success: true,
        emailId: emailResult?.id,
        messageId: messageResult._id.toString(),
        notificationsSent: socketResult.count,
        metrics: {
          duration: totalDuration,
          emailTime,
          messageTime,
          socketTime,
        },
      };
    } catch (error) {
      console.error(`❌ Trio creation failed:`, error);
      this.log.error("Trio creation failed", error as Error);

      // Attempt rollback if enabled
      let rollbackCompleted = false;
      if (
        request.options?.enableRollback !== false &&
        NOTIFICATION_CONFIG.features.enableRollback
      ) {
        try {
          await transaction.rollback();
          rollbackCompleted = true;
          this.metrics.rollbackCount++;
          console.log(`🔄 Rollback completed successfully`);
          this.log.info("Rollback completed successfully");
        } catch (rollbackError) {
          console.error(`💥 Rollback failed:`, rollbackError);
          this.log.error("Rollback failed", rollbackError as Error);
        }
      }

      // Handle error through centralized error handler
      await NotificationErrorHandler.handleTrioFailure(error as any, {
        request,
        transaction,
      });

      const totalDuration = Date.now() - startTime;
      this.updateMetrics(false, totalDuration);
      this.recordError(error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        rollbackCompleted,
        metrics: {
          duration: totalDuration,
        },
      };
    }
  }

  /**
   * Send email with timeout and retry logic
   */
  private static async sendEmailWithTimeout(
    emailRequest: TrioRequest["email"],
    transaction: TrioTransaction
  ): Promise<any> {
    if (!emailRequest) return null;

    const timeout = NOTIFICATION_CONFIG.timeouts.email;
    const retries = NOTIFICATION_CONFIG.retries.email;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const emailPromise = this.executeEmailSend(emailRequest);

        const emailResult = await Promise.race([
          emailPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Email timeout after ${timeout}ms`)),
              timeout
            )
          ),
        ]);

        // Track email operation for rollback
        transaction.addOperation("email", {
          id: (emailResult as any)?.id,
          rollback: async () => {
            console.log(`🔄 Email rollback - marking as cancelled`);
          },
        });

        return emailResult;
      } catch (error) {
        console.warn(`📧 Email attempt ${attempt}/${retries} failed:`, error);
        this.log.warn(`Email attempt ${attempt}/${retries} failed`, undefined, {
          reason: (error as any)?.message,
        });

        if (attempt === retries) {
          throw new Error(`Email failed after ${retries} attempts: ${error}`);
        }

        const baseDelay = process.env.NODE_ENV === "test" ? 100 : 1000;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * baseDelay)
        );
      }
    }
  }

  /**
   * Execute the actual email sending based on template type
   */
  private static async executeEmailSend(
    emailRequest: TrioRequest["email"]
  ): Promise<any> {
    if (!emailRequest) return null;

    switch (emailRequest.template) {
      case "welcome":
        return await EmailService.sendWelcomeEmail(
          emailRequest.to,
          emailRequest.data.name
        );
      case "password-reset-success":
        return await EmailService.sendPasswordResetSuccessEmail(
          emailRequest.to,
          emailRequest.data.name
        );
      case "event-created":
        return await EmailService.sendEventCreatedEmail(
          emailRequest.to,
          emailRequest.data.userName,
          emailRequest.data.event
        );
      case "co-organizer-assigned":
        return await EmailService.sendCoOrganizerAssignedEmail(
          emailRequest.to,
          emailRequest.data.assignedUser,
          emailRequest.data.event,
          emailRequest.data.assignedBy
        );
      case "event-reminder":
        return await EmailService.sendEventReminderEmail(
          emailRequest.data.event,
          emailRequest.data.user,
          emailRequest.data.reminderType || "upcoming",
          emailRequest.data.timeUntilEvent || "24 hours"
        );
      case "new-leader-signup":
        return await EmailService.sendNewLeaderSignupEmail(
          emailRequest.data.newUser,
          emailRequest.data.adminEmail,
          emailRequest.data.adminUsers
        );
      case "event-role-assigned":
        return await EmailService.sendEventRoleAssignedEmail(
          emailRequest.to,
          emailRequest.data
        );
      case "event-role-removed":
        return await EmailService.sendEventRoleRemovedEmail(
          emailRequest.to,
          emailRequest.data
        );
      case "event-role-moved":
        return await EmailService.sendEventRoleMovedEmail(
          emailRequest.to,
          emailRequest.data
        );
      case "event-role-rejected":
        return await EmailService.sendEventRoleAssignmentRejectedEmail(
          emailRequest.to,
          emailRequest.data
        );
      default:
        throw new Error(`Unknown email template: ${emailRequest.template}`);
    }
  }

  /**
   * Create system message with atomic database operation
   */
  private static async createSystemMessage(
    messageData: TrioRequest["systemMessage"],
    recipients: string[],
    creator: TrioRequest["creator"],
    transaction: TrioTransaction
  ): Promise<any> {
    try {
      const messageResult =
        await UnifiedMessageController.createTargetedSystemMessage(
          messageData,
          recipients,
          creator,
          { emitMessageCreatedEvent: false },
        );

      transaction.addOperation("message", {
        id: messageResult._id.toString(),
        rollback: async () => {
          console.log(`🔄 Message rollback - marking as inactive`);
          this.log.info("Message rollback - marking as inactive", undefined, {
            id: messageResult._id.toString(),
          });
          messageResult.isActive = false;
          await messageResult.save();
        },
      });

      return messageResult;
    } catch (error) {
      throw new Error(`System message creation failed: ${error}`);
    }
  }

  /**
   * Emit WebSocket events with retry logic
   */
  private static async emitWebSocketEvents(
    message: any,
    recipients: string[],
    transaction: TrioTransaction
  ): Promise<{ count: number }> {
    let successCount = 0;
    const errors: string[] = [];

    for (const userId of recipients) {
      try {
        await this.emitWithRetry(userId, message);
        successCount++;
      } catch (error) {
        console.warn(`🔔 WebSocket emission failed for user ${userId}:`, error);
        this.log.warn(
          `WebSocket emission failed for user ${userId}`,
          undefined,
          { userId, error: String(error) }
        );
        errors.push(`User ${userId}: ${error}`);
      }
    }

    transaction.addOperation("websocket", {
      id: `ws-${Date.now()}`,
      metadata: { count: successCount },
      rollback: async () => {
        console.log(`🔄 WebSocket rollback - no action needed (ephemeral)`);
      },
    });

    if (successCount === 0 && recipients.length > 0) {
      this.log.error("All WebSocket emissions failed", undefined, undefined, {
        errors,
      });
      throw new Error(`All WebSocket emissions failed: ${errors.join(", ")}`);
    }

    return { count: successCount };
  }

  private static getPersistedRecipientIds(
    message: {
      userStates?: Map<string, unknown> | Record<string, unknown>;
    },
  ): string[] {
    if (message.userStates instanceof Map) {
      return Array.from(message.userStates.keys());
    }
    if (message.userStates && typeof message.userStates === "object") {
      return Object.keys(message.userStates);
    }

    throw new Error("TRIO_MESSAGE_RECIPIENT_STATE_MISSING");
  }

  /**
   * Emit WebSocket event with retry logic
   */
  private static async emitWithRetry(
    userId: string,
    message: any
  ): Promise<void> {
    const retries = NOTIFICATION_CONFIG.retries.websocket;
    const timeout = NOTIFICATION_CONFIG.timeouts.websocket;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const emitPromise = new Promise<void>((resolve, reject) => {
          try {
            socketService.emitSystemMessageUpdate(userId, "message_created", {
              message: serializeSystemMessageForRecipient(message, userId),
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        await Promise.race([
          emitPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`WebSocket timeout after ${timeout}ms`)),
              timeout
            )
          ),
        ]);

        return;
      } catch (error) {
        if (attempt === retries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  /** Update performance metrics */
  private static updateMetrics(success: boolean, duration: number): void {
    if (success) this.metrics.successfulTrios++;
    else this.metrics.failedTrios++;
    const totalTrios = this.metrics.successfulTrios + this.metrics.failedTrios;
    this.metrics.averageLatency =
      (this.metrics.averageLatency * (totalTrios - 1) + duration) / totalTrios;
  }

  /** Record error for metrics */
  private static recordError(error: any): void {
    const errorType = error?.constructor?.name || "UnknownError";
    this.metrics.errorsByType[errorType] =
      (this.metrics.errorsByType[errorType] || 0) + 1;
  }

  /** Get current performance metrics */
  static getMetrics(): TrioMetrics {
    return { ...this.metrics };
  }

  /** Reset metrics (useful for testing) */
  static resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      successfulTrios: 0,
      failedTrios: 0,
      averageLatency: 0,
      rollbackCount: 0,
      errorsByType: {},
    };
  }

  // Convenience methods

  static async createWelcomeTrio(
    userEmail: string,
    userName: string,
    userId: string
  ): Promise<TrioResult> {
    return this.createTrio({
      email: {
        to: userEmail,
        template: "welcome",
        data: { name: userName },
        priority: "high",
      },
      systemMessage: {
        title: "Welcome to @Cloud!",
        content:
          "Welcome to the @Cloud Event Sign-up System! Your account has been verified and you can now participate in events.",
        type: "announcement",
        priority: "medium",
        hideCreator: true,
      },
      recipients: [userId],
    });
  }

  static async createPasswordResetSuccessTrio(
    userEmail: string,
    userName: string,
    userId: string
  ): Promise<TrioResult> {
    return this.createTrio({
      email: {
        to: userEmail,
        template: "password-reset-success",
        data: { name: userName },
        priority: "high",
      },
      systemMessage: {
        title: "Password Reset Successful",
        content:
          "Your password has been successfully reset. You can now log in with your new password.",
        type: "update",
        priority: "high",
        hideCreator: true,
      },
      recipients: [userId],
    });
  }

  static async createEventReminderTrio(
    event: any,
    user: any
  ): Promise<TrioResult> {
    return this.createTrio({
      email: {
        to: user.email,
        template: "event-reminder",
        data: { event, user },
        priority: "medium",
      },
      systemMessage: {
        title: "Event Reminder",
        content: `Reminder: "${event.title}" is coming up soon. Don't forget to prepare!`,
        type: "announcement",
        priority: "medium",
        hideCreator: true,
      },
      recipients: [user._id.toString()],
    });
  }

  /** Event role lifecycle helpers */
  static async createEventRoleAssignedTrio(params: {
    event: {
      id: string;
      _id?: string; // For ICS generation
      title: string;
      date?: string;
      endDate?: string; // For ICS generation
      time?: string;
      endTime?: string; // For ICS generation
      timeZone?: string;
      location?: string;
      purpose?: string; // For ICS generation
      // Virtual meeting fields for comprehensive email details
      format?: string;
      isHybrid?: boolean;
      zoomLink?: string;
      meetingId?: string;
      passcode?: string;
    };
    targetUser: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    };
    roleName: string;
    actor: {
      id: string;
      firstName: string;
      lastName: string;
      username: string;
      avatar?: string;
      gender?: string;
      authLevel?: string;
      roleInAtCloud?: string;
    };
    rejectionToken?: string;
  }): Promise<TrioResult> {
    const { event, targetUser, roleName, actor, rejectionToken } = params;
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const eventDetailUrl = `${baseUrl}/dashboard/event/${encodeURIComponent(
      event.id || ""
    )}`;
    const hasRealToken = Boolean(
      rejectionToken && !rejectionToken.includes("{{")
    );
    const token = hasRealToken
      ? encodeURIComponent(rejectionToken as string)
      : "";
    const rejectionLink = hasRealToken
      ? `${baseUrl}/assignments/reject?token=${token}`
      : "";

    let eventTimeLine: string;
    let eventDateTimeUtc: string | undefined;
    if (event.date && event.time) {
      eventTimeLine = `${event.date} • ${event.time} (${
        event.timeZone || "event local time"
      })`;
      const instant = findUtcInstantFromLocal({
        date: event.date,
        time: event.time,
        timeZone: event.timeZone,
      });
      if (instant) eventDateTimeUtc = instant.toISOString();
    } else {
      eventTimeLine = "Time details not available";
    }

    const explanationAccept =
      "If you accept this invitation, no action is required.";
    const explanationDecline = hasRealToken
      ? "If you need to decline this invitation, please use the Decline Invitation button below or the link provided in your email."
      : "(Rejection link unavailable – please contact the organizer directly if you need to decline.)";

    return this.createTrio({
      email: {
        to: targetUser.email,
        template: "event-role-assigned",
        data: { event, user: targetUser, roleName, actor, rejectionToken },
        priority: "medium",
      },
      systemMessage: {
        title: "Role Invited",
        content:
          `${actor.firstName} ${actor.lastName} invited you to the role: ${roleName} for event "${event.title}".` +
          `\n\nEvent Time: ${eventTimeLine}` +
          `\n\n${explanationAccept}` +
          `\n${explanationDecline}`,
        type: "event_role_change",
        priority: "medium",
        metadata: {
          eventId: event.id,
          eventDetailUrl,
          timing: {
            originalDate: event.date,
            originalTime: event.time,
            originalTimeZone: event.timeZone,
            eventDateTimeUtc,
          },
          ...(hasRealToken ? { rejectionLink } : {}),
        },
      },
      recipients: [targetUser.id],
      creator: {
        id: actor.id,
        firstName: actor.firstName,
        lastName: actor.lastName,
        username: actor.username,
        avatar: actor.avatar,
        gender: (actor.gender as any) || ("" as any),
        authLevel: (actor.authLevel as any) || "",
        roleInAtCloud: actor.roleInAtCloud,
      },
    });
  }

  static async createEventRoleRemovedTrio(params: {
    event: { id: string; title: string };
    targetUser: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    };
    roleName: string;
    actor: {
      id: string;
      firstName: string;
      lastName: string;
      username: string;
      avatar?: string;
      gender?: string;
      authLevel?: string;
      roleInAtCloud?: string;
    };
  }): Promise<TrioResult> {
    const { event, targetUser, roleName, actor } = params;
    return this.createTrio({
      email: {
        to: targetUser.email,
        template: "event-role-removed",
        data: { event, user: targetUser, roleName, actor },
        priority: "medium",
      },
      systemMessage: {
        title: "Role Removed",
        content: `${actor.firstName} ${actor.lastName} removed you from the role: ${roleName} in event "${event.title}".`,
        type: "event_role_change",
        priority: "medium",
      },
      recipients: [targetUser.id],
      creator: {
        id: actor.id,
        firstName: actor.firstName,
        lastName: actor.lastName,
        username: actor.username,
        avatar: actor.avatar,
        gender: actor.gender || ("" as any),
        authLevel: actor.authLevel || "",
        roleInAtCloud: actor.roleInAtCloud,
      },
    });
  }

  static async createEventRoleMovedTrio(params: {
    event: {
      id: string;
      _id?: string; // For ICS generation
      title: string;
      date?: string;
      endDate?: string; // For ICS generation
      time?: string;
      endTime?: string; // For ICS generation
      timeZone?: string;
      location?: string;
      purpose?: string; // For ICS generation
      // Virtual meeting fields for comprehensive email details
      format?: string;
      isHybrid?: boolean;
      zoomLink?: string;
      meetingId?: string;
      passcode?: string;
    };
    targetUser: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    };
    fromRoleName: string;
    toRoleName: string;
    actor: {
      id: string;
      firstName: string;
      lastName: string;
      username: string;
      avatar?: string;
      gender?: string;
      authLevel?: string;
      roleInAtCloud?: string;
    };
  }): Promise<TrioResult> {
    const { event, targetUser, fromRoleName, toRoleName, actor } = params;
    return this.createTrio({
      email: {
        to: targetUser.email,
        template: "event-role-moved",
        data: { event, user: targetUser, fromRoleName, toRoleName, actor },
        priority: "medium",
      },
      systemMessage: {
        title: "Role Updated",
        content: `${actor.firstName} ${actor.lastName} moved you from "${fromRoleName}" to "${toRoleName}" in event "${event.title}".`,
        type: "event_role_change",
        priority: "medium",
      },
      recipients: [targetUser.id],
      creator: {
        id: actor.id,
        firstName: actor.firstName,
        lastName: actor.lastName,
        username: actor.username,
        avatar: actor.avatar,
        gender: actor.gender || ("" as any),
        authLevel: actor.authLevel || "",
        roleInAtCloud: actor.roleInAtCloud,
      },
    });
  }

  static async createEventRoleAssignmentRejectedTrio(params: {
    event: { id: string; title: string };
    targetUser: { id: string; firstName?: string; lastName?: string };
    roleName: string;
    assigner: {
      id: string;
      firstName?: string;
      lastName?: string;
      username?: string;
      avatar?: string;
      gender?: string;
      authLevel?: string;
      roleInAtCloud?: string;
    };
    noteProvided?: boolean;
    assignerEmail?: string;
    noteText?: string;
  }): Promise<TrioResult> {
    const {
      event,
      targetUser,
      roleName,
      assigner,
      noteProvided,
      assignerEmail,
      noteText,
    } = params;
    return this.createTrio({
      email: assignerEmail
        ? {
            to: assignerEmail,
            template: "event-role-rejected",
            data: {
              event,
              roleName,
              rejectedBy: targetUser,
              assigner,
              noteProvided: Boolean(noteProvided),
              noteText: params.noteText,
            },
            priority: "medium",
          }
        : (undefined as any),
      systemMessage: {
        title: "Role Invitation Declined",
        content:
          `${(() => {
            const full = `${targetUser.firstName || ""} ${
              targetUser.lastName || ""
            }`.trim();
            return (
              full || targetUser.firstName || targetUser.lastName || "A user"
            );
          })()} declined the invitation to the role "${roleName}" for event "${
            event.title
          }".` +
          (noteProvided && noteText
            ? `\n\nNote: ${noteText.trim().slice(0, 200)}`
            : ""),
        type: "event_role_change",
        priority: "medium",
        hideCreator: true,
      },
      recipients: [assigner.id],
      creator: {
        id: assigner.id,
        firstName: assigner.firstName || "",
        lastName: assigner.lastName || "",
        username: assigner.username || "",
        avatar: assigner.avatar,
        gender: assigner.gender || ("" as any),
        authLevel: assigner.authLevel || "",
        roleInAtCloud: assigner.roleInAtCloud,
      },
    });
  }
}
