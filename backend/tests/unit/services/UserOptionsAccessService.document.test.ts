import { describe, expect, it } from "vitest";
import { User } from "../../../src/models";
import { UserOptionsAccessService } from "../../../src/services/UserOptionsAccessService";

describe("UserOptionsAccessService Mongoose document compatibility", () => {
  it("reads identity fields from a hydrated User without object spreading", async () => {
    const user = new User({
      username: "hydrated-leader",
      email: "hydrated-leader@example.com",
      firstName: "Hydrated",
      lastName: "Leader",
      password: "not-used-by-this-test",
      role: "Leader",
      isActive: true,
      isVerified: true,
    });

    await expect(
      UserOptionsAccessService.assertCanRead(
        { context: "event-organizer", page: 1, limit: 20 },
        user,
      ),
    ).resolves.toBeUndefined();
  });
});
