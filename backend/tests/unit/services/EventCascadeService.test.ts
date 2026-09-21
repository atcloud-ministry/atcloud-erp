import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import mongoose from "mongoose";
import { EventCascadeService } from "../../../src/services/EventCascadeService";
import {
  Event,
  Program,
  Registration,
  GuestRegistration,
} from "../../../src/models";
import { CachePatterns } from "../../../src/services/infrastructure/CacheService";
import { resourceAuthorizationInvalidationService } from "../../../src/services/authorization/ResourceAuthorizationInvalidationService";

// Mock all dependencies
vi.mock("../../../src/models");
vi.mock("../../../src/services/infrastructure/CacheService");
vi.mock(
  "../../../src/services/authorization/ResourceAuthorizationInvalidationService",
  () => ({
    resourceAuthorizationInvalidationService: {
      invalidateEventRoom: vi.fn(),
    },
  }),
);

describe("EventCascadeService", () => {
  let testEventId: string;
  let testProgramId: mongoose.Types.ObjectId;

  beforeEach(() => {
    vi.clearAllMocks();
    testEventId = new mongoose.Types.ObjectId().toString();
    testProgramId = new mongoose.Types.ObjectId();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("deleteEventFully", () => {
    describe("successful deletion flow", () => {
      beforeEach(() => {
        // Setup default successful mocks
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 5,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: 3,
        } as any);
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            programId: testProgramId,
          }),
        } as any);
        vi.mocked(Program.updateOne).mockResolvedValue({} as any);
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
          undefined as any
        );
        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockResolvedValue(
          undefined as any
        );
      });

      it("should delete all user registrations for the event", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(Registration.deleteMany).toHaveBeenCalledWith({
          eventId: testEventId,
        });
      });

      it("should delete all guest registrations for the event", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(GuestRegistration.deleteMany).toHaveBeenCalledWith({
          eventId: testEventId,
        });
      });

      it("should remove event from program's events array", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(Event.findById).toHaveBeenCalledWith(testEventId);
        expect(Program.updateOne).toHaveBeenCalledWith(
          { _id: testProgramId },
          { $pull: { events: expect.any(mongoose.Types.ObjectId) } }
        );
      });

      it("should delete the event document itself", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(Event.findByIdAndDelete).toHaveBeenCalledWith(testEventId);
      });

      it("invalidates the live event room after deleting the event", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(
          resourceAuthorizationInvalidationService.invalidateEventRoom,
        ).toHaveBeenCalledWith(testEventId);
        expect(
          vi.mocked(Event.findByIdAndDelete).mock.invocationCallOrder[0],
        ).toBeLessThan(
          vi.mocked(
            resourceAuthorizationInvalidationService.invalidateEventRoom,
          ).mock.invocationCallOrder[0],
        );
      });

      it("should invalidate event cache", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(CachePatterns.invalidateEventCache).toHaveBeenCalledWith(
          testEventId
        );
      });

      it("should invalidate analytics cache", async () => {
        await EventCascadeService.deleteEventFully(testEventId);

        expect(CachePatterns.invalidateAnalyticsCache).toHaveBeenCalled();
      });

      it("should return correct deletion counts", async () => {
        // Override beforeEach mocks with specific values
        vi.mocked(Registration.deleteMany).mockResolvedValueOnce({
          deletedCount: 5,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValueOnce({
          deletedCount: 3,
        } as any);

        const result = await EventCascadeService.deleteEventFully(testEventId);

        expect(result.deletedRegistrations).toBe(5);
        expect(result.deletedGuestRegistrations).toBe(3);
      });

      it("should handle event with no registrations", async () => {
        vi.mocked(Registration.deleteMany).mockResolvedValueOnce({
          deletedCount: 0,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValueOnce({
          deletedCount: 0,
        } as any);

        const result = await EventCascadeService.deleteEventFully(testEventId);

        expect(result.deletedRegistrations).toBe(0);
        expect(result.deletedGuestRegistrations).toBe(0);
      });

      it("should handle event with many registrations", async () => {
        vi.mocked(Registration.deleteMany).mockResolvedValueOnce({
          deletedCount: 150,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValueOnce({
          deletedCount: 75,
        } as any);

        const result = await EventCascadeService.deleteEventFully(testEventId);

        expect(result.deletedRegistrations).toBe(150);
        expect(result.deletedGuestRegistrations).toBe(75);
      });
    });

    describe("resilience and error handling", () => {
      beforeEach(() => {
        // Setup default successful mocks
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 5,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: 3,
        } as any);
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            programId: testProgramId,
          }),
        } as any);
        vi.mocked(Program.updateOne).mockResolvedValue({} as any);
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
          undefined as any
        );
        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockResolvedValue(
          undefined as any
        );
      });

      it("should continue deletion if Registration.deleteMany fails", async () => {
        vi.mocked(Registration.deleteMany).mockRejectedValue(
          new Error("DB error")
        );

        const result = await EventCascadeService.deleteEventFully(testEventId);

        // Should still delete other data
        expect(GuestRegistration.deleteMany).toHaveBeenCalled();
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
        expect(result.deletedRegistrations).toBe(0); // Failed, so 0
      });

      it("should continue deletion if GuestRegistration.deleteMany fails", async () => {
        vi.mocked(GuestRegistration.deleteMany).mockRejectedValue(
          new Error("DB error")
        );

        const result = await EventCascadeService.deleteEventFully(testEventId);

        // Should still delete other data
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
        expect(result.deletedGuestRegistrations).toBe(0); // Failed, so 0
      });

      it("should continue if program pull fails", async () => {
        vi.mocked(Program.updateOne).mockRejectedValue(
          new Error("Update failed")
        );

        // Should not throw
        await expect(
          EventCascadeService.deleteEventFully(testEventId)
        ).resolves.toBeDefined();

        // Event should still be deleted
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
      });

      it("should continue if Event.findById fails when looking for programId", async () => {
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("Find failed")),
        } as any);

        // Should not throw
        await expect(
          EventCascadeService.deleteEventFully(testEventId)
        ).resolves.toBeDefined();

        // Event should still be deleted
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
      });

      it("should continue if cache invalidation fails", async () => {
        vi.mocked(CachePatterns.invalidateEventCache).mockRejectedValue(
          new Error("Cache error")
        );
        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockRejectedValue(
          new Error("Cache error")
        );

        // Should not throw
        await expect(
          EventCascadeService.deleteEventFully(testEventId)
        ).resolves.toBeDefined();

        // Event should still be deleted
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
      });

      it("should handle deletedCount being undefined", async () => {
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: undefined,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: undefined,
        } as any);

        const result = await EventCascadeService.deleteEventFully(testEventId);

        expect(result.deletedRegistrations).toBe(0);
        expect(result.deletedGuestRegistrations).toBe(0);
      });
    });

    describe("program association handling", () => {
      beforeEach(() => {
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Program.updateOne).mockResolvedValue({} as any);
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
          undefined as any
        );
        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockResolvedValue(
          undefined as any
        );
      });

      it("should handle event without programId", async () => {
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            programId: null,
          }),
        } as any);

        await EventCascadeService.deleteEventFully(testEventId);

        // Should not attempt to update program
        expect(Program.updateOne).not.toHaveBeenCalled();
        // But should still delete event
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
      });

      it("should handle event without programId property", async () => {
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({}),
        } as any);

        await EventCascadeService.deleteEventFully(testEventId);

        // Should not attempt to update program
        expect(Program.updateOne).not.toHaveBeenCalled();
        // But should still delete event
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
      });

      it("should handle event that does not exist", async () => {
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);

        await EventCascadeService.deleteEventFully(testEventId);

        // Should not attempt to update program
        expect(Program.updateOne).not.toHaveBeenCalled();
        // Should still attempt to delete event
        expect(Event.findByIdAndDelete).toHaveBeenCalled();
      });

      it("should handle invalid eventId format", async () => {
        const invalidId = "invalid-id-format";

        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            programId: testProgramId,
          }),
        } as any);

        await EventCascadeService.deleteEventFully(invalidId);

        // Should still attempt operations
        expect(Event.findById).toHaveBeenCalledWith(invalidId);
        expect(Event.findByIdAndDelete).toHaveBeenCalledWith(invalidId);
      });

      it("should convert eventId to ObjectId for program pull", async () => {
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            programId: testProgramId,
          }),
        } as any);

        await EventCascadeService.deleteEventFully(testEventId);

        expect(Program.updateOne).toHaveBeenCalledWith(
          { _id: testProgramId },
          { $pull: { events: expect.any(mongoose.Types.ObjectId) } }
        );
      });

      it("should handle programId as string", async () => {
        const programIdString = testProgramId.toString();

        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            programId: programIdString,
          }),
        } as any);

        await EventCascadeService.deleteEventFully(testEventId);

        expect(Program.updateOne).toHaveBeenCalledWith(
          { _id: programIdString },
          { $pull: { events: expect.any(mongoose.Types.ObjectId) } }
        );
      });
    });

    describe("operation ordering", () => {
      it("should delete registrations before deleting event", async () => {
        const callOrder: string[] = [];

        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 1,
        } as any);

        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: 1,
        } as any);

        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({ programId: testProgramId }),
        } as any);

        vi.mocked(Program.updateOne).mockResolvedValue({} as any);

        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);

        vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
          undefined as any
        );

        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockResolvedValue(
          undefined as any
        );

        // Track call order by wrapping with spies
        const registrationsDeleteSpy = vi
          .fn()
          .mockImplementation(() => callOrder.push("registrations"));
        const guestDeleteSpy = vi
          .fn()
          .mockImplementation(() => callOrder.push("guestRegistrations"));
        const findEventSpy = vi
          .fn()
          .mockImplementation(() => callOrder.push("findEvent"));
        const updateProgramSpy = vi
          .fn()
          .mockImplementation(() => callOrder.push("updateProgram"));
        const deleteEventSpy = vi
          .fn()
          .mockImplementation(() => callOrder.push("deleteEvent"));
        const invalidateEventSpy = vi
          .fn()
          .mockImplementation(() => callOrder.push("invalidateEventCache"));

        // Add side effects before the actual mock resolution
        vi.mocked(Registration.deleteMany).mockImplementationOnce(((
          ...args: any[]
        ) => {
          registrationsDeleteSpy();
          return Promise.resolve({ deletedCount: 1 } as any);
        }) as any);

        vi.mocked(GuestRegistration.deleteMany).mockImplementationOnce(((
          ...args: any[]
        ) => {
          guestDeleteSpy();
          return Promise.resolve({ deletedCount: 1 } as any);
        }) as any);

        vi.mocked(Event.findById).mockReturnValueOnce({
          select: vi.fn().mockImplementationOnce(() => {
            findEventSpy();
            return Promise.resolve({ programId: testProgramId });
          }),
        } as any);

        vi.mocked(Program.updateOne).mockImplementationOnce(((
          ...args: any[]
        ) => {
          updateProgramSpy();
          return Promise.resolve({} as any);
        }) as any);

        vi.mocked(Event.findByIdAndDelete).mockImplementationOnce(((
          ...args: any[]
        ) => {
          deleteEventSpy();
          return Promise.resolve({} as any);
        }) as any);

        vi.mocked(CachePatterns.invalidateEventCache).mockImplementationOnce(((
          ...args: any[]
        ) => {
          invalidateEventSpy();
          return Promise.resolve(undefined as any);
        }) as any);

        await EventCascadeService.deleteEventFully(testEventId);

        // Verify registrations are deleted before event
        expect(callOrder.indexOf("registrations")).toBeLessThan(
          callOrder.indexOf("deleteEvent")
        );
        expect(callOrder.indexOf("guestRegistrations")).toBeLessThan(
          callOrder.indexOf("deleteEvent")
        );
        // Verify cache invalidation happens after deletion
        expect(callOrder.indexOf("deleteEvent")).toBeLessThan(
          callOrder.indexOf("invalidateEventCache")
        );
      });
    });

    describe("edge cases", () => {
      beforeEach(() => {
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: 0,
        } as any);
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue(null),
        } as any);
        vi.mocked(Program.updateOne).mockResolvedValue({} as any);
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
          undefined as any
        );
        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockResolvedValue(
          undefined as any
        );
      });

      it("should handle empty string eventId", async () => {
        await expect(
          EventCascadeService.deleteEventFully("")
        ).resolves.toBeDefined();

        expect(Registration.deleteMany).toHaveBeenCalledWith({ eventId: "" });
        expect(Event.findByIdAndDelete).toHaveBeenCalledWith("");
      });

      it("should handle very long eventId string", async () => {
        const longId = "a".repeat(1000);

        await expect(
          EventCascadeService.deleteEventFully(longId)
        ).resolves.toBeDefined();

        expect(Event.findByIdAndDelete).toHaveBeenCalledWith(longId);
      });

      it("should return correct structure even with all errors", async () => {
        vi.mocked(Registration.deleteMany).mockRejectedValue(
          new Error("Error 1")
        );
        vi.mocked(GuestRegistration.deleteMany).mockRejectedValue(
          new Error("Error 2")
        );
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockRejectedValue(new Error("Error 3")),
        } as any);
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);

        const result = await EventCascadeService.deleteEventFully(testEventId);

        expect(result).toHaveProperty("deletedRegistrations");
        expect(result).toHaveProperty("deletedGuestRegistrations");
        expect(result.deletedRegistrations).toBe(0);
        expect(result.deletedGuestRegistrations).toBe(0);
      });
    });

    describe("concurrent deletion scenarios", () => {
      beforeEach(() => {
        vi.mocked(Registration.deleteMany).mockResolvedValue({
          deletedCount: 1,
        } as any);
        vi.mocked(GuestRegistration.deleteMany).mockResolvedValue({
          deletedCount: 1,
        } as any);
        vi.mocked(Event.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({ programId: testProgramId }),
        } as any);
        vi.mocked(Program.updateOne).mockResolvedValue({} as any);
        vi.mocked(Event.findByIdAndDelete).mockResolvedValue({} as any);
        vi.mocked(CachePatterns.invalidateEventCache).mockResolvedValue(
          undefined as any
        );
        vi.mocked(CachePatterns.invalidateAnalyticsCache).mockResolvedValue(
          undefined as any
        );
      });

      it("should handle multiple simultaneous deletions of same event", async () => {
        const promises = [
          EventCascadeService.deleteEventFully(testEventId),
          EventCascadeService.deleteEventFully(testEventId),
          EventCascadeService.deleteEventFully(testEventId),
        ];

        const results = await Promise.all(promises);

        // All should complete successfully
        results.forEach((result) => {
          expect(result).toHaveProperty("deletedRegistrations");
          expect(result).toHaveProperty("deletedGuestRegistrations");
        });
      });

      it("should handle deletions of different events simultaneously", async () => {
        const eventId1 = new mongoose.Types.ObjectId().toString();
        const eventId2 = new mongoose.Types.ObjectId().toString();
        const eventId3 = new mongoose.Types.ObjectId().toString();

        const results = await Promise.all([
          EventCascadeService.deleteEventFully(eventId1),
          EventCascadeService.deleteEventFully(eventId2),
          EventCascadeService.deleteEventFully(eventId3),
        ]);

        // All should complete successfully
        expect(results).toHaveLength(3);
        results.forEach((result) => {
          expect(result).toHaveProperty("deletedRegistrations");
          expect(result).toHaveProperty("deletedGuestRegistrations");
        });
      });
    });
  });
});
