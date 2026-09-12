import { describe, it, expect, beforeEach, vi } from "vitest";
import { socketService } from "../../../../src/services/infrastructure/SocketService";

vi.mock("../../../../src/services/authorization/AuthorizationAuditService", () => ({
  recordAuthorizationDenial: vi.fn(),
}));

describe("SocketService payload schema", () => {
  let mockIO: any;
  const eventId = "507f1f77bcf86cd799439013";

  beforeEach(() => {
    // Reset singleton internal state
    (socketService as any).authenticatedSockets = new Map();
    (socketService as any).userSockets = new Map();
    (socketService as any).resourceAuthorizationRevisions = new Map();
    (socketService as any).eventJoinGuards = new Map();

    mockIO = {
      emit: vi.fn(),
      to: vi.fn().mockReturnThis(),
      except: vi.fn().mockReturnThis(),
    };
    (socketService as any).io = mockIO;
  });

  const isISODateString = (value: string) => !Number.isNaN(Date.parse(value));

  it("emits system_message_update with expected shape", () => {
    socketService.emitSystemMessageUpdate("user-1", "system:test", { foo: 1 });

    expect(mockIO.to).toHaveBeenCalledWith("user:user-1");
    const [eventName, payload] =
      mockIO.to.mock.results[0].value.emit.mock.calls[0];

    expect(eventName).toBe("system_message_update");
    expect(payload).toMatchObject({ event: "system:test", data: { foo: 1 } });
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("emits unread_count_update with expected shape", () => {
    const counts = { bellNotifications: 2, systemMessages: 3, total: 5 };
    socketService.emitUnreadCountUpdate("user-2", counts);

    expect(mockIO.to).toHaveBeenCalledWith("user:user-2");
    const [eventName, payload] =
      mockIO.to.mock.results[0].value.emit.mock.calls[0];

    expect(eventName).toBe("unread_count_update");
    expect(payload.counts).toEqual(counts);
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("emits a minimal alumni_help_update only to the canonical user room", () => {
    const userId = "507F1F77BCF86CD799439011";
    socketService.emitAlumniHelpUpdate(userId, {
      requestId: "507F1F77BCF86CD799439012",
      requestRevision: 4,
      helpActionRequiredCount: 2,
    });

    expect(mockIO.to).toHaveBeenCalledWith(
      "user:507f1f77bcf86cd799439011",
    );
    expect(mockIO.emit).toHaveBeenCalledWith("alumni_help_update", {
      requestId: "507f1f77bcf86cd799439012",
      requestRevision: 4,
      helpActionRequiredCount: 2,
      timestamp: expect.any(String),
    });
  });

  it("refuses an invalid alumni_help_update without selecting a room", () => {
    socketService.emitAlumniHelpUpdate("not-a-user", {
      requestId: eventId,
      requestRevision: 1,
      helpActionRequiredCount: 1,
    });
    expect(mockIO.to).not.toHaveBeenCalled();
    expect(mockIO.emit).not.toHaveBeenCalled();
  });

  it("emits event_update only to the authorized event room", () => {
    const data = { bar: 2 };
    socketService.emitEventUpdate(eventId, "guest_updated", data);

    // The authorized room receives only an invalidation; caller-specific data
    // is never placed on the socket transport.
    const [roomEventName, roomPayload] = mockIO.emit.mock.calls[0];
    expect(roomEventName).toBe("event_update");
    expect(roomPayload).toMatchObject({
      eventId,
      updateType: "guest_updated",
      data: null,
    });
    expect(typeof roomPayload.timestamp).toBe("string");
    expect(isISODateString(roomPayload.timestamp)).toBe(true);

    expect(mockIO.to).toHaveBeenCalledWith(`event:${eventId}`);
    expect(mockIO.except).not.toHaveBeenCalled();
    expect(mockIO.emit).toHaveBeenCalledTimes(1);
  });

  it("emits event_room_update to the event room with expected shape", () => {
    const data = { baz: 3 };
    socketService.emitEventRoomUpdate(eventId, "guest_registration", data);

    expect(mockIO.to).toHaveBeenCalledWith(`event:${eventId}`);
    const [eventName, payload] =
      mockIO.to.mock.results[0].value.emit.mock.calls[0];
    expect(eventName).toBe("event_room_update");
    expect(payload).toMatchObject({
      eventId,
      updateType: "guest_registration",
      data: null,
    });
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("emits role_full update type with minimal payload", () => {
    const data = { roleId: "r1" };
    socketService.emitEventUpdate(eventId, "role_full", data);

    const [eventName, payload] = (mockIO.emit as any).mock.calls[0];
    expect(eventName).toBe("event_update");
    expect(payload).toMatchObject({
      eventId,
      updateType: "role_full",
      data: null,
    });
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("emits role_available update type with minimal payload", () => {
    const data = { roleId: "r2" };
    socketService.emitEventUpdate(eventId, "role_available" as any, data);

    const [eventName, payload] = (mockIO.emit as any).mock.calls[0];
    expect(eventName).toBe("event_update");
    expect(payload).toMatchObject({
      eventId,
      updateType: "role_available",
      data: null,
    });
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("emits role_available via emitEventUpdate to the event room with expected shape", () => {
    const data = { roleId: "r9" };
    socketService.emitEventUpdate(eventId, "role_available" as any, data);

    // Room emit should be invoked for the event
    expect(mockIO.to).toHaveBeenCalledWith(`event:${eventId}`);
    const [roomEventName, roomPayload] =
      mockIO.to.mock.results[0].value.emit.mock.calls[0];
    expect(roomEventName).toBe("event_update");
    expect(roomPayload).toMatchObject({
      eventId,
      updateType: "role_available",
      data: null,
    });
    expect(typeof roomPayload.timestamp).toBe("string");
    expect(isISODateString(roomPayload.timestamp)).toBe(true);
  });

  it("does not expose a user_moved payload or inline event snapshot", () => {
    const eventSnapshot = { id: "evt-4", title: "Event Title" };
    const data = {
      userId: "u1",
      fromRoleId: "r1",
      toRoleId: "r2",
      fromRoleName: "Role A",
      toRoleName: "Role B",
      event: eventSnapshot,
    };

    socketService.emitEventUpdate(eventId, "user_moved", data);

    const [eventName, payload] = (mockIO.emit as any).mock.calls[0];
    expect(eventName).toBe("event_update");
    expect(payload.updateType).toBe("user_moved");
    expect(payload.eventId).toBe(eventId);
    expect(payload.data).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Event Title");
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("does not expose guest contact context or an inline event snapshot", () => {
    const eventSnapshot = { id: "evt-5", title: "Moved Event" };
    const data = {
      fromRoleId: "r1",
      toRoleId: "r2",
      fromRoleName: "Role A",
      toRoleName: "Role B",
      guestName: "Alpha Guest",
      event: eventSnapshot,
    };

    socketService.emitEventUpdate(eventId, "guest_moved" as any, data);

    const [eventName, payload] = (mockIO.emit as any).mock.calls[0];
    expect(eventName).toBe("event_update");
    expect(payload.updateType).toBe("guest_moved");
    expect(payload.eventId).toBe(eventId);
    expect(payload.data).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Alpha Guest");
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("does not expose a user assignment payload or inline snapshot", () => {
    const eventSnapshot = { id: "evt-6", title: "Assigned Event" };
    const data = {
      operatorId: "admin",
      userId: "u1",
      roleId: "r1",
      roleName: "Role A",
      event: eventSnapshot,
    };

    socketService.emitEventUpdate(eventId, "user_assigned" as any, data);

    const [eventName, payload] = (mockIO.emit as any).mock.calls[0];
    expect(eventName).toBe("event_update");
    expect(payload.updateType).toBe("user_assigned");
    expect(payload.eventId).toBe(eventId);
    expect(payload.data).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("admin");
    expect(typeof payload.timestamp).toBe("string");
    expect(isISODateString(payload.timestamp)).toBe(true);
  });

  it("canonicalizes event ids before selecting a room", () => {
    socketService.emitEventUpdate(eventId.toUpperCase(), "guest_updated", {});

    expect(mockIO.to).toHaveBeenCalledWith(`event:${eventId}`);
    expect(mockIO.emit).toHaveBeenCalledWith(
      "event_update",
      expect.objectContaining({ eventId }),
    );
  });

  it("rejects an invalid event id without emitting", () => {
    socketService.emitEventUpdate("../admin", "guest_updated", {});
    socketService.emitEventRoomUpdate("../admin", "guest_updated", {});

    expect(mockIO.to).not.toHaveBeenCalled();
    expect(mockIO.emit).not.toHaveBeenCalled();
  });
});
