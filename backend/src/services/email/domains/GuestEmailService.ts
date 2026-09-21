import { EmailService } from "../../infrastructure/EmailServiceFacade";
import { buildRegistrationICS } from "../../ICSBuilder";
import { createLogger } from "../../LoggerService";
import { EmailHelpers } from "../EmailHelpers";

const log = createLogger("GuestEmailService");

/**
 * GuestEmailService
 *
 * Handles all guest-related email notifications:
 * - Guest confirmation emails (registration with ICS calendar attachment)
 * - Guest decline notifications (to organizers)
 * - Guest registration notifications (to organizers)
 *
 * Extracted from EmailService.ts as part of domain-driven refactoring.
 * All methods are exact copies to maintain backward compatibility.
 */
export class GuestEmailService {
  /**
   * Send confirmation email to guest after registration.
   * Includes event details, role information, calendar attachment (ICS),
   * and organizer contact information.
   *
   * @param params - Guest confirmation parameters including event, role, and registration details
   * @returns Promise<boolean> - true if email sent successfully
   */
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
    const frontend = process.env.FRONTEND_URL || "http://localhost:5173";
    const manageUrl = params.manageToken
      ? `${frontend}/guest/manage/${params.manageToken}`
      : `${frontend}/guest/confirmation`;

    const eventDate =
      params.event && (params.event as any).date
        ? new Date(params.event.date)
        : undefined;
    const dateStr = eventDate
      ? EmailHelpers.formatDateTimeRange(
          eventDate.toISOString().slice(0, 10),
          params.event.time || "00:00",
          params.event.endTime,
          params.event.endDate
            ? new Date(params.event.endDate).toISOString().slice(0, 10)
            : undefined,
          params.event.timeZone
        )
      : undefined;

    // Location display rules for confirmation emails:
    // - Online: force label "Online" regardless of stored value.
    // - Hybrid Participation: include the physical location if provided (even though hidden on public page).
    // - In-person: include the physical location if provided.
    // - Otherwise: include location if present.
    const locationForEmail = (() => {
      const fmt = (params.event.format || "").trim();
      if (fmt === "Online") return "Online";
      // Hybrid or In-person: pass through stored location (may be undefined)
      if (fmt === "Hybrid Participation" || fmt === "In-person") {
        return params.event.location || undefined;
      }
      return params.event.location || undefined;
    })();

    // Minimal HTML escaping helper
    const escapeHtml = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");

    // Virtual meeting info: Meeting ID + Passcode define "Meeting Details"
    const meetingId = (params.event.meetingId || "").toString().trim();
    const passcode = (params.event.passcode || "").toString().trim();
    const hasZoomLink = !!(
      params.event.zoomLink && String(params.event.zoomLink).trim()
    );
    const hasMeetingDetails = !!(meetingId && passcode);
    const shouldShowVirtualSections = hasZoomLink && hasMeetingDetails; // fallback if either missing

    // Build organizer contact list: always include primary Organizer (createdBy) when contact info exists,
    // then append any co-organizers from organizerDetails. De-duplicate by email.
    const organizerContacts: Array<{
      name: string;
      role: string;
      email?: string;
      phone?: string;
    }> = (() => {
      const contacts: Array<{
        name: string;
        role: string;
        email?: string;
        phone?: string;
      }> = [];

      // Primary Organizer from createdBy (if contact info present)
      const cb = params.event.createdBy;
      if (cb && (cb.email || cb.phone)) {
        const name =
          [cb.firstName, cb.lastName].filter(Boolean).join(" ") ||
          cb.username ||
          "Organizer";
        contacts.push({
          name,
          role: "Organizer",
          email: cb.email,
          phone: cb.phone,
        });
      }

      // Append organizerDetails (commonly co-organizers)
      if (Array.isArray(params.event.organizerDetails)) {
        for (const o of params.event.organizerDetails) {
          contacts.push({
            name: o.name,
            role: o.role,
            email: o.email,
            phone: o.phone,
          });
        }
      }

      // De-duplicate by email (if email present). Prefer the first occurrence (which would be createdBy if overlapping)
      const seen = new Set<string>();
      const deduped: typeof contacts = [];
      for (const c of contacts) {
        const key = (c.email || "").trim().toLowerCase();
        if (!key) {
          // No email: allow multiple distinct entries without email
          deduped.push(c);
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(c);
      }

      return deduped;
    })();

    // Additional content blocks
    const purposeHtml = escapeHtml(String(params.event.purpose || "")).replace(
      /\n/g,
      "<br/>"
    );
    const descriptionHtml = "";
    const agendaHtml = escapeHtml(String(params.event.agenda || "")).replace(
      /\n/g,
      "<br/>"
    );

    // Use the same logic as organizer contacts to get the inviter name
    const getInviterName = (): string => {
      // Extract from event.createdBy (same logic used for organizer contacts)
      const cb = params.event.createdBy;
      if (cb) {
        const name = [cb.firstName, cb.lastName].filter(Boolean).join(" ");
        if (name) return name;
        if (cb.username) return cb.username;
      }

      // Fallback to first organizer in organizerDetails
      if (
        Array.isArray(params.event.organizerDetails) &&
        params.event.organizerDetails.length > 0
      ) {
        const firstOrganizer = params.event.organizerDetails[0];
        if (
          firstOrganizer.name &&
          firstOrganizer.name.toLowerCase() !== "organizer"
        ) {
          return firstOrganizer.name;
        }
      }

      return "an Organizer";
    };

    const actualInviterName = getInviterName();
    const invited = !!params.inviterName; // Keep original invited flag logic
    const heading = invited
      ? "You have been invited as a Guest"
      : "You're Registered as a Guest";
    const introLine = invited
      ? `You have been invited as a Guest by <strong>${escapeHtml(
          actualInviterName
        )}</strong> for <strong>${escapeHtml(params.event.title)}</strong>.`
      : `Thank you for registering as a guest for <strong>${escapeHtml(
          params.event.title
        )}</strong>.`;

    // Decline section (always show for invited guests, like user assignment emails)
    const declineHtml = (() => {
      if (!invited) return "";

      const hasDeclineToken = !!params.declineToken;
      if (!hasDeclineToken) {
        return `
        <div class="section" style="margin-top:30px;">
          <p>If you need to <strong>decline</strong> this invitation, please contact the organizer using the contact information above so they can invite someone else for this role.</p>
          <p style="margin-top:16px;color:#b71c1c;"><strong>Note:</strong> A decline link was not generated. Please contact the organizer if you cannot participate in this role.</p>
        </div>`;
      }
      const declineUrl = `${frontend}/guest/decline/${encodeURIComponent(
        params.declineToken!
      )}`;
      return `
        <div class="section" style="margin-top:30px;">
          <p>If you need to <strong>decline</strong> this invitation, please click the button below to tell the organizer so they can invite someone else for this role:</p>
          <p style="text-align:center;margin:20px 0;">
            <a href="${declineUrl}" style="background:#c62828;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block;">Decline This Invitation</a>
          </p>
          <p style="font-size:12px;color:#666;">This decline link expires in 14 days. After submission, the invitation will be released.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
          <p style="font-size:12px;color:#888;">If the button doesn't work, copy and paste this URL:<br/><span style="word-break:break-all;">${declineUrl}</span></p>
        </div>`;
    })();

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Guest Registration Confirmed - @Cloud Ministry</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #22c1c3 0%, #fdbb2d 100%); color: white; padding: 24px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 24px; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; padding: 10px 20px; background: #22c1c3; color: #ffffff !important; text-decoration: none; border-radius: 6px; margin: 16px 0; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
            .section { margin: 18px 0; }
            .muted { color: #444; }
            .virtual { background: #0ea5e9; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>${heading}</h1>
            </div>
            <div class="content">
              <p>Hello ${params.guestName},</p>
              <p>${introLine}</p>
              ${dateStr ? `<p><strong>When:</strong> ${dateStr}</p>` : ""}
              ${
                locationForEmail
                  ? `<p><strong>Location:</strong> ${locationForEmail}</p>`
                  : ""
              }
              <p><strong>Role:</strong> ${params.role.name}</p>
              <p><small>Registration ID: ${params.registrationId}</small></p>

              ${
                shouldShowVirtualSections
                  ? `
                <div class="section">
                  <h3>Online Meeting Link</h3>
                  <p>
                    <a href="${String(
                      params.event.zoomLink
                    )}" class="button virtual" style="color: #ffffff !important;">Join Online Meeting</a>
                  </p>
                  <p class="muted">If the button doesn't work, use this link: <a href="${String(
                    params.event.zoomLink
                  )}">${String(params.event.zoomLink)}</a></p>
                </div>
                <div class="section">
                  <h3>Meeting Details</h3>
                  <ul>
                    <li><strong>Meeting ID:</strong> ${escapeHtml(
                      meetingId
                    )}</li>
                    <li><strong>Passcode:</strong> ${escapeHtml(passcode)}</li>
                  </ul>
                </div>
              `
                  : `
                <div class="section">
                  <p>
                    The meeting link and event details will be provided via a separate email once confirmed. We appreciate your patience.
                  </p>
                </div>
              `
              }
              ${declineHtml}

              ${
                purposeHtml
                  ? `<div class="section"><h3>Purpose</h3><p>${purposeHtml}</p></div>`
                  : ""
              }
              
              ${
                agendaHtml
                  ? `<div class="section"><h3>Event Agenda and Schedule</h3><p>${agendaHtml}</p></div>`
                  : ""
              }

              ${
                organizerContacts.length > 0
                  ? `<div class="section"><h3>Organizer Contact Information</h3>
                    <ul>
                      ${organizerContacts
                        .map((o) => {
                          const phone = (o.phone || "").trim();
                          const email = (o.email || "").trim();
                          const emailHtml = email
                            ? ` — Email: <a href=\"mailto:${escapeHtml(
                                email
                              )}\">${escapeHtml(email)}</a>`
                            : "";
                          const phoneHtml = phone
                            ? `${email ? ", " : " — "}Phone: ${escapeHtml(
                                phone
                              )}`
                            : "";
                          return `<li><strong>${escapeHtml(
                            o.name
                          )}</strong> (${escapeHtml(
                            o.role
                          )})${emailHtml}${phoneHtml}</li>`;
                        })
                        .join("")}
                    </ul>
                   </div>`
                  : ""
              }
              <div class="section">
                <h3>Want Full Event Access?</h3>
                <p>We recommend creating an @Cloud account so you can view full event details, receive updates, and manage your participation.</p>
                <p style="text-align:center"><a href="${frontend}/signup" class="button" style="color: #ffffff !important;">Sign Up / Create Account</a></p>
              </div>

              <p>If you have any other questions, please reply to this email.</p>
              <p>Blessings,<br/>The @Cloud Ministry Team</p>
            </div>
            <div class="footer">
              <p>@Cloud Ministry | Building Community Through Faith</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Build text version
    const text = (() => {
      const lines: string[] = [];
      lines.push(
        `You're registered for ${params.event.title}. ${
          dateStr ? `When: ${dateStr}. ` : ""
        }Role: ${params.role.name}. Manage: ${manageUrl}`
      );
      if (shouldShowVirtualSections) {
        lines.push(`Online Meeting Link: ${String(params.event.zoomLink)}`);
        lines.push(`Meeting ID: ${meetingId}`);
        lines.push(`Passcode: ${passcode}`);
      } else {
        lines.push(
          "The meeting link and event details will be provided via a separate email once confirmed. We appreciate your patience."
        );
      }
      if (locationForEmail) lines.push(`Location: ${locationForEmail}`);
      if (params.event.purpose) lines.push(`Purpose: ${params.event.purpose}`);

      if (params.event.agenda)
        lines.push(`Event Agenda and Schedule: ${params.event.agenda}`);
      if (organizerContacts.length > 0) {
        lines.push("Organizer Contact Information:");
        organizerContacts.forEach((o) => {
          const phone = (o.phone || "").trim();
          const email = (o.email || "").trim();
          const emailPart = email ? ` — Email: ${email}` : "";
          const phonePart = phone
            ? `${email ? ", " : " — "}Phone: ${phone}`
            : "";
          const contact = `${emailPart}${phonePart}`;
          lines.push(`- ${o.name} (${o.role})${contact}`);
        });
      }
      return lines.join("\n");
    })();

    // Generate ICS calendar attachment with proper timezone handling
    try {
      const eventDate =
        typeof params.event.date === "string"
          ? params.event.date
          : params.event.date.toISOString().slice(0, 10);
      const endEventDate = params.event.endDate
        ? typeof params.event.endDate === "string"
          ? params.event.endDate
          : params.event.endDate.toISOString().slice(0, 10)
        : eventDate;

      const ics = buildRegistrationICS({
        event: {
          _id: params.event.title, // Use title as fallback since we might not have _id
          title: params.event.title,
          date: eventDate,
          endDate: endEventDate,
          time: params.event.time || "00:00",
          endTime: params.event.endTime || params.event.time || "23:59",
          location: params.event.location || "",
          purpose: params.event.purpose || "",
          timeZone: params.event.timeZone || "UTC",
          format: params.event.format,
          isHybrid: params.event.isHybrid,
          zoomLink: params.event.zoomLink,
          meetingId: params.event.meetingId,
          passcode: params.event.passcode,
        } as unknown as Parameters<typeof buildRegistrationICS>[0]["event"],
        role: {
          name: params.role.name,
          description: params.role.description || `Role: ${params.role.name}`,
        },
        attendeeEmail: params.guestEmail,
      });

      console.log("ICS generation successful for guest confirmation email:", {
        filename: ics.filename,
        contentLength: ics.content.length,
        guestEmail: params.guestEmail,
        roleName: params.role.name,
      });

      return EmailService.sendEmail({
        to: params.guestEmail,
        subject: `✅ You're registered for ${params.event.title}`,
        html,
        text,
        attachments: [
          {
            filename: ics.filename,
            content: ics.content,
            contentType: "text/calendar; charset=utf-8; method=PUBLISH",
          },
        ],
      });
    } catch (icsError) {
      // Fallback: send email without ICS attachment if generation fails
      console.warn(
        "ICS generation failed for guest confirmation email:",
        icsError
      );
      console.warn("Guest event data that failed ICS generation:", {
        title: params.event.title,
        date: params.event.date,
        endDate: params.event.endDate,
        time: params.event.time,
        endTime: params.event.endTime,
        timeZone: params.event.timeZone,
      });

      // Send email without attachment as fallback
      return EmailService.sendEmail({
        to: params.guestEmail,
        subject: `✅ You're registered for ${params.event.title}`,
        html,
        text,
      });
    }
  }

  /**
   * Notify organizers that a guest invitation was declined.
   *
   * @param params - Decline notification parameters including event, guest, and reason
   * @returns Promise<boolean> - true if notification sent successfully to all organizers
   */
  static async sendGuestDeclineNotification(params: {
    event: { title: string; date: Date | string };
    roleName?: string;
    guest: { name: string; email: string };
    reason?: string;
    organizerEmails: string[];
  }): Promise<boolean> {
    try {
      if (!params.organizerEmails || params.organizerEmails.length === 0)
        return false;
      const to = params.organizerEmails;
      const subject = `❌ Guest Declined: ${params.roleName || "Role"} - ${
        params.event.title
      }`;
      const esc = (v: unknown) =>
        String(v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      const safeReason = params.reason ? esc(params.reason) : undefined;
      const dateStr = (() => {
        try {
          const d =
            params.event.date instanceof Date
              ? params.event.date
              : new Date(params.event.date);
          return d.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
        } catch {
          return String(params.event.date);
        }
      })();
      const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#333;">
        <h2 style="color:#c62828;">Guest Invitation Declined</h2>
        <p><strong>${esc(params.guest.name)}</strong> (${esc(
        params.guest.email
      )}) has declined the invitation for role <strong>${esc(
        params.roleName || ""
      )}</strong> in event <em>${esc(params.event.title)}</em>.</p>
        ${dateStr ? `<p><strong>Event Date:</strong> ${dateStr}</p>` : ""}
        ${
          safeReason
            ? `<p><strong>Reason:</strong><br/><span style="white-space:pre-wrap;">${safeReason}</span></p>`
            : ""
        }
        <p style="font-size:12px;color:#666;margin-top:30px;">This is an automated notification regarding a guest invitation decline.</p>
      </body></html>`;
      const text = `${params.guest.name} declined guest invitation for role ${
        params.roleName || "Role"
      } in event ${params.event.title}${
        safeReason ? ` Reason: ${params.reason}` : ""
      }`;
      return EmailService.sendEmail({ to, subject, html, text });
    } catch (err) {
      try {
        log.error("sendGuestDeclineNotification failed", err as Error);
      } catch {}
      return false;
    }
  }

  /**
   * Notify organizers of new guest registration.
   * Sends individual emails to each organizer to avoid exposing recipient list.
   *
   * @param params - Registration notification parameters including event, guest, and organizer emails
   * @returns Promise<boolean> - true if all notifications sent successfully
   */
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
    const recipients = (params.organizerEmails || []).filter(Boolean);
    if (recipients.length === 0) return true; // nothing to send

    const eventDate =
      params.event && (params.event as any).date
        ? new Date(params.event.date)
        : undefined;
    const dateStr = eventDate
      ? EmailHelpers.formatDateTimeRange(
          eventDate.toISOString().slice(0, 10),
          params.event.time || "00:00",
          params.event.endTime,
          params.event.endDate
            ? new Date(params.event.endDate).toISOString().slice(0, 10)
            : undefined,
          params.event.timeZone
        )
      : undefined;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Guest Registration - @Cloud Ministry</title>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #334155; color: white; padding: 18px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 18px; border-radius: 0 0 10px 10px; }
            .footer { text-align: center; margin-top: 16px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>New Guest Registration</h2>
            </div>
            <div class="content">
              <p><strong>Event:</strong> ${params.event.title}</p>
              ${dateStr ? `<p><strong>When:</strong> ${dateStr}</p>` : ""}
              ${
                params.event.location
                  ? `<p><strong>Location:</strong> ${params.event.location}</p>`
                  : ""
              }
              <p><strong>Role:</strong> ${params.role.name}</p>
              <p><strong>Guest:</strong> ${params.guest.name} (${
      params.guest.email
    }${params.guest.phone ? `, ${params.guest.phone}` : ""})</p>
              <p><strong>Time:</strong> ${new Date(
                params.registrationDate
              ).toLocaleString()}</p>
            </div>
            <div class="footer">
              <p>This is an automated notification from @Cloud Ministry.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Send to all organizers individually to avoid exposing recipients
    const results = await Promise.all(
      recipients.map((to) =>
        EmailService.sendEmail({
          to,
          subject: `👤 New Guest Registration: ${params.event.title}`,
          html,
          text: `New guest registration for ${params.event.title}. Guest: ${
            params.guest.name
          } (${params.guest.email}${
            params.guest.phone ? ", " + params.guest.phone : ""
          }). Role: ${params.role.name}. ${dateStr ? `When: ${dateStr}.` : ""}`,
        })
      )
    );
    return results.every(Boolean);
  }
}
