/**
 * EmailService Snapshot Test Suite
 *
 * Purpose: Lock down email template HTML rendering before refactoring
 * Strategy: Snapshot test each template's HTML output to detect unintended changes
 *
 * These tests ensure that when we extract email templates into separate files
 * during refactoring, the rendered HTML remains identical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock nodemailer before importing EmailService
vi.mock("nodemailer", async () => {
  const actual: any = await vi.importActual("nodemailer");
  return {
    __esModule: true,
    ...actual,
    default: {
      ...actual.default,
      createTransport: vi.fn(),
    },
    createTransport: vi.fn(),
  };
});

import nodemailer from "nodemailer";
import { EmailService } from "../../../../src/services/infrastructure/EmailServiceFacade";

describe("EmailService - Email Template Snapshots", () => {
  let mockTransporter: any;
  let originalEnv: NodeJS.ProcessEnv;
  let capturedEmail: { to: string; subject: string; html: string } | null =
    null;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Setup production-like env to ensure emails are "sent"
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "http://localhost:5173";
    process.env.SMTP_USER = "test@example.com";
    process.env.SMTP_PASS = "test-password";
    process.env.SMTP_HOST = "smtp.test.com";
    process.env.SMTP_PORT = "587";

    // Create mock transporter that captures email HTML
    mockTransporter = {
      sendMail: vi.fn().mockImplementation((mailOptions: any) => {
        capturedEmail = {
          to: mailOptions.to,
          subject: mailOptions.subject,
          html: mailOptions.html,
        };
        return Promise.resolve({
          messageId: "test-message-id",
          response: "250 Message accepted",
        });
      }),
      verify: vi.fn().mockResolvedValue(true),
    };

    (nodemailer.createTransport as any).mockReturnValue(mockTransporter);
    capturedEmail = null;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe("Auth Templates", () => {
    it("should match snapshot for verification email", async () => {
      await EmailService.sendVerificationEmail(
        "user@example.com",
        "John Doe",
        "test-token-123"
      );

      expect(capturedEmail).not.toBeNull();
      expect(capturedEmail?.html).toMatchSnapshot();
    });

    it("should match snapshot for password reset email", async () => {
      await EmailService.sendPasswordResetEmail(
        "user@example.com",
        "Jane Smith",
        "reset-token-456"
      );

      expect(capturedEmail).not.toBeNull();
      expect(capturedEmail?.html).toMatchSnapshot();
    });

    it("should match snapshot for password change request email", async () => {
      await EmailService.sendPasswordChangeRequestEmail(
        "user@example.com",
        "Bob Johnson",
        "change-token-789"
      );

      expect(capturedEmail).not.toBeNull();
      expect(capturedEmail?.html).toMatchSnapshot();
    });

    it("should match snapshot for password reset success email", async () => {
      // This snapshot locks the template, not the host's locale/timezone.
      const formatDate = vi
        .spyOn(Date.prototype, "toLocaleString")
        .mockReturnValue("1/15/2024, 4:00:00 AM");
      try {
        capturedEmail = null;
        await EmailService.sendPasswordResetSuccessEmail(
          "test@example.com",
          "John Doe"
        );

        expect(formatDate).toHaveBeenCalled();
        expect(capturedEmail).not.toBeNull();
        expect(capturedEmail!.html).toMatchSnapshot();
      } finally {
        formatDate.mockRestore();
      }
    });
  });

  describe("User Account Templates", () => {
    it("should match snapshot for welcome email", async () => {
      await EmailService.sendWelcomeEmail("newuser@example.com", "New User");

      expect(capturedEmail).not.toBeNull();
      expect(capturedEmail?.html).toMatchSnapshot();
    });
  });

  describe("Template Structure Validation", () => {
    it("should generate consistent HTML structure across all templates", async () => {
      const templates = [
        () => EmailService.sendWelcomeEmail("test@example.com", "Test User"),
        () =>
          EmailService.sendVerificationEmail(
            "test@example.com",
            "Test User",
            "token"
          ),
        () =>
          EmailService.sendPasswordResetEmail(
            "test@example.com",
            "Test User",
            "token"
          ),
      ];

      const htmlOutputs: string[] = [];

      for (const template of templates) {
        capturedEmail = null;
        await template();
        if (capturedEmail !== null) {
          htmlOutputs.push(
            (capturedEmail as { to: string; subject: string; html: string })
              .html
          );
        }
      }

      // Verify all templates have HTML content
      expect(htmlOutputs).toHaveLength(3);
      htmlOutputs.forEach((html) => {
        expect(html).toContain("<!DOCTYPE html");
        expect(html).toContain("<html");
        expect(html).toContain("</html>");
      });
    });
  });
});
