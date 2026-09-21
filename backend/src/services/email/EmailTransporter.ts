/**
 * Email Transporter Module
 *
 * Manages nodemailer transporter configuration and initialization
 * Handles production, development, and test environments
 */

import nodemailer, {
  type SendMailOptions,
  type SentMessageInfo,
  type Transporter,
} from "nodemailer";
import { createLogger } from "../LoggerService";

const log = createLogger("EmailTransporter");

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: SendMailOptions["attachments"];
}

export class EmailTransporter {
  private static transporter: Transporter;

  /**
   * Get or create the nodemailer transporter instance
   * Configures based on environment and available credentials
   */
  static getTransporter(): Transporter {
    if (!this.transporter) {
      // Check if real SMTP credentials are configured
      const hasRealCredentials =
        process.env.SMTP_USER &&
        process.env.SMTP_PASS &&
        !process.env.SMTP_USER.includes("your-email") &&
        !process.env.SMTP_PASS.includes("your-app-password");

      if (process.env.NODE_ENV === "production" && hasRealCredentials) {
        // Production email configuration
        this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });
      } else if (hasRealCredentials) {
        // Development with real credentials
        this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: false, // Use TLS
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });
      } else {
        // Development: Use console logging instead of real email
        console.log(
          "🔧 Development mode: Email service will use console logging"
        );
        // Structured log alongside console for visibility
        try {
          log.info("Development mode: email service using console logging");
        } catch {}
        this.transporter = nodemailer.createTransport({
          jsonTransport: true, // This will just return JSON instead of sending
        });
      }
    }
    return this.transporter;
  }

  /**
   * Send an email using the configured transporter
   */
  static async send(
    options: EmailOptions
  ): Promise<SentMessageInfo> {
    const transporter = this.getTransporter();

    const mailOptions: SendMailOptions = {
      from:
        process.env.EMAIL_FROM ||
        '"@Cloud Ministry" <atcloudministry@gmail.com>',
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };

    if (options.replyTo) {
      mailOptions.replyTo = options.replyTo;
    }
    if (options.attachments && options.attachments.length) {
      mailOptions.attachments = options.attachments;
    }

    return await transporter.sendMail(mailOptions);
  }

  /**
   * Reset transporter instance (useful for testing)
   */
  static resetTransporter(): void {
    this.transporter = null as any;
  }
}
