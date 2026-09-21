import type { SendMailOptions } from "nodemailer";
import dotenv from "dotenv";
import { createLogger } from "../../services/LoggerService";
import { buildRegistrationICS } from "../ICSBuilder";
import {
  generateVerificationEmail,
  generatePasswordResetEmail,
  generatePasswordChangeRequestEmail,
  generatePasswordResetSuccessEmail,
  generateWelcomeEmail,
} from "../../templates/email";
import {
  EmailTransporter,
  EmailDeduplication,
  EmailHelpers,
  EmailOptions,
} from "../email";
import { AuthEmailService } from "../email/domains/AuthEmailService";
import { EventEmailService } from "../email/domains/EventEmailService";
import { RoleEmailService } from "../email/domains/RoleEmailService";
import { GuestEmailService } from "../email/domains/GuestEmailService";
import { UserEmailService } from "../email/domains/UserEmailService";
import { PurchaseEmailService } from "../email/domains/PurchaseEmailService";
import { PromoCodeEmailService } from "../email/domains/PromoCodeEmailService";
import { UtilityEmailService } from "../email/domains/UtilityEmailService";

dotenv.config();

const log = createLogger("EmailService");

interface EmailTemplateData {
  name?: string;
  email?: string;
  verificationUrl?: string;
  resetUrl?: string;
  eventTitle?: string;
  eventDate?: string;
  [key: string]: any;
}

export class EmailService {
  // NOTE: Additional template referenced via TrioNotificationService for guest declines:
  // 'guest-invitation-declined' (assigner/event creator notification when a guest declines)

  /**
   * Test-only: clear internal dedupe cache to avoid cross-test interference.
   * Safe to call in any environment; no effect on behavior other than cache state.
   */
  static __clearDedupeCacheForTests(): void {
    EmailDeduplication.__clearDedupeCacheForTests();
  }

  static async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      // Global duplicate suppression (opt-in): avoid sending the exact same email payload
      // to the same recipient multiple times within a short TTL window.
      if (EmailDeduplication.isDuplicate(options)) {
        try {
          log.info("Duplicate email suppressed by dedupe cache", undefined, {
            to: options.to,
            subject: options.subject,
          });
        } catch {}
        return true; // treat as success
      }

      // Skip email sending in test environment
      if (process.env.NODE_ENV === "test") {
        console.log(
          `📧 Email skipped in test environment: ${options.subject} to ${options.to}`,
        );
        // Structured log, keep console for tests
        try {
          log.info("Email skipped in test environment", undefined, {
            to: options.to,
            subject: options.subject,
          });
        } catch {}
        return true;
      }

      const info = await EmailTransporter.send(options);

      // Check if we're using jsonTransport (development mode without real credentials)
      if (
        info.response &&
        typeof info.response === "string" &&
        info.response.includes('"jsonTransport":true')
      ) {
        console.log("📧 Development Email (not actually sent):");
        console.log(`   To: ${options.to}`);
        console.log(`   Subject: ${options.subject}`);
        console.log(`   Preview URL would be available in production`);
        try {
          log.info("Development Email (jsonTransport)", undefined, {
            to: options.to,
            subject: options.subject,
          });
        } catch {}
        return true;
      }

      if (process.env.NODE_ENV !== "production") {
        console.log("📧 Email sent successfully:");
        console.log(`   To: ${options.to}`);
        console.log(`   Subject: ${options.subject}`);
        if (info.messageId) {
          console.log(`   Message ID: ${info.messageId}`);
        }
        try {
          log.info("Email sent successfully", undefined, {
            to: options.to,
            subject: options.subject,
            messageId: info.messageId,
          });
        } catch {}
      }

      return true;
    } catch (error) {
      console.error("❌ Email send failed:", error);
      try {
        log.error("Email send failed", error as Error | undefined, undefined, {
          to: options.to,
          subject: options.subject,
        });
      } catch {}
      return false;
    }
  }

  // ===== Shared Date-Time Formatting Helpers (delegated to EmailHelpers) =====
  private static normalizeTimeTo24h(time: string): string {
    return EmailHelpers.normalizeTimeTo24h(time);
  }

  private static buildDate(
    date: string,
    time: string,
    timeZone?: string,
  ): Date {
    return EmailHelpers.buildDate(date, time, timeZone);
  }

  private static formatDateTime(
    date: string,
    time: string,
    timeZone?: string,
  ): string {
    return EmailHelpers.formatDateTime(date, time, timeZone);
  }

  private static formatTime(
    time: string,
    timeZone?: string,
    date?: string,
  ): string {
    return EmailHelpers.formatTime(time, timeZone, date);
  }

  private static formatDateTimeRange(
    date: string,
    startTime: string,
    endTime?: string,
    endDate?: string,
    timeZone?: string,
  ): string {
    return EmailHelpers.formatDateTimeRange(
      date,
      startTime,
      endTime,
      endDate,
      timeZone,
    );
  }

  /**
   * Bulk helper: send event update notifications to unique recipients by email.
   * Duplicates (same email, case-insensitive) will be collapsed to a single send.
   */
  static async sendEventNotificationEmailBulk(
    recipients: Array<{ email: string; name?: string }>,
    payload: {
      eventTitle: string;
      date: string;
      endDate?: string;
      time?: string;
      endTime?: string;
      timeZone?: string;
      message?: string;
      updatedByName?: string;
      updatedByRoleInAtCloud?: string;
    },
  ): Promise<boolean[]> {
    return EventEmailService.sendEventNotificationEmailBulk(
      recipients,
      payload,
    );
  }

  static async sendVerificationEmail(
    email: string,
    name: string,
    verificationToken: string,
  ): Promise<boolean> {
    return AuthEmailService.sendVerificationEmail(
      email,
      name,
      verificationToken,
    );
  }

  static async sendPasswordResetEmail(
    email: string,
    name: string,
    resetToken: string,
  ): Promise<boolean> {
    return AuthEmailService.sendPasswordResetEmail(email, name, resetToken);
  }

  static async sendPasswordChangeRequestEmail(
    email: string,
    name: string,
    confirmToken: string,
  ): Promise<boolean> {
    return AuthEmailService.sendPasswordChangeRequestEmail(
      email,
      name,
      confirmToken,
    );
  }

  // ===== Guest Email Helpers =====
  /**
   * Stub notification for auto-unpublish events.
   * The integration test spies on this method. Implemented as a thin wrapper around sendEmail
   * (currently no-op under test env). Future enhancement: include list of missing fields.
   */
  static async sendEventAutoUnpublishNotification(params: {
    eventId: string;
    title: string;
    format?: string;
    missingFields?: string[];
    recipients?: string[]; // optional override; eventually replace with organizer list
  }): Promise<boolean> {
    return EventEmailService.sendEventAutoUnpublishNotification(params);
  }

  /**
   * Send warning about 48-hour grace period before auto-unpublish.
   */
  static async sendEventUnpublishWarningNotification(params: {
    eventId: string;
    title: string;
    format?: string;
    missingFields?: string[];
    recipients?: string[];
  }): Promise<boolean> {
    return EventEmailService.sendEventUnpublishWarningNotification(params);
  }

  /**
   * Send notification when event is actually unpublished after grace period expired.
   */
  static async sendEventActualUnpublishNotification(params: {
    eventId: string;
    title: string;
    format?: string;
    missingFields?: string[];
    recipients?: string[];
  }): Promise<boolean> {
    return EventEmailService.sendEventActualUnpublishNotification(params);
  }

  static async sendGuestConfirmationEmail(params: {
    guestEmail: string;
    guestName: string;
    event: {
      title: string;
      date: Date | string;
      location?: string;
      time?: string;
      endTime?: string;
      endDate?: Date | string;
      timeZone?: string;
      // Virtual/Details support
      format?: string; // "In-person" | "Online" | "Hybrid Participation"
      isHybrid?: boolean;
      zoomLink?: string;
      agenda?: string;
      purpose?: string;
      meetingId?: string;
      passcode?: string;
      organizerDetails?: Array<{
        name: string;
        role: string;
        email: string;
        phone?: string;
      }>;
      // Fallback organizer contact when organizerDetails is empty
      createdBy?: {
        firstName?: string;
        lastName?: string;
        username?: string;
        email?: string;
        phone?: string;
        avatar?: string;
        gender?: string;
      };
    };
    role: { name: string; description?: string };
    registrationId: string;
    manageToken?: string; // optional self-service token for future use
    inviterName?: string; // optional: if present, indicates organizer invited the guest
    declineToken?: string; // optional decline token (only for invited guests)
  }): Promise<boolean> {
    return GuestEmailService.sendGuestConfirmationEmail(params);
  }

  /**
   * Notify organizers that a guest invitation was declined.
   */
  static async sendGuestDeclineNotification(params: {
    event: { title: string; date: Date | string };
    roleName?: string;
    guest: { name: string; email: string };
    reason?: string;
    organizerEmails: string[];
  }): Promise<boolean> {
    return GuestEmailService.sendGuestDeclineNotification(params);
  }

  static async sendGuestRegistrationNotification(params: {
    organizerEmails: string[];
    event: {
      title: string;
      date: Date | string;
      location?: string;
      time?: string;
      endTime?: string;
      endDate?: Date | string;
      timeZone?: string;
    };
    guest: { name: string; email: string; phone?: string };
    role: { name: string };
    registrationDate: Date | string;
  }): Promise<boolean> {
    return GuestEmailService.sendGuestRegistrationNotification(params);
  }

  /**
   * Send account deactivation email to the user (no system message needed)
   */
  static async sendAccountDeactivationEmail(
    userEmail: string,
    userName: string,
    deactivatedBy: { role: string; firstName?: string; lastName?: string },
  ): Promise<boolean> {
    return AuthEmailService.sendAccountDeactivationEmail(
      userEmail,
      userName,
      deactivatedBy,
    );
  }

  /**
   * Send account reactivation email to the user (no system message needed)
   */
  static async sendAccountReactivationEmail(
    userEmail: string,
    userName: string,
    reactivatedBy: { role: string; firstName?: string; lastName?: string },
  ): Promise<boolean> {
    return AuthEmailService.sendAccountReactivationEmail(
      userEmail,
      userName,
      reactivatedBy,
    );
  }

  /**
   * Admin alert: user deactivated
   */
  static async sendUserDeactivatedAlertToAdmin(
    adminEmail: string,
    adminName: string,
    target: { firstName?: string; lastName?: string; email: string },
    actor: {
      firstName?: string;
      lastName?: string;
      email: string;
      role: string;
    },
  ): Promise<boolean> {
    return UserEmailService.sendUserDeactivatedAlertToAdmin(
      adminEmail,
      adminName,
      target,
      actor,
    );
  }

  /**
   * Admin alert: user reactivated
   */
  static async sendUserReactivatedAlertToAdmin(
    adminEmail: string,
    adminName: string,
    target: { firstName?: string; lastName?: string; email: string },
    actor: {
      firstName?: string;
      lastName?: string;
      email: string;
      role: string;
    },
  ): Promise<boolean> {
    return UserEmailService.sendUserReactivatedAlertToAdmin(
      adminEmail,
      adminName,
      target,
      actor,
    );
  }

  /**
   * Admin alert: user deleted
   */
  static async sendUserDeletedAlertToAdmin(
    adminEmail: string,
    adminName: string,
    target: { firstName?: string; lastName?: string; email: string },
    actor: {
      firstName?: string;
      lastName?: string;
      email: string;
      role: string;
    },
  ): Promise<boolean> {
    return UserEmailService.sendUserDeletedAlertToAdmin(
      adminEmail,
      adminName,
      target,
      actor,
    );
  }

  static async sendPasswordResetSuccessEmail(
    email: string,
    name: string,
  ): Promise<boolean> {
    return AuthEmailService.sendPasswordResetSuccessEmail(email, name);
  }

  static async sendEventNotificationEmail(
    email: string,
    name: string,
    data: EmailTemplateData,
  ): Promise<boolean> {
    return EventEmailService.sendEventNotificationEmail(email, name, data);
  }

  /**
   * Generic notification email with custom subject and content.
   * Minimal wrapper around sendEmail to keep controllers simple.
   */
  static async sendGenericNotificationEmail(
    to: string,
    nameOrTitle: string,
    payload: {
      subject: string;
      contentHtml: string;
      contentText?: string;
      attachments?: SendMailOptions["attachments"];
    },
  ): Promise<boolean> {
    return UtilityEmailService.sendGenericNotificationEmail(
      to,
      nameOrTitle,
      payload,
    );
  }

  static async sendWelcomeEmail(email: string, name: string): Promise<boolean> {
    return AuthEmailService.sendWelcomeEmail(email, name);
  }

  static async sendEventCreatedEmail(
    email: string,
    name: string,
    eventData: {
      title: string;
      date: string;
      endDate?: string;
      time: string;
      endTime: string;
      location?: string;
      zoomLink?: string;
      organizer: string;
      purpose?: string;
      format: string;
      timeZone?: string;
      recurringInfo?: {
        frequency:
          | "weekly"
          | "biweekly"
          | "every-two-weeks"
          | "monthly"
          | "every-two-months"
          | "every-three-months"
          | string;
        occurrenceCount: number;
      };
    },
  ): Promise<boolean> {
    return EventEmailService.sendEventCreatedEmail(email, name, eventData);
  }

  /**
   * Send promotion notification to the promoted user
   */
  static async sendPromotionNotificationToUser(
    email: string,
    userData: {
      firstName: string;
      lastName: string;
      oldRole: string;
      newRole: string;
    },
    changedBy: {
      firstName: string;
      lastName: string;
      role: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendPromotionNotificationToUser(
      email,
      userData,
      changedBy,
    );
  }

  /**
   * Send promotion notification to Super Admins and Administrators
   */
  static async sendPromotionNotificationToAdmins(
    adminEmail: string,
    adminName: string,
    userData: {
      firstName: string;
      lastName: string;
      email: string;
      oldRole: string;
      newRole: string;
    },
    changedBy: {
      firstName: string;
      lastName: string;
      role: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendPromotionNotificationToAdmins(
      adminEmail,
      adminName,
      userData,
      changedBy,
    );
  }

  /**
   * Send demotion notification to the demoted user
   * Pattern 3: Sensitive, respectful communication about role changes
   */
  static async sendDemotionNotificationToUser(
    userEmail: string,
    userData: {
      _id: string;
      firstName: string;
      lastName: string;
      email: string;
      oldRole: string;
      newRole: string;
    },
    changedBy: {
      firstName: string;
      lastName: string;
      email: string;
      role: string;
    },
    reason?: string,
  ): Promise<boolean> {
    return RoleEmailService.sendDemotionNotificationToUser(
      userEmail,
      userData,
      changedBy,
      reason,
    );
  }

  /**
   * Send demotion notification to administrators
   * Pattern 4: Administrative record and oversight notification for role demotions
   */
  static async sendDemotionNotificationToAdmins(
    adminEmail: string,
    adminName: string,
    userData: {
      _id: string;
      firstName: string;
      lastName: string;
      email: string;
      oldRole: string;
      newRole: string;
    },
    changedBy: {
      firstName: string;
      lastName: string;
      email: string;
      role: string;
    },
    reason?: string,
  ): Promise<boolean> {
    return RoleEmailService.sendDemotionNotificationToAdmins(
      adminEmail,
      adminName,
      userData,
      changedBy,
      reason,
    );
  }

  /**
   * Send AtCloud Ministry role change notification to the user
   * Simple, functional notification about ministry role changes
   */
  static async sendAtCloudRoleChangeToUser(
    userEmail: string,
    userData: {
      _id: string;
      firstName: string;
      lastName: string;
      email: string;
      oldRoleInAtCloud: string;
      newRoleInAtCloud: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendAtCloudRoleChangeToUser(userEmail, userData);
  }

  /**
   * Send AtCloud Ministry role change notification to admins
   */
  static async sendAtCloudRoleChangeToAdmins(
    adminEmail: string,
    adminName: string,
    userData: {
      _id: string;
      firstName: string;
      lastName: string;
      email: string;
      oldRoleInAtCloud: string;
      newRoleInAtCloud: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendAtCloudRoleChangeToAdmins(
      adminEmail,
      adminName,
      userData,
    );
  }

  /**
   * Send new leader signup notification to admins
   * Pattern: Admin notification when new leader registers
   */
  static async sendNewLeaderSignupEmail(
    adminEmail: string,
    adminName: string,
    newLeaderData: {
      firstName: string;
      lastName: string;
      email: string;
      roleInAtCloud: string;
      signupDate: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendNewLeaderSignupEmail(
      adminEmail,
      adminName,
      newLeaderData,
    );
  }

  /**
   * Send co-organizer assignment notification
   * Pattern: Notification to the newly assigned co-organizer
   */
  static async sendCoOrganizerAssignedEmail(
    coOrganizerEmail: string,
    assignedUser: {
      firstName: string;
      lastName: string;
    },
    eventData: {
      id?: string;
      eventId?: string;
      _id?: unknown;
      title: string;
      date: string;
      time: string;
      endTime?: string;
      endDate?: string;
      location: string;
    },
    assignedBy: {
      firstName: string;
      lastName: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendCoOrganizerAssignedEmail(
      coOrganizerEmail,
      assignedUser,
      eventData,
      assignedBy,
    );
  }

  /**
   * Send event reminder notification to participants
   * Pattern: Time-sensitive reminder to event participants
   */
  static async sendEventReminderEmail(
    email: string,
    userName: string,
    eventData: {
      id?: string;
      eventId?: string;
      _id?: unknown;
      title: string;
      date: string;
      time: string;
      endTime?: string;
      endDate?: string;
      location: string;
      zoomLink?: string;
      format: string;
      timeZone?: string;
    },
    reminderType: "1h" | "24h" | "1week",
  ): Promise<boolean> {
    return EventEmailService.sendEventReminderEmail(
      email,
      userName,
      eventData,
      reminderType,
    );
  }

  /**
   * Bulk helper: send event reminder emails to unique recipients by email.
   * Duplicates (same email, case-insensitive) will be collapsed to a single send.
   */
  static async sendEventReminderEmailBulk(
    recipients: Array<{ email: string; name?: string }>,
    eventData: {
      title: string;
      date: string;
      time: string;
      endTime?: string;
      endDate?: string;
      location: string;
      zoomLink?: string;
      format: string;
      timeZone?: string;
    },
    reminderType: "1h" | "24h" | "1week",
  ): Promise<boolean[]> {
    return EventEmailService.sendEventReminderEmailBulk(
      recipients,
      eventData,
      reminderType,
    );
  }

  /**
   * Send @Cloud role invited notification to admins
   * When user changes from "No" to "Yes" for @Cloud co-worker
   */
  static async sendAtCloudRoleAssignedToAdmins(
    adminEmail: string,
    adminName: string,
    userData: {
      firstName: string;
      lastName: string;
      email: string;
      roleInAtCloud: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendAtCloudRoleAssignedToAdmins(
      adminEmail,
      adminName,
      userData,
    );
  }

  static async sendAtCloudRoleRemovedToAdmins(
    adminEmail: string,
    adminName: string,
    userData: {
      firstName: string;
      lastName: string;
      email: string;
      previousRoleInAtCloud: string;
    },
  ): Promise<boolean> {
    return RoleEmailService.sendAtCloudRoleRemovedToAdmins(
      adminEmail,
      adminName,
      userData,
    );
  }

  /**
   * Send new @Cloud co-worker signup notification to admins
   * When new user signs up with @Cloud co-worker role
   */
  static async sendNewAtCloudLeaderSignupToAdmins(
    adminEmail: string,
    adminName: string,
    userData: {
      firstName: string;
      lastName: string;
      email: string;
      roleInAtCloud: string;
    },
  ): Promise<boolean> {
    return UserEmailService.sendNewAtCloudLeaderSignupToAdmins(
      adminEmail,
      adminName,
      userData,
    );
  }

  // Simple event role lifecycle emails (assignment / removal / move)
  static async sendEventRoleAssignedEmail(
    to: string,
    data: {
      event: any;
      user: any;
      roleName: string;
      actor: any;
      rejectionToken?: string;
    },
  ): Promise<boolean> {
    return EventEmailService.sendEventRoleAssignedEmail(to, data);
  }

  static async sendEventRoleRemovedEmail(
    to: string,
    data: { event: any; user: any; roleName: string; actor: any },
  ): Promise<boolean> {
    return EventEmailService.sendEventRoleRemovedEmail(to, data);
  }

  static async sendEventRoleMovedEmail(
    to: string,
    data: {
      event: any;
      user: any;
      fromRoleName: string;
      toRoleName: string;
      actor: any;
    },
  ): Promise<boolean> {
    return EventEmailService.sendEventRoleMovedEmail(to, data);
  }

  static async sendEventRoleAssignmentRejectedEmail(
    to: string,
    data: {
      event: { id: string; title: string };
      roleName: string;
      rejectedBy: { firstName?: string; lastName?: string };
      assigner: { firstName?: string; lastName?: string };
      noteProvided: boolean;
      noteText?: string; // newly passed raw note text (optional)
    },
  ): Promise<boolean> {
    return EventEmailService.sendEventRoleAssignmentRejectedEmail(to, data);
  }

  /**
   * Send purchase confirmation email after successful program enrollment
   */
  static async sendPurchaseConfirmationEmail(params: {
    email: string;
    name: string;
    orderNumber: string;
    programTitle: string;
    programType: string;
    purchaseDate: Date;
    fullPrice: number;
    finalPrice: number;
    classRepDiscount?: number;
    earlyBirdDiscount?: number;
    isClassRep: boolean;
    isEarlyBird: boolean;
    receiptUrl: string;
  }): Promise<boolean> {
    return PurchaseEmailService.sendPurchaseConfirmationEmail(params);
  }

  /**
   * Send staff promo code notification to user
   */
  static async sendStaffPromoCodeEmail(params: {
    recipientEmail: string;
    recipientName: string;
    promoCode: string;
    discountPercent: number;
    allowedPrograms?: string;
    allowedEvents?: string;
    expiresAt?: string;
    createdBy: string;
    codeType?: "staff" | "reward";
  }): Promise<boolean> {
    return PromoCodeEmailService.sendStaffPromoCodeEmail(params);
  }

  /**
   * Send promo code deactivation notification to user
   */
  static async sendPromoCodeDeactivatedEmail(params: {
    recipientEmail: string;
    recipientName: string;
    promoCode: string;
    discountPercent: number;
    allowedPrograms?: string;
    deactivatedBy: string;
  }): Promise<boolean> {
    return PromoCodeEmailService.sendPromoCodeDeactivatedEmail(params);
  }

  /**
   * Send promo code reactivation notification to user
   */
  static async sendPromoCodeReactivatedEmail(params: {
    recipientEmail: string;
    recipientName: string;
    promoCode: string;
    discountPercent: number;
    allowedPrograms?: string;
    expiresAt?: string;
    reactivatedBy: string;
  }): Promise<boolean> {
    return PromoCodeEmailService.sendPromoCodeReactivatedEmail(params);
  }
}
