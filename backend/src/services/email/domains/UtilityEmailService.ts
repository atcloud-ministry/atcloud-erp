/**
 * UtilityEmailService.ts
 * Domain service for utility/generic email functionality
 *
 * Created: 2025-01-25
 * Extracted from EmailService.ts as part of domain-driven refactoring.
 *
 * Purpose: Generic email notifications with custom content
 * - Generic notification wrapper for controllers
 */

import type { SendMailOptions } from "nodemailer";
import { EmailService } from "../../infrastructure/EmailServiceFacade";
import { EmailOptions } from "../../email";
import { createLogger } from "../../LoggerService";

const log = createLogger("UtilityEmailService");

export class UtilityEmailService {
  /**
   * Generic notification email with custom subject and content.
   * Minimal wrapper around sendEmail to keep controllers simple.
   *
   * @param to - Recipient email address
   * @param nameOrTitle - Name or title (currently unused, kept for API compatibility)
   * @param payload - Email content and configuration
   * @returns Promise<boolean> - true if email sent successfully
   */
  static async sendGenericNotificationEmail(
    to: string,
    nameOrTitle: string,
    payload: {
      subject: string;
      contentHtml: string;
      contentText?: string;
      attachments?: SendMailOptions["attachments"];
    }
  ): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${payload.subject}</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #495057 0%, #6c757d 100%); color: white; padding: 22px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 24px; border-radius: 0 0 10px 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>${payload.subject}</h2>
            </div>
            <div class="content">
              ${payload.contentHtml}
              <p style="margin-top:20px;">Blessings,<br/>The @Cloud Ministry Team</p>
            </div>
          </div>
        </body>
      </html>
    `;
    return EmailService.sendEmail({
      to,
      subject: payload.subject,
      html,
      text: payload.contentText,
      attachments: payload.attachments,
    });
  }
}
