import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";

// Mock all model dependencies BEFORE importing UserDeletionService
vi.mock("../../../src/models/User", () => ({
  default: {
    findById: vi.fn(),
    findByIdAndDelete: vi.fn(),
  },
}));

vi.mock("../../../src/models/Registration", () => ({
  default: {
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../../../src/models/Event", () => ({
  default: {
    find: vi.fn(),
    findByIdAndDelete: vi.fn(),
    updateMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../../../src/models/Message", () => ({
  default: {
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../../../src/models/PromoCode", () => ({
  default: {
    deleteMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../../../src/models/Program", () => ({
  default: {
    updateMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock("../../../src/models/ShortLink", () => ({
  default: {
    deleteMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock(
  "../../../src/services/authorization/ResourceAuthorizationInvalidationService",
  () => ({
    resourceAuthorizationInvalidationService: {
      invalidateEventRoom: vi.fn(),
    },
  })
);

vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    disconnectUser: vi.fn(),
  },
}));

// Mock filesystem operations
vi.mock("fs/promises", () => ({
  default: {
    unlink: vi.fn(),
  },
}));

// Now import mocked modules and service
import User from "../../../src/models/User";
import Registration from "../../../src/models/Registration";
import Event from "../../../src/models/Event";
import Message from "../../../src/models/Message";
import PromoCode from "../../../src/models/PromoCode";
import Program from "../../../src/models/Program";
import ShortLink from "../../../src/models/ShortLink";
import fs from "fs/promises";
import { UserDeletionService } from "../../../src/services/UserDeletionService";
import { resourceAuthorizationInvalidationService } from "../../../src/services/authorization/ResourceAuthorizationInvalidationService";
import { socketService } from "../../../src/services/infrastructure/SocketService";

describe("UserDeletionService", () => {
  const mockUserId = "507f1f77bcf86cd799439011";
  const mockPerformedBy = {
    _id: new mongoose.Types.ObjectId(),
    email: "admin@example.com",
    role: "Super Admin",
  };

  const mockUser = {
    _id: new mongoose.Types.ObjectId(mockUserId),
    email: "user@example.com",
    firstName: "John",
    lastName: "Doe",
    role: "User",
    createdAt: new Date("2024-01-01"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("deleteUserCompletely", () => {
    describe("Successful deletions", () => {
      it("should successfully delete a user with minimal data", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 2,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 1,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 3,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 1,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result).toEqual({
          userId: mockUserId,
          userEmail: "user@example.com",
          deletedData: {
            userRecord: true,
            registrations: 4, // 2 + 2 from both deleteMany calls
            eventsCreated: 0,
            eventOrganizations: 0,
            messageStates: 3,
            messagesCreated: 1,
            promoCodes: 0,
            programMentorships: 0,
            programClassReps: 0,
            programMentees: 0,
            shortLinks: 0,
            avatarFile: false,
            eventFlyerFiles: 0,
          },
          updatedStatistics: {
            events: [],
            affectedUsers: 0,
          },
          errors: [],
        });

        // Verify all cleanup operations were called
        expect(User.findById).toHaveBeenCalledWith(mockUserId);
        expect(Registration.deleteMany).toHaveBeenCalledTimes(2);
        expect(Registration.updateMany).toHaveBeenCalled();
        expect(Event.find).toHaveBeenCalled();
        expect(Message.updateMany).toHaveBeenCalled();
        expect(Message.deleteMany).toHaveBeenCalled();
        expect(PromoCode.deleteMany).toHaveBeenCalled();
        expect(Program.updateMany).toHaveBeenCalled();
        expect(ShortLink.deleteMany).toHaveBeenCalled();
        expect(User.findByIdAndDelete).toHaveBeenCalledWith(mockUserId);
        expect(socketService.disconnectUser).toHaveBeenCalledTimes(4);
        expect(socketService.disconnectUser).toHaveBeenNthCalledWith(
          1,
          mockUserId
        );
        expect(socketService.disconnectUser).toHaveBeenNthCalledWith(
          2,
          mockUserId
        );
        expect(socketService.disconnectUser).toHaveBeenNthCalledWith(
          3,
          mockUserId
        );
        expect(socketService.disconnectUser).toHaveBeenNthCalledWith(
          4,
          mockUserId
        );
        expect(
          vi.mocked(Event.updateMany).mock.invocationCallOrder[0]
        ).toBeLessThan(
          vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[0]
        );
        expect(
          vi.mocked(Program.updateMany).mock.invocationCallOrder[0]
        ).toBeLessThan(
          vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[1]
        );
        expect(
          vi.mocked(Program.updateMany).mock.invocationCallOrder[1]
        ).toBeLessThan(
          vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[2]
        );
        expect(
          vi.mocked(User.findByIdAndDelete).mock.invocationCallOrder[0]
        ).toBeLessThan(
          vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[3]
        );
      });

      it("should delete user with created events and handle statistics update", async () => {
        // Arrange
        const mockEvents = [
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Test Event 1",
            save: vi.fn().mockResolvedValue(true),
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Test Event 2",
            save: vi.fn().mockResolvedValue(true),
          },
        ];

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 1,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find)
          .mockResolvedValueOnce(mockEvents) // For events created by user
          .mockResolvedValueOnce(mockEvents); // For affected events stats update
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({});
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 1,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.eventsCreated).toBe(2);
        expect(result.deletedData.eventOrganizations).toBe(1);
        expect(result.updatedStatistics.events).toHaveLength(2);
        expect(Event.findByIdAndDelete).toHaveBeenCalledTimes(2);
        expect(
          resourceAuthorizationInvalidationService.invalidateEventRoom
        ).toHaveBeenNthCalledWith(1, mockEvents[0]._id.toString());
        expect(
          resourceAuthorizationInvalidationService.invalidateEventRoom
        ).toHaveBeenNthCalledWith(2, mockEvents[1]._id.toString());
        expect(
          vi.mocked(Event.findByIdAndDelete).mock.invocationCallOrder[0]
        ).toBeLessThan(
          vi.mocked(
            resourceAuthorizationInvalidationService.invalidateEventRoom
          ).mock.invocationCallOrder[0]
        );
        expect(mockEvents[0].save).toHaveBeenCalled();
        expect(mockEvents[1].save).toHaveBeenCalled();
      });

      it("should handle user with organizer roles correctly", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 3,
        } as any); // 3 organizer roles removed
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.eventOrganizations).toBe(3);
        expect(Event.updateMany).toHaveBeenCalledWith(
          {
            "organizerDetails.userId": new mongoose.Types.ObjectId(mockUserId),
          },
          {
            $pull: {
              organizerDetails: {
                userId: new mongoose.Types.ObjectId(mockUserId),
              },
            },
          }
        );
      });

      it("should clean up message states and created messages", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 5,
        } as any); // 5 message states cleaned
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 3,
        } as any); // 3 messages deleted
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.messageStates).toBe(5);
        expect(result.deletedData.messagesCreated).toBe(3);

        // Optimized: now only updates messages where the user state key actually exists
        expect(Message.updateMany).toHaveBeenCalledWith(
          { [`userStates.${mockUserId}`]: { $exists: true } },
          { $unset: { [`userStates.${mockUserId}`]: 1 } }
        );

        expect(Message.deleteMany).toHaveBeenCalledWith({
          $or: [
            { "creator.id": mockUserId },
            { createdBy: new mongoose.Types.ObjectId(mockUserId) },
          ],
        });
      });
    });

    describe("Error handling", () => {
      it("should throw error when user is not found", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(null);

        // Act & Assert
        await expect(
          UserDeletionService.deleteUserCompletely(
            mockUserId,
            mockPerformedBy as any
          )
        ).rejects.toThrow("User not found");

        expect(User.findById).toHaveBeenCalledWith(mockUserId);
        expect(Registration.deleteMany).not.toHaveBeenCalled();
      });

      it("should handle database errors and include them in report", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockRejectedValue(
          new Error("Database connection failed")
        );

        // Act & Assert
        await expect(
          UserDeletionService.deleteUserCompletely(
            mockUserId,
            mockPerformedBy as any
          )
        ).rejects.toThrow("Database connection failed");
      });

      it("should handle partial failures in registration deletion", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany)
          .mockResolvedValueOnce({ deletedCount: 2 } as any) // First call succeeds
          .mockRejectedValueOnce(new Error("Registrar deletion failed")); // Second call fails

        // Act & Assert
        await expect(
          UserDeletionService.deleteUserCompletely(
            mockUserId,
            mockPerformedBy as any
          )
        ).rejects.toThrow("Registrar deletion failed");
      });
    });

    describe("Complex scenarios", () => {
      it("should handle user with maximum data complexity", async () => {
        // Arrange - User with everything: registrations, events, organizer roles, messages
        const complexEvents = [
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Complex Event 1",
            save: vi.fn().mockResolvedValue(true),
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Complex Event 2",
            save: vi.fn().mockResolvedValue(true),
          },
        ];

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany)
          .mockResolvedValueOnce({ deletedCount: 5 } as any) // As participant
          .mockResolvedValueOnce({ deletedCount: 3 } as any); // As registrar
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 2,
        } as any);
        vi.mocked(Event.find)
          .mockResolvedValueOnce(complexEvents) // Events created by user
          .mockResolvedValueOnce(complexEvents); // For statistics update
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({});
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 4,
        } as any); // Organizer roles
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 7,
        } as any); // Message states
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 2,
        } as any); // Created messages
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result).toEqual({
          userId: mockUserId,
          userEmail: "user@example.com",
          deletedData: {
            userRecord: true,
            registrations: 8, // 5 + 3
            eventsCreated: 2,
            eventOrganizations: 4,
            messageStates: 7,
            messagesCreated: 2,
            promoCodes: 0,
            programMentorships: 0,
            programClassReps: 0,
            programMentees: 0,
            shortLinks: 0,
            avatarFile: false,
            eventFlyerFiles: 0,
          },
          updatedStatistics: {
            events: [
              complexEvents[0]._id.toString(),
              complexEvents[1]._id.toString(),
            ],
            affectedUsers: 0,
          },
          errors: [],
        });

        // Verify all complex operations
        expect(Event.findByIdAndDelete).toHaveBeenCalledTimes(2);
        expect(Registration.deleteMany).toHaveBeenCalledTimes(4); // 2 for user registrations + 2 for event registrations
        expect(complexEvents[0].save).toHaveBeenCalled();
        expect(complexEvents[1].save).toHaveBeenCalled();
      });
    });

    describe("Enhanced deletion features", () => {
      it("should delete promo codes owned by user", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 3,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.promoCodes).toBe(3);
        expect(PromoCode.deleteMany).toHaveBeenCalledWith({
          ownerId: new mongoose.Types.ObjectId(mockUserId),
        });
      });

      it("should remove user from program mentors array", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany)
          .mockResolvedValueOnce({ modifiedCount: 2 } as any) // Mentors
          .mockResolvedValueOnce({ modifiedCount: 0 } as any) // ClassReps
          .mockResolvedValueOnce({ modifiedCount: 0 } as any); // Mentees
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.programMentorships).toBe(2);
        expect(Program.updateMany).toHaveBeenCalledWith(
          { "mentors.userId": new mongoose.Types.ObjectId(mockUserId) },
          {
            $pull: {
              mentors: { userId: new mongoose.Types.ObjectId(mockUserId) },
            },
          }
        );
      });

      it("should remove user from program adminEnrollments", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany)
          .mockResolvedValueOnce({ modifiedCount: 0 } as any) // Mentors
          .mockResolvedValueOnce({ modifiedCount: 1 } as any) // ClassReps
          .mockResolvedValueOnce({ modifiedCount: 2 } as any); // Mentees
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.programClassReps).toBe(1);
        expect(result.deletedData.programMentees).toBe(2);
        expect(Program.updateMany).toHaveBeenCalledWith(
          {
            "adminEnrollments.classReps": new mongoose.Types.ObjectId(
              mockUserId
            ),
          },
          {
            $pull: {
              "adminEnrollments.classReps": new mongoose.Types.ObjectId(
                mockUserId
              ),
            },
            $inc: {
              classRepCount: -1,
            },
          }
        );
        expect(Program.updateMany).toHaveBeenCalledWith(
          {
            "adminEnrollments.mentees": new mongoose.Types.ObjectId(mockUserId),
          },
          {
            $pull: {
              "adminEnrollments.mentees": new mongoose.Types.ObjectId(
                mockUserId
              ),
            },
          }
        );
      });

      it("should delete shortlinks for user's created events", async () => {
        // Arrange
        const mockEvents = [
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 1",
            save: vi.fn(),
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 2",
            save: vi.fn(),
          },
        ];

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find)
          .mockResolvedValueOnce(mockEvents) // Events created by user
          .mockResolvedValueOnce(mockEvents); // For stats update
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({});
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 2,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.shortLinks).toBe(2);
        expect(ShortLink.deleteMany).toHaveBeenCalled();
        // Verify it was called with an $in query containing event IDs (as strings)
        const callArg = vi.mocked(ShortLink.deleteMany).mock.calls[0][0] as any;
        expect(callArg.targetEventId.$in).toHaveLength(2);
      });

      it("should delete avatar file when exists", async () => {
        // Arrange
        const userWithAvatar = {
          _id: mockUserId,
          email: "user@example.com",
          avatar: "user123.jpg",
        };

        vi.mocked(User.findById).mockResolvedValue(userWithAvatar as any);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(
          userWithAvatar as any
        );
        vi.mocked(fs.unlink).mockResolvedValue(undefined);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.avatarFile).toBe(true);
        expect(fs.unlink).toHaveBeenCalled();
        const callArg = vi.mocked(fs.unlink).mock.calls[0][0];
        expect(callArg).toContain("uploads/avatars/user123.jpg");
      });

      it("should delete event flyer files", async () => {
        // Arrange
        const mockEvents = [
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 1",
            flyerUrl: "flyer1.jpg",
            save: vi.fn(),
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 2",
            flyerUrl: "flyer2.jpg",
            save: vi.fn(),
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 3",
            // No flyer
            save: vi.fn(),
          },
        ];

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find)
          .mockResolvedValueOnce(mockEvents) // Events created by user
          .mockResolvedValueOnce(mockEvents); // For stats update
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({});
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(mockUser);
        vi.mocked(fs.unlink).mockResolvedValue(undefined);

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert
        expect(result.deletedData.eventFlyerFiles).toBe(2);
        expect(fs.unlink).toHaveBeenCalledTimes(2); // Only 2 events have flyers
      });

      it("should handle file deletion errors gracefully", async () => {
        // Arrange
        const userWithAvatar = {
          _id: mockUserId,
          email: "user@example.com",
          avatar: "user123.jpg",
        };

        vi.mocked(User.findById).mockResolvedValue(userWithAvatar as any);
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Registration.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(Message.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(PromoCode.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateMany).mockResolvedValue({
          modifiedCount: 0,
        } as any);
        vi.mocked(ShortLink.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(User.findByIdAndDelete).mockResolvedValue(
          userWithAvatar as any
        );
        vi.mocked(fs.unlink).mockRejectedValue(new Error("File not found"));

        // Act
        const result = await UserDeletionService.deleteUserCompletely(
          mockUserId,
          mockPerformedBy as any
        );

        // Assert - deletion should still succeed even if file deletion fails
        expect(result.deletedData.userRecord).toBe(true);
        expect(result.deletedData.avatarFile).toBe(false); // False when deletion fails
        expect(fs.unlink).toHaveBeenCalled();
      });
    });
  });

  describe("getUserDeletionImpact", () => {
    describe("Successful impact analysis", () => {
      it("should analyze impact for user with minimal data", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.countDocuments).mockResolvedValue(2);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.countDocuments).mockResolvedValue(1);
        vi.mocked(Message.countDocuments)
          .mockResolvedValueOnce(3) // Message states
          .mockResolvedValueOnce(1); // Messages created
        vi.mocked(PromoCode.countDocuments).mockResolvedValue(0);
        vi.mocked(Program.countDocuments)
          .mockResolvedValueOnce(0) // Mentorships
          .mockResolvedValueOnce(0) // ClassReps
          .mockResolvedValueOnce(0); // Mentees
        vi.mocked(ShortLink.countDocuments).mockResolvedValue(0);

        // Act
        const result = await UserDeletionService.getUserDeletionImpact(
          mockUserId
        );

        // Assert
        expect(result).toEqual({
          user: {
            email: "user@example.com",
            name: "John Doe",
            role: "User",
            createdAt: new Date("2024-01-01"),
          },
          impact: {
            registrations: 2,
            eventsCreated: 0,
            eventOrganizations: 1,
            messageStates: 3,
            messagesCreated: 1,
            promoCodes: 0,
            programMentorships: 0,
            programClassReps: 0,
            programMentees: 0,
            shortLinks: 0,
            avatarFile: false,
            eventFlyerFiles: 0,
            affectedEvents: [],
          },
          risks: ["Will remove 2 event registrations"],
        });

        expect(User.findById).toHaveBeenCalledWith(mockUserId);
        expect(Registration.countDocuments).toHaveBeenCalledWith({
          $or: [
            { userId: new mongoose.Types.ObjectId(mockUserId) },
            { registeredBy: new mongoose.Types.ObjectId(mockUserId) },
          ],
        });
      });

      it("should analyze impact for user with created events", async () => {
        // Arrange
        const mockEvents = [
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Impact Event 1",
            signedUp: 15,
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Impact Event 2",
            signedUp: 8,
          },
        ];

        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.countDocuments).mockResolvedValue(5);
        vi.mocked(Event.find).mockResolvedValue(mockEvents);
        vi.mocked(Event.countDocuments).mockResolvedValue(2);
        vi.mocked(Message.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(4);
        vi.mocked(PromoCode.countDocuments).mockResolvedValue(0);
        vi.mocked(Program.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(ShortLink.countDocuments).mockResolvedValue(0);

        // Act
        const result = await UserDeletionService.getUserDeletionImpact(
          mockUserId
        );

        // Assert
        expect(result.impact.eventsCreated).toBe(2);
        expect(result.impact.affectedEvents).toHaveLength(2);
        expect(result.impact.affectedEvents[0]).toEqual({
          id: mockEvents[0]._id.toString(),
          title: "Impact Event 1",
          participantCount: 15,
        });
        expect(result.impact.affectedEvents[1]).toEqual({
          id: mockEvents[1]._id.toString(),
          title: "Impact Event 2",
          participantCount: 8,
        });
        expect(result.risks).toContain(
          "Will permanently delete 2 events created by this user"
        );
        expect(result.risks).toContain("Will remove 5 event registrations");
      });

      it("should identify Super Admin deletion risk", async () => {
        // Arrange
        const superAdminUser = {
          ...mockUser,
          role: "Super Admin",
        };

        vi.mocked(User.findById).mockResolvedValue(superAdminUser);
        vi.mocked(Registration.countDocuments).mockResolvedValue(0);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.countDocuments).mockResolvedValue(0);
        vi.mocked(Message.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(PromoCode.countDocuments).mockResolvedValue(0);
        vi.mocked(Program.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(ShortLink.countDocuments).mockResolvedValue(0);

        // Act
        const result = await UserDeletionService.getUserDeletionImpact(
          mockUserId
        );

        // Assert
        expect(result.user.role).toBe("Super Admin");
        expect(result.risks).toContain(
          "WARNING: Attempting to delete a Super Admin user"
        );
      });

      it("should analyze promo code impact", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.countDocuments).mockResolvedValue(0);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.countDocuments).mockResolvedValue(0);
        vi.mocked(Message.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(PromoCode.countDocuments).mockResolvedValue(5);
        vi.mocked(Program.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(ShortLink.countDocuments).mockResolvedValue(0);

        // Act
        const result = await UserDeletionService.getUserDeletionImpact(
          mockUserId
        );

        // Assert
        expect(result.impact.promoCodes).toBe(5);
        expect(result.risks).toContain(
          "Will delete 5 promo codes owned by this user"
        );
        expect(PromoCode.countDocuments).toHaveBeenCalledWith({
          ownerId: new mongoose.Types.ObjectId(mockUserId),
        });
      });

      it("should analyze program mentorship impact", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.countDocuments).mockResolvedValue(0);
        vi.mocked(Event.find).mockResolvedValue([]);
        vi.mocked(Event.countDocuments).mockResolvedValue(0);
        vi.mocked(Message.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(PromoCode.countDocuments).mockResolvedValue(0);
        vi.mocked(Program.countDocuments)
          .mockResolvedValueOnce(3) // Mentorships
          .mockResolvedValueOnce(1) // ClassReps
          .mockResolvedValueOnce(2); // Mentees
        vi.mocked(ShortLink.countDocuments).mockResolvedValue(0);

        // Act
        const result = await UserDeletionService.getUserDeletionImpact(
          mockUserId
        );

        // Assert
        expect(result.impact.programMentorships).toBe(3);
        expect(result.impact.programClassReps).toBe(1);
        expect(result.impact.programMentees).toBe(2);
        expect(result.risks).toContain(
          "Will remove user from 3 programs as mentor"
        );
        expect(Program.countDocuments).toHaveBeenCalledWith({
          "mentors.userId": new mongoose.Types.ObjectId(mockUserId),
        });
        expect(Program.countDocuments).toHaveBeenCalledWith({
          "adminEnrollments.classReps": new mongoose.Types.ObjectId(mockUserId),
        });
        expect(Program.countDocuments).toHaveBeenCalledWith({
          "adminEnrollments.mentees": new mongoose.Types.ObjectId(mockUserId),
        });
      });

      it("should analyze shortlink and file impact", async () => {
        // Arrange
        const userWithAvatar = {
          ...mockUser,
          avatar: "user123.jpg",
        };
        const mockEvents = [
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 1",
            flyerUrl: "flyer1.jpg",
            signedUp: 5,
          },
          {
            _id: new mongoose.Types.ObjectId(),
            title: "Event 2",
            flyerUrl: "flyer2.jpg",
            signedUp: 3,
          },
        ];

        vi.mocked(User.findById).mockResolvedValue(userWithAvatar as any);
        vi.mocked(Registration.countDocuments).mockResolvedValue(0);
        vi.mocked(Event.find).mockResolvedValue(mockEvents);
        vi.mocked(Event.countDocuments).mockResolvedValue(0);
        vi.mocked(Message.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(PromoCode.countDocuments).mockResolvedValue(0);
        vi.mocked(Program.countDocuments)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0);
        vi.mocked(ShortLink.countDocuments).mockResolvedValue(2);

        // Act
        const result = await UserDeletionService.getUserDeletionImpact(
          mockUserId
        );

        // Assert
        expect(result.impact.shortLinks).toBe(2);
        expect(result.impact.avatarFile).toBe(true);
        expect(result.impact.eventFlyerFiles).toBe(2);
        expect(ShortLink.countDocuments).toHaveBeenCalled();
        // Verify it was called with an $in query containing event IDs (as strings)
        const callArg = vi.mocked(ShortLink.countDocuments).mock
          .calls[0][0] as any;
        expect(callArg.targetEventId.$in).toHaveLength(2);
      });
    });

    describe("Error handling", () => {
      it("should throw error when user is not found", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(null);

        // Act & Assert
        await expect(
          UserDeletionService.getUserDeletionImpact(mockUserId)
        ).rejects.toThrow("User not found");

        expect(User.findById).toHaveBeenCalledWith(mockUserId);
        expect(Registration.countDocuments).not.toHaveBeenCalled();
      });

      it("should handle database errors during impact analysis", async () => {
        // Arrange
        vi.mocked(User.findById).mockResolvedValue(mockUser);
        vi.mocked(Registration.countDocuments).mockRejectedValue(
          new Error("Database connection failed")
        );

        // Act & Assert
        await expect(
          UserDeletionService.getUserDeletionImpact(mockUserId)
        ).rejects.toThrow(
          "Failed to analyze deletion impact: Database connection failed"
        );
      });
    });
  });
});
