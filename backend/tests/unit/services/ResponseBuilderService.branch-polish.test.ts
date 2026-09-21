import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";
import { ResponseBuilderService } from "../../../src/services/ResponseBuilderService";
import {
  Event,
  GuestRegistration,
  Registration,
  User,
} from "../../../src/models";
import { RegistrationQueryService } from "../../../src/services/RegistrationQueryService";

// Reuse the same mocking pattern as the main suite
vi.mock("../../../src/models", () => ({
  Event: {
    findById: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
  },
  Registration: {
    find: vi.fn(),
    findOne: vi.fn(),
  },
  GuestRegistration: {
    aggregate: vi.fn(),
  },
  User: {
    findById: vi.fn(),
    find: vi.fn(),
  },
}));

vi.mock("../../../src/services/RegistrationQueryService", () => ({
  RegistrationQueryService: {
    getEventSignupCounts: vi.fn(),
    getRoleAvailability: vi.fn(),
    getUserSignupInfo: vi.fn(),
    isUserRegisteredForRole: vi.fn(),
  },
}));

describe("ResponseBuilderService - branch polish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const eventId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const roleId = new Types.ObjectId().toString();

  it("organizer enrichment: keep organizer when user not found", async () => {
    const organizerUserId = new Types.ObjectId().toString();
    const mockEvent: any = {
      _id: eventId,
      title: "Event",
      description: "d",
      location: "loc",
      date: new Date(),
      time: "10:00",
      endTime: "11:00",
      status: "upcoming",
      createdBy: { _id: userId, username: "u", firstName: "F", lastName: "L" },
      roles: [
        { id: roleId, name: "Volunteer", description: "", maxParticipants: 5 },
      ],
      organizerDetails: [
        { userId: organizerUserId, email: "old@x.com", phone: "old" },
      ],
    };

    vi.mocked(Event.findById).mockReturnValue({
      populate: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockEvent),
      }),
    } as any);

    vi.mocked(RegistrationQueryService.getEventSignupCounts).mockResolvedValue({
      eventId,
      totalSignups: 0,
      totalSlots: 5,
      roles: [
        {
          roleId,
          roleName: "Volunteer",
          maxParticipants: 5,
          currentCount: 0,
          availableSpots: 5,
          isFull: false,
          waitlistCount: 0,
        },
      ],
    } as any);

    vi.mocked(Registration.find).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    } as any);
    vi.mocked(GuestRegistration.aggregate).mockResolvedValue([]);

    // Batched organizer lookup returns no match; public exact fields still redact.
    vi.mocked(User.find).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    } as any);

    const res =
      await ResponseBuilderService.buildEventWithRegistrations(eventId);
    expect(res).toBeTruthy();
    expect((res as any).organizerDetails[0].email).toBe("old@x.com");
    expect((res as any).organizerDetails[0]).not.toHaveProperty("phone");
  });

  it("user signup status: existing registration prevents signup; full roles excluded", async () => {
    const mockEvent: any = {
      _id: eventId,
      roles: [
        { id: "r1", name: "Common Participant (on-site)" },
        { id: "r2", name: "Common Participant (Zoom)" },
      ],
    };

    vi.mocked(Registration.findOne).mockReturnValue({
      lean: vi
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId(), roleId: "r1" }),
    } as any);

    vi.mocked(RegistrationQueryService.getUserSignupInfo).mockResolvedValue({
      canSignupForMore: true,
      currentSignups: 1,
      maxAllowedSignups: 2,
    } as any);

    vi.mocked(RegistrationQueryService.getEventSignupCounts).mockResolvedValue({
      roles: [
        { roleId: "r1", isFull: true },
        { roleId: "r2", isFull: false },
      ],
    } as any);

    vi.mocked(Event.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockEvent),
    } as any);

    vi.mocked(User.findById).mockReturnValue({
      lean: vi
        .fn()
        .mockResolvedValue({ systemAuthorizationLevel: "Participant" }),
    } as any);

    const res = await ResponseBuilderService.buildUserSignupStatus(
      userId,
      eventId,
    );
    expect(res).toBeTruthy();
    expect(res!.isRegistered).toBe(true);
    // User already registered -> cannot signup regardless of available roles
    expect(res!.canSignup).toBe(false);
    // r1 is full; only r2 available and allowed by participant rules
    expect(res!.availableRoles).toContain("Common Participant (Zoom)");
    expect(res!.restrictedRoles).not.toContain("Common Participant (Zoom)");
  });
});
