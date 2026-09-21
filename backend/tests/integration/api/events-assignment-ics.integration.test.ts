import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrioNotificationService } from "../../../src/services/notifications/TrioNotificationService";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";

// Mock the ICS builder
vi.mock("../../../src/services/ICSBuilder", () => ({
  buildRegistrationICS: vi.fn(() => ({
    filename: "assignment-test.ics",
    content:
      "BEGIN:VCALENDAR\r\nPRODID:-//atCloud//Assignment//EN\r\nVERSION:2.0\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:test@atcloud\r\nDTSTAMP:20241001T120000Z\r\nDTSTART:20240615T210000Z\r\nDTEND:20240615T220000Z\r\nSUMMARY:Test Event — Test Role\r\nDESCRIPTION:Test purpose\r\nLOCATION:Test Location\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  })),
}));

// Mock the EmailService.sendEmail method
const mockSendEmail = vi.fn().mockResolvedValue(true);
vi.spyOn(EmailService, "sendEmail").mockImplementation(mockSendEmail);

// Mock console methods to capture logs
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

describe("Role Assignment ICS Integration Test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should generate and attach ICS file when assigning user to role", async () => {
    const mockEventData = {
      id: "test-event-123",
      _id: "test-event-123",
      title: "Test Integration Event",
      date: "2024-06-15",
      endDate: "2024-06-15",
      time: "14:00",
      endTime: "15:00",
      timeZone: "America/Los_Angeles",
      location: "Conference Room A",
      purpose: "Testing role assignment with ICS",
    };

    const mockTargetUser = {
      id: "507f1f77bcf86cd799439011",
      email: "testuser@example.com",
      firstName: "John",
      lastName: "Doe",
    };

    const mockActor = {
      id: "organizer-789",
      firstName: "Jane",
      lastName: "Smith",
      username: "janesmith",
      avatar: undefined,
      gender: "female",
      authLevel: "Administrator",
      roleInAtCloud: "Event Organizer",
    };

    const roleName = "Test Presenter";
    const rejectionToken = "test-rejection-token-123";

    // Call the TrioNotificationService method
    await TrioNotificationService.createEventRoleAssignedTrio({
      event: mockEventData,
      targetUser: mockTargetUser,
      roleName,
      actor: mockActor,
      rejectionToken,
    });

    // Verify that EmailService.sendEmail was called with ICS attachment
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "testuser@example.com",
        subject: expect.stringContaining("Test Presenter"),
        attachments: expect.arrayContaining([
          expect.objectContaining({
            filename: "assignment-test.ics",
            content: expect.stringContaining("BEGIN:VCALENDAR"),
            contentType: "text/calendar; charset=utf-8; method=PUBLISH",
          }),
        ]),
      })
    );

    // Verify that success logging occurred
    expect(mockConsoleLog).toHaveBeenCalledWith(
      "ICS generation successful for role assignment email:",
      expect.objectContaining({
        filename: "assignment-test.ics",
        contentLength: expect.any(Number),
        to: "testuser@example.com",
        roleName: "Test Presenter",
      })
    );

    // Should not have any warning logs
    expect(mockConsoleWarn).not.toHaveBeenCalled();
  });

  it("should handle missing event fields gracefully", async () => {
    const incompleteEventData = {
      id: "test-event-incomplete",
      title: "Incomplete Event",
      // Missing date, time, endDate, endTime, etc.
    };

    const mockTargetUser = {
      id: "507f1f77bcf86cd799439011",
      email: "testuser@example.com",
      firstName: "John",
      lastName: "Doe",
    };

    const mockActor = {
      id: "organizer-789",
      firstName: "Jane",
      lastName: "Smith",
      username: "janesmith",
    };

    // Mock the ICS builder to throw an error for incomplete data
    const { buildRegistrationICS } = await import(
      "../../../src/services/ICSBuilder"
    );
    vi.mocked(buildRegistrationICS).mockImplementationOnce(() => {
      throw new Error("Missing required fields for ICS generation");
    });

    await TrioNotificationService.createEventRoleAssignedTrio({
      event: incompleteEventData,
      targetUser: mockTargetUser,
      roleName: "Test Role",
      actor: mockActor,
    });

    // Should still send email, but without attachment
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "testuser@example.com",
        subject: expect.stringContaining("Test Role"),
      })
    );

    // Should not have attachments when ICS generation fails
    const emailCall = mockSendEmail.mock.calls[0][0];
    expect(emailCall).not.toHaveProperty("attachments");

    // Should have warning logs
    expect(mockConsoleWarn).toHaveBeenCalledWith(
      "ICS generation failed for role assignment email:",
      expect.any(Error)
    );
  });
});
