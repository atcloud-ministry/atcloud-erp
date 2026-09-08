import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/models", () => ({
  User: {
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
  },
}));

import { User } from "../../../src/models";
import { UserReadService } from "../../../src/services/UserReadService";

function queryResult(rows: unknown[]) {
  return {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
  };
}

describe("UserReadService privacy boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(User.countDocuments).mockResolvedValue(1);
  });

  it("searches Community only through fields present in CommunityMemberDTO", async () => {
    const query = queryResult([
      {
        _id: "member-1",
        username: "amy",
        email: "private@example.com",
        occupation: "Private occupation",
      },
    ]);
    vi.mocked(User.find).mockReturnValue(query as never);

    const result = await UserReadService.listCommunityMembers({
      page: 1,
      limit: 20,
      q: "private@example.com",
      sortBy: "firstName",
      sortOrder: "asc",
    });

    const filter = vi.mocked(User.find).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(filter).not.toHaveProperty("$text");
    expect(JSON.stringify(filter)).not.toContain("email");
    expect(JSON.stringify(filter)).not.toContain("occupation");
    expect(result.members[0]).not.toHaveProperty("email");
  });

  it("returns picker identities without private contact fields", async () => {
    const query = queryResult([
      {
        _id: "leader-1",
        username: "leader",
        role: "Leader",
        email: "private@example.com",
        phone: "555-0100",
      },
    ]);
    vi.mocked(User.find).mockReturnValue(query as never);

    const result = await UserReadService.listUserOptions({
      context: "program-mentor",
      page: 1,
      limit: 20,
      q: "leader",
    });

    expect(result.options[0]).not.toHaveProperty("email");
    expect(result.options[0]).not.toHaveProperty("phone");
    expect(query.select).toHaveBeenCalledWith(
      expect.not.stringContaining("email"),
    );
  });
});
