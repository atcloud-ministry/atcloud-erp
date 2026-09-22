import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../../src/models", () => ({
  User: { find: vi.fn(), countDocuments: vi.fn() },
  Event: { find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock("../../../src/utils/roleUtils", () => ({
  ROLES: {
    SUPER_ADMIN: "Super Admin",
    ADMINISTRATOR: "Administrator",
    LEADER: "Leader",
    GUEST_EXPERT: "Guest Expert",
    PARTICIPANT: "Participant",
  },
}));
vi.mock("../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: { getSearchResults: vi.fn() },
}));

import { SearchController } from "../../../src/controllers/searchController";
import { Event, User } from "../../../src/models";
import { CachePatterns } from "../../../src/services/infrastructure/CacheService";

describe("SearchController", () => {
  let userQuery: Record<string, ReturnType<typeof vi.fn>>;
  let eventQuery: Record<string, ReturnType<typeof vi.fn>>;
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  let response: Response;

  beforeEach(() => {
    vi.clearAllMocks();
    userQuery = makeQuery([]);
    eventQuery = makeQuery([]);
    vi.mocked(User.find).mockReturnValue(userQuery as any);
    vi.mocked(Event.find).mockReturnValue(eventQuery as any);
    vi.mocked(User.countDocuments).mockResolvedValue(0);
    vi.mocked(Event.countDocuments).mockResolvedValue(0);
    vi.mocked(CachePatterns.getSearchResults).mockImplementation(
      async (_key, callback) => callback(),
    );
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    response = { status, json } as unknown as Response;
  });

  function makeQuery(result: unknown[]) {
    return {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(result),
    };
  }

  function request(query: Record<string, unknown>, authenticated = true) {
    return {
      query,
      user: authenticated
        ? { _id: "user-1", id: "user-1", role: "Administrator" }
        : undefined,
    } as unknown as Request;
  }

  it.each([
    [SearchController.searchUsers],
    [SearchController.searchEvents],
    [SearchController.globalSearch],
  ])("requires authentication", async (handler) => {
    await handler(request({ q: "search" }, false), response);
    expect(status).toHaveBeenCalledWith(401);
  });

  it.each([
    [SearchController.searchUsers],
    [SearchController.searchEvents],
    [SearchController.globalSearch],
  ])("rejects empty search text", async (handler) => {
    await handler(request({ q: "   " }), response);
    expect(status).toHaveBeenCalledWith(400);
  });

  it("uses the user text index, escaped filters, explicit projection, and bounded pagination", async () => {
    userQuery.lean.mockResolvedValue([
      { _id: "user-2", username: "john", firstName: "John" },
    ]);
    vi.mocked(User.countDocuments).mockResolvedValue(1);

    await SearchController.searchUsers(
      request({
        q: "  john.*  ",
        weeklyChurch: "Cloud (West).*",
        page: "2",
        limit: "1000",
      }),
      response,
    );

    expect(User.find).toHaveBeenCalledWith({
      isActive: true,
      $text: { $search: '"john.*"' },
      weeklyChurch: {
        $regex: "Cloud \\(West\\)\\.\\*",
        $options: "i",
      },
    });
    expect(userQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("email"),
    );
    expect(userQuery.limit).toHaveBeenCalledWith(100);
    expect(userQuery.skip).toHaveBeenCalledWith(100);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          users: [expect.objectContaining({ id: "user-2" })],
        }),
      }),
    );
  });

  it("uses the account-management DTO projection for legacy user search", async () => {
    await SearchController.searchUsers(request({ q: "john" }), response);

    expect(userQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("email"),
    );
  });

  it("escapes event search input and uses string-based event dates", async () => {
    await SearchController.searchEvents(
      request({
        q: "service",
        status: "upcoming",
        dateFrom: "2026-08-01T12:00:00Z",
        dateTo: "2026-09-01T12:00:00Z",
      }),
      response,
    );

    expect(Event.find).toHaveBeenCalledWith({
      $or: [
        { title: { $regex: "service", $options: "i" } },
        { description: { $regex: "service", $options: "i" } },
        { location: { $regex: "service", $options: "i" } },
        { organizer: { $regex: "service", $options: "i" } },
        { purpose: { $regex: "service", $options: "i" } },
        { type: { $regex: "service", $options: "i" } },
      ],
      date: { $gte: "2026-08-01", $lte: "2026-09-01" },
    });
    expect(eventQuery.select).toHaveBeenCalledOnce();
    expect(eventQuery.sort).toHaveBeenCalledWith({
      date: -1,
      time: -1,
      _id: -1,
    });
  });

  it("keeps global user search and response within community-visible fields", async () => {
    userQuery.lean.mockResolvedValue([
      {
        _id: "user-2",
        username: "john",
        email: "private@example.com",
        homeAddress: "Private",
      },
    ]);
    eventQuery.lean.mockResolvedValue([{ _id: "event-1", title: "John Talk" }]);

    await SearchController.globalSearch(
      request({ q: "john", limit: "500" }),
      response,
    );

    expect(User.find).toHaveBeenCalledWith({
      isActive: true,
      isVerified: true,
      $or: [
        { username: { $regex: "john", $options: "i" } },
        { firstName: { $regex: "john", $options: "i" } },
        { lastName: { $regex: "john", $options: "i" } },
        { roleInAtCloud: { $regex: "john", $options: "i" } },
      ],
    });
    expect(Event.find).toHaveBeenCalledWith({
      $or: [
        { title: { $regex: "john", $options: "i" } },
        { description: { $regex: "john", $options: "i" } },
        { location: { $regex: "john", $options: "i" } },
        { organizer: { $regex: "john", $options: "i" } },
        { type: { $regex: "john", $options: "i" } },
      ],
    });
    expect(userQuery.limit).toHaveBeenCalledWith(100);
    expect(eventQuery.limit).toHaveBeenCalledWith(100);
    expect(userQuery.select).toHaveBeenCalledWith(
      expect.not.stringContaining("email"),
    );
    const responseBody = json.mock.calls[0][0];
    expect(responseBody.data.users[0]).toEqual({
      id: "user-2",
      username: "john",
      firstName: null,
      lastName: null,
      avatar: null,
      gender: null,
      roleInAtCloud: null,
    });
    expect(responseBody.data.users[0]).not.toHaveProperty("email");
    expect(responseBody.data.totalResults).toBe(2);
  });

  it("returns a controlled error when the search cache fails", async () => {
    vi.mocked(CachePatterns.getSearchResults).mockRejectedValue(
      new Error("cache unavailable"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await SearchController.searchUsers(request({ q: "john" }), response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Failed to search users.",
    });
  });
});
