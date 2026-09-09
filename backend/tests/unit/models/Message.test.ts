import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import Message, {
  IMessage,
  MessageRecipientStateNotFoundError,
} from "../../../src/models/Message";

describe("Message Model", () => {
  console.log("🔧 Setting up Message model test environment...");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    console.log("✅ Message model test environment cleaned up");
  });

  // Helper function to create valid message data
  const createValidMessageData = () => ({
    title: "Test Message",
    content: "This is a test message content",
    type: "announcement" as const,
    priority: "medium" as const,
    creator: {
      id: "creator123",
      firstName: "John",
      lastName: "Doe",
      username: "johndoe",
      avatar: "avatar.jpg",
      gender: "male" as const,
      roleInAtCloud: "Administrator",
      authLevel: "Administrator",
    },
    createdBy: new mongoose.Types.ObjectId(),
  });

  describe("Schema Validation", () => {
    describe("Required Fields", () => {
      it("should require title field", () => {
        const message = new Message({
          ...createValidMessageData(),
          title: undefined,
        });
        const error = message.validateSync();
        expect(error?.errors?.title?.message).toBe("Message title is required");
      });

      it("should require content field", () => {
        const message = new Message({
          ...createValidMessageData(),
          content: undefined,
        });
        const error = message.validateSync();
        expect(error?.errors?.content?.message).toBe(
          "Message content is required"
        );
      });

      it("should require type field", () => {
        const messageData = createValidMessageData();
        const message = new Message({
          title: "Test Message",
          content: "Test content",
          creator: messageData.creator,
          type: undefined,
        });
        // Since type has a default value, we need to explicitly set it to null to trigger validation
        message.type = null as any;
        const error = message.validateSync();
        expect(error?.errors?.type?.message).toBe("Message type is required");
      });

      it("should require creator field", () => {
        const message = new Message({
          ...createValidMessageData(),
          creator: undefined,
        });
        const error = message.validateSync();
        expect(error?.errors?.["creator.id"]?.message).toBe(
          "Creator ID is required"
        );
      });

      it("should require creator sub-fields", () => {
        const message = new Message({
          ...createValidMessageData(),
          creator: {
            id: "test",
            firstName: undefined,
            lastName: undefined,
            username: undefined,
            gender: undefined,
            authLevel: undefined,
          } as any,
        });
        const error = message.validateSync();
        expect(error?.errors?.["creator.firstName"]?.message).toBe(
          "Creator first name is required"
        );
        expect(error?.errors?.["creator.lastName"]?.message).toBe(
          "Creator last name is required"
        );
        expect(error?.errors?.["creator.username"]?.message).toBe(
          "Creator username is required"
        );
        expect(error?.errors?.["creator.gender"]?.message).toBe(
          "Creator gender is required"
        );
        expect(error?.errors?.["creator.authLevel"]?.message).toBe(
          "Creator auth level is required"
        );
      });
    });

    describe("Field Length Validations", () => {
      it("should validate title length", () => {
        const message = new Message({
          ...createValidMessageData(),
          title: "a".repeat(201),
        });
        const error = message.validateSync();
        expect(error?.errors?.title?.message).toBe(
          "Title cannot exceed 200 characters"
        );
      });

      it("should validate content length", () => {
        const message = new Message({
          ...createValidMessageData(),
          content: "a".repeat(5001),
        });
        const error = message.validateSync();
        expect(error?.errors?.content?.message).toBe(
          "Content cannot exceed 5000 characters"
        );
      });
    });

    describe("Enum Validations", () => {
      it("should accept valid type values", () => {
        const validTypes = [
          "announcement",
          "maintenance",
          "update",
          "warning",
          "auth_level_change",
          "atcloud_role_change",
          "event_role_change",
        ];

        validTypes.forEach((type) => {
          const message = new Message({
            ...createValidMessageData(),
            type: type as any,
          });
          const error = message.validateSync();
          expect(error?.errors?.type).toBeUndefined();
        });
      });

      it("should reject invalid type values", () => {
        const message = new Message({
          ...createValidMessageData(),
          type: "invalid_type" as any,
        });
        const error = message.validateSync();
        expect(error?.errors?.type?.message).toContain(
          "is not a valid enum value"
        );
      });

      it("should accept valid priority values", () => {
        const validPriorities = ["low", "medium", "high"];

        validPriorities.forEach((priority) => {
          const message = new Message({
            ...createValidMessageData(),
            priority: priority as any,
          });
          const error = message.validateSync();
          expect(error?.errors?.priority).toBeUndefined();
        });
      });

      it("should reject invalid priority values", () => {
        const message = new Message({
          ...createValidMessageData(),
          priority: "invalid_priority" as any,
        });
        const error = message.validateSync();
        expect(error?.errors?.priority?.message).toContain(
          "is not a valid enum value"
        );
      });

      it("should validate creator gender enum", () => {
        const message = new Message({
          ...createValidMessageData(),
          creator: {
            ...createValidMessageData().creator,
            gender: "invalid" as any,
          },
        });
        const error = message.validateSync();
        expect(error?.errors?.["creator.gender"]?.message).toContain(
          "is not a valid enum value"
        );
      });
    });
  });

  describe("Default Values", () => {
    it("should set default values correctly", () => {
      const message = new Message(createValidMessageData());

      expect(message.type).toBe("announcement");
      expect(message.priority).toBe("medium");
      expect(message.isActive).toBe(true);
      expect(message.userStates).toBeInstanceOf(Map);
      expect(message.userStates.size).toBe(0);
    });
  });

  describe("Instance Methods", () => {
    let message: IMessage;
    const userId = "user123";

    beforeEach(() => {
      message = new Message(createValidMessageData());
      message.userStates.set(userId, {
        isReadInBell: false,
        isRemovedFromBell: false,
        isReadInSystem: false,
        isDeletedFromSystem: false,
      });
      message.markModified = vi.fn();
    });

    describe("getUserState", () => {
      it("should return default state for non-existent user", () => {
        const state = message.getUserState("non-recipient");

        expect(state).toEqual({
          isReadInBell: false,
          isRemovedFromBell: false,
          isReadInSystem: false,
          isDeletedFromSystem: false,
          readInBellAt: undefined,
          readInSystemAt: undefined,
          removedFromBellAt: undefined,
          deletedFromSystemAt: undefined,
          lastInteractionAt: undefined,
        });
      });

      it("should return existing state for user", () => {
        const testState = {
          isReadInBell: true,
          isRemovedFromBell: false,
          isReadInSystem: true,
          isDeletedFromSystem: false,
          readInBellAt: new Date(),
          readInSystemAt: new Date(),
        };

        message.userStates.set(userId, testState);
        const state = message.getUserState(userId);

        expect(state.isReadInBell).toBe(true);
        expect(state.isReadInSystem).toBe(true);
      });
    });

    describe("updateUserState", () => {
      it("should update user state and mark as modified", () => {
        const updates = { isReadInBell: true };

        message.updateUserState(userId, updates);

        const state = message.getUserState(userId);
        expect(state.isReadInBell).toBe(true);
        expect(state.lastInteractionAt).toBeInstanceOf(Date);
        expect(message.markModified).toHaveBeenCalledWith("userStates");
      });

      it("should merge with existing state", () => {
        message.userStates.set(userId, {
          isReadInBell: true,
          isRemovedFromBell: false,
          isReadInSystem: false,
          isDeletedFromSystem: false,
        });

        message.updateUserState(userId, { isReadInSystem: true });

        const state = message.getUserState(userId);
        expect(state.isReadInBell).toBe(true);
        expect(state.isReadInSystem).toBe(true);
      });

      it("should reject updates for a user outside the recipient set", () => {
        expect(() =>
          message.updateUserState("non-recipient", { isReadInBell: true })
        ).toThrow(MessageRecipientStateNotFoundError);
        expect(message.userStates.has("non-recipient")).toBe(false);
        expect(message.markModified).not.toHaveBeenCalled();
      });
    });

    describe("markAsReadInBell", () => {
      it("should mark message as read in bell notifications", () => {
        message.markAsReadInBell(userId);

        const state = message.getUserState(userId);
        expect(state.isReadInBell).toBe(true);
        expect(state.readInBellAt).toBeInstanceOf(Date);
        expect(message.markModified).toHaveBeenCalledWith("userStates");
      });
    });

    describe("markAsReadInSystem", () => {
      it("should mark message as read in system messages", () => {
        message.markAsReadInSystem(userId);

        const state = message.getUserState(userId);
        expect(state.isReadInSystem).toBe(true);
        expect(state.readInSystemAt).toBeInstanceOf(Date);
        expect(message.markModified).toHaveBeenCalledWith("userStates");
      });
    });

    describe("markAsReadEverywhere", () => {
      it("should mark message as read in both bell and system", () => {
        message.markAsReadEverywhere(userId);

        const state = message.getUserState(userId);
        expect(state.isReadInBell).toBe(true);
        expect(state.isReadInSystem).toBe(true);
        expect(state.readInBellAt).toBeInstanceOf(Date);
        expect(state.readInSystemAt).toBeInstanceOf(Date);
      });
    });

    describe("removeFromBell", () => {
      it("should remove message from bell notifications", () => {
        message.removeFromBell(userId);

        const state = message.getUserState(userId);
        expect(state.isRemovedFromBell).toBe(true);
        expect(state.removedFromBellAt).toBeInstanceOf(Date);
      });
    });

    describe("deleteFromSystem", () => {
      it("should delete message from system and auto-remove from bell", () => {
        message.deleteFromSystem(userId);

        const state = message.getUserState(userId);
        expect(state.isDeletedFromSystem).toBe(true);
        expect(state.isRemovedFromBell).toBe(true);
        expect(state.deletedFromSystemAt).toBeInstanceOf(Date);
        expect(state.removedFromBellAt).toBeInstanceOf(Date);
      });
    });

    describe("shouldShowInBell", () => {
      it("should return true for active message not removed from bell", () => {
        message.isActive = true;
        expect(message.shouldShowInBell(userId, "Participant")).toBe(true);
      });

      it("should return false for inactive message", () => {
        message.isActive = false;
        expect(message.shouldShowInBell(userId, "Participant")).toBe(false);
      });

      it("should return false for message removed from bell", () => {
        message.isActive = true;
        message.removeFromBell(userId);
        expect(message.shouldShowInBell(userId, "Participant")).toBe(false);
      });

      it("should return false for a user outside the recipient set", () => {
        message.isActive = true;
        expect(
          message.shouldShowInBell("non-recipient", "Participant")
        ).toBe(false);
      });

      it("should return false when the recipient no longer matches targetRoles", () => {
        message.isActive = true;
        message.targetRoles = ["Administrator"];
        expect(message.shouldShowInBell(userId, "Participant")).toBe(false);
      });

      it.each([null, [null, "Administrator"]])(
        "should fail closed for malformed targetRoles %j",
        (targetRoles) => {
          message.isActive = true;
          (message as unknown as { targetRoles: unknown }).targetRoles =
            targetRoles;

          expect(message.shouldShowInBell(userId, "Participant")).toBe(false);
        },
      );
    });

    describe("shouldShowInSystem", () => {
      it("should return true for active message not deleted from system", () => {
        message.isActive = true;
        expect(message.shouldShowInSystem(userId, "Participant")).toBe(true);
      });

      it("should return false for inactive message", () => {
        message.isActive = false;
        expect(message.shouldShowInSystem(userId, "Participant")).toBe(false);
      });

      it("should return false for message deleted from system", () => {
        message.isActive = true;
        message.deleteFromSystem(userId);
        expect(message.shouldShowInSystem(userId, "Participant")).toBe(false);
      });

      it("should return false for a user outside the recipient set", () => {
        message.isActive = true;
        expect(
          message.shouldShowInSystem("non-recipient", "Participant")
        ).toBe(false);
      });

      it("should return false when the recipient no longer matches targetRoles", () => {
        message.isActive = true;
        message.targetRoles = ["Administrator"];
        expect(message.shouldShowInSystem(userId, "Participant")).toBe(false);
      });

      it.each([null, [null, "Administrator"]])(
        "should fail closed for malformed targetRoles %j",
        (targetRoles) => {
          message.isActive = true;
          (message as unknown as { targetRoles: unknown }).targetRoles =
            targetRoles;

          expect(message.shouldShowInSystem(userId, "Participant")).toBe(false);
        },
      );
    });

    describe("getBellDisplayTitle", () => {
      it("should return the message title", () => {
        expect(message.getBellDisplayTitle()).toBe(message.title);
      });
    });

    describe("canRemoveFromBell", () => {
      it("should return true for read message not yet removed", () => {
        message.markAsReadInBell(userId);
        expect(message.canRemoveFromBell(userId)).toBe(true);
      });

      it("should return false for unread message", () => {
        expect(message.canRemoveFromBell(userId)).toBe(false);
      });

      it("should return false for already removed message", () => {
        message.markAsReadInBell(userId);
        message.removeFromBell(userId);
        expect(message.canRemoveFromBell(userId)).toBe(false);
      });
    });
  });

  describe("JSON Transformation", () => {
    it("should omit recipient and targeting internals from JSON", () => {
      const message = new Message({
        ...createValidMessageData(),
        targetRoles: ["Participant"],
        targetUserId: "user123",
      });
      const userId = "user123";

      message.userStates.set(userId, {
        isReadInBell: false,
        isRemovedFromBell: false,
        isReadInSystem: false,
        isDeletedFromSystem: false,
      });
      message.markAsReadInBell(userId);
      const json = message.toJSON();

      expect(json).not.toHaveProperty("userStates");
      expect(json).not.toHaveProperty("targetRoles");
      expect(json).not.toHaveProperty("createdBy");
      expect(json).not.toHaveProperty("targetUserId");
    });

    it("should convert userStates Map to Object in toObject", () => {
      const message = new Message(createValidMessageData());
      const userId = "user123";

      message.userStates.set(userId, {
        isReadInBell: false,
        isRemovedFromBell: false,
        isReadInSystem: false,
        isDeletedFromSystem: false,
      });
      message.markAsReadInBell(userId);
      const obj = message.toObject();

      expect(obj.userStates).not.toBeInstanceOf(Map);
      expect(typeof obj.userStates).toBe("object");
      expect(obj.userStates[userId]).toBeDefined();
    });

    it("should hide creator in JSON when hideCreator is true", () => {
      const message = new Message({
        ...createValidMessageData(),
        hideCreator: true,
      });
      const json = message.toJSON();

      expect(json.hideCreator).toBe(true);
      expect(json.creator).toBeUndefined();
    });

    it("should include creator in JSON when hideCreator is false or undefined", () => {
      const message = new Message({
        ...createValidMessageData(),
        hideCreator: false,
      });
      const json = message.toJSON();

      expect(json.creator).toBeDefined();
      expect(json.creator.firstName).toBe("John");
    });
  });

  describe("Static Methods", () => {
    describe("getBellNotificationsForUser", () => {
      it("returns mapped bell notifications with showRemoveButton", async () => {
        const userId = "u1";
        const now = new Date();
        const doc: any = new Message(createValidMessageData());
        doc.isActive = true;
        doc.createdAt = now as any;
        doc.userStates = new Map([
          [
            userId,
            { isReadInBell: true, isRemovedFromBell: false, readInBellAt: now },
          ],
        ]);
        // Ensure instance methods behave
        doc.markAsReadInBell(userId);

        // Mock underlying query chain
        const findSpy = vi.spyOn(Message as any, "find").mockReturnValue({
          sort: vi.fn().mockResolvedValue([doc]),
        } as any);

        const result = await (Message as any).getBellNotificationsForUser(
          userId,
          "Participant"
        );

        expect(findSpy).toHaveBeenCalledWith({
          isActive: true,
          [`userStates.${userId}`]: { $exists: true },
          [`userStates.${userId}.isRemovedFromBell`]: { $ne: true },
          $or: [
            { targetRoles: { $exists: false } },
            { targetRoles: { $size: 0 } },
            { targetRoles: "Participant" },
          ],
        });
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(
          expect.objectContaining({
            isRead: true,
            showRemoveButton: true,
            title: doc.title,
          })
        );
      });
    });

    describe("getSystemMessagesForUser", () => {
      it("paginates and maps system messages, computes hasNext/hasPrev", async () => {
        const userId = "u1";
        const doc: any = new Message(createValidMessageData());
        doc.userStates = new Map([[userId, { isReadInSystem: false }]]);

        const sort = vi.fn().mockReturnValue({
          skip: vi
            .fn()
            .mockReturnValue({ limit: vi.fn().mockResolvedValue([doc]) }),
        });
        vi.spyOn(Message as any, "find").mockReturnValue({ sort } as any);
        vi.spyOn(Message as any, "countDocuments").mockResolvedValue(3);

        const { messages, pagination } = await (
          Message as any
        ).getSystemMessagesForUser(userId, "Participant", 1, 1);

        const recipientFilter = {
          isActive: true,
          [`userStates.${userId}`]: { $exists: true },
          [`userStates.${userId}.isDeletedFromSystem`]: { $ne: true },
          $or: [
            { targetRoles: { $exists: false } },
            { targetRoles: { $size: 0 } },
            { targetRoles: "Participant" },
          ],
        };
        expect(Message.find).toHaveBeenCalledWith(recipientFilter);
        expect(Message.countDocuments).toHaveBeenCalledWith(recipientFilter);
        expect(messages).toHaveLength(1);
        expect(pagination).toEqual(
          expect.objectContaining({
            currentPage: 1,
            totalPages: 3,
            hasNext: true,
            hasPrev: false,
          })
        );
      });
    });

    describe("getUnreadCountsForUser", () => {
      it("sums unread counts and returns total driven by bell notifications", async () => {
        const userId = "u1";
        const countSpy = vi
          .spyOn(Message as any, "countDocuments")
          .mockResolvedValueOnce(2) // bell
          .mockResolvedValueOnce(5); // system

        const res = await (Message as any).getUnreadCountsForUser(
          userId,
          "Participant"
        );
        expect(countSpy).toHaveBeenCalledTimes(2);
        expect(countSpy).toHaveBeenNthCalledWith(1, {
          isActive: true,
          [`userStates.${userId}`]: { $exists: true },
          [`userStates.${userId}.isRemovedFromBell`]: { $ne: true },
          [`userStates.${userId}.isReadInBell`]: { $ne: true },
          $or: [
            { targetRoles: { $exists: false } },
            { targetRoles: { $size: 0 } },
            { targetRoles: "Participant" },
          ],
        });
        expect(countSpy).toHaveBeenNthCalledWith(2, {
          isActive: true,
          [`userStates.${userId}`]: { $exists: true },
          [`userStates.${userId}.isDeletedFromSystem`]: { $ne: true },
          [`userStates.${userId}.isReadInSystem`]: { $ne: true },
          $or: [
            { targetRoles: { $exists: false } },
            { targetRoles: { $size: 0 } },
            { targetRoles: "Participant" },
          ],
        });
        expect(res).toEqual({
          bellNotifications: 2,
          systemMessages: 5,
          total: 2,
        });
      });
    });

    describe("creation statics", () => {
      it("createForAllUsers initializes all user states and saves", async () => {
        const userIds = ["u1", "u2"];
        const saveSpy = vi.fn().mockResolvedValue(undefined);
        const ctorSpy = vi.spyOn(Message as any, "constructor");
        // Intercept instance to inject save stub
        const original = Message as any;
        const messageInstance: any = new original(createValidMessageData());
        const instSpy = vi
          .spyOn(original.prototype as any, "save")
          .mockImplementation(saveSpy);

        const msg = await (Message as any).createForAllUsers(
          createValidMessageData(),
          userIds
        );

        expect(ctorSpy).toBeDefined();
        expect(instSpy).toHaveBeenCalled();
        expect(msg.userStates).toBeInstanceOf(Map);
        expect(msg.userStates.size).toBe(2);
      });

      it("createForSpecificUser initializes single user state and saves", async () => {
        const userId = "u1";
        const saveSpy = vi
          .spyOn((Message as any).prototype, "save")
          .mockResolvedValue(undefined as any);

        const msg = await (Message as any).createForSpecificUser(
          createValidMessageData(),
          userId
        );

        expect(msg.userStates).toBeInstanceOf(Map);
        expect(msg.userStates.size).toBe(1);
        expect(saveSpy).toHaveBeenCalled();
      });
    });
  });

  describe("Method Existence Tests", () => {
    it("should have getUserState method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.getUserState).toBe("function");
    });

    it("should have updateUserState method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.updateUserState).toBe("function");
    });

    it("should have markAsReadInBell method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.markAsReadInBell).toBe("function");
    });

    it("should have markAsReadInSystem method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.markAsReadInSystem).toBe("function");
    });

    it("should have markAsReadEverywhere method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.markAsReadEverywhere).toBe("function");
    });

    it("should have removeFromBell method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.removeFromBell).toBe("function");
    });

    it("should have deleteFromSystem method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.deleteFromSystem).toBe("function");
    });

    it("should have shouldShowInBell method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.shouldShowInBell).toBe("function");
    });

    it("should have shouldShowInSystem method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.shouldShowInSystem).toBe("function");
    });

    it("should have getBellDisplayTitle method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.getBellDisplayTitle).toBe("function");
    });

    it("should have canRemoveFromBell method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.canRemoveFromBell).toBe("function");
    });

    it("should have toJSON method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.toJSON).toBe("function");
    });

    it("should have validateSync method", () => {
      const message = new Message(createValidMessageData());
      expect(typeof message.validateSync).toBe("function");
    });
  });

  describe("Optional Fields", () => {
    it("should accept targetRoles array", () => {
      const message = new Message({
        ...createValidMessageData(),
        targetRoles: ["Administrator", "Leader"],
      });
      const error = message.validateSync();
      expect(error).toBeFalsy();
      expect(message.targetRoles).toEqual(["Administrator", "Leader"]);
    });

    it("should accept targetUserId", () => {
      const message = new Message({
        ...createValidMessageData(),
        targetUserId: "specific_user_123",
      });
      const error = message.validateSync();
      expect(error).toBeFalsy();
      expect(message.targetUserId).toBe("specific_user_123");
    });

    it("should accept expiresAt date", () => {
      const expireDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
      const message = new Message({
        ...createValidMessageData(),
        expiresAt: expireDate,
      });
      const error = message.validateSync();
      expect(error).toBeFalsy();
      expect(message.expiresAt).toEqual(expireDate);
    });
  });
});
