import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/models", () => ({
  Event: {
    find: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    invalidateResourceRoom: vi.fn(),
  },
}));

import { Event } from "../../../../src/models";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { ResourceAuthorizationInvalidationService } from "../../../../src/services/authorization/ResourceAuthorizationInvalidationService";

describe("ResourceAuthorizationInvalidationService", () => {
  const service = new ResourceAuthorizationInvalidationService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves unique event ids for valid affected programs", async () => {
    const lean = vi.fn().mockResolvedValue([
      { _id: "507f1f77bcf86cd799439021" },
      { _id: "507f1f77bcf86cd799439021" },
      { _id: "507f1f77bcf86cd799439022" },
    ]);
    const select = vi.fn().mockReturnValue({ lean });
    vi.mocked(Event.find).mockReturnValue({ select } as any);

    const result = await service.findEventIdsForPrograms([
      "507f1f77bcf86cd799439011",
      "invalid",
      "507f1f77bcf86cd799439011",
      { _id: "507f1f77bcf86cd799439012" },
    ]);

    const query = vi.mocked(Event.find).mock.calls[0][0] as {
      programLabels: { $in: unknown[] };
    };
    expect(query.programLabels.$in.map(String)).toEqual([
      "507f1f77bcf86cd799439011",
      "507f1f77bcf86cd799439012",
    ]);
    expect(result).toEqual([
      "507f1f77bcf86cd799439021",
      "507f1f77bcf86cd799439022",
    ]);
  });

  it("skips the database when no valid program id is supplied", async () => {
    await expect(
      service.findEventIdsForPrograms(["invalid", null]),
    ).resolves.toEqual([]);
    expect(Event.find).not.toHaveBeenCalled();
  });

  it("invalidates each unique event room", () => {
    service.invalidateEventRooms([
      "507f1f77bcf86cd799439021",
      "507f1f77bcf86cd799439021",
      "507f1f77bcf86cd799439022",
    ]);

    expect(socketService.invalidateResourceRoom).toHaveBeenCalledTimes(2);
    expect(socketService.invalidateResourceRoom).toHaveBeenNthCalledWith(
      1,
      "event",
      "507f1f77bcf86cd799439021",
    );
    expect(socketService.invalidateResourceRoom).toHaveBeenNthCalledWith(
      2,
      "event",
      "507f1f77bcf86cd799439022",
    );
  });
});
