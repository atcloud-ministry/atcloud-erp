import { describe, expect, it } from "vitest";
import {
  adminUsersQuerySchema,
  communityMembersQuerySchema,
  RuntimeQueryValidationError,
  userOptionsQuerySchema,
} from "../../../src/contracts/userReadContracts";

describe("user read runtime query contracts", () => {
  it("normalizes canonical community defaults", () => {
    expect(communityMembersQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      q: undefined,
      sortBy: "firstName",
      sortOrder: "asc",
    });
  });

  it("rejects unknown parameters and over-large page sizes", () => {
    expect(() =>
      adminUsersQuerySchema.parse({ limit: "21", search: "private" }),
    ).toThrow(RuntimeQueryValidationError);
  });

  it("requires a concrete event for event role assignment", () => {
    expect(() =>
      userOptionsQuerySchema.parse({ context: "event-role-assignee" }),
    ).toThrowError(/Validation failed/);
  });

  it("accepts the three picker contexts and a valid resourceId", () => {
    const resourceId = "507f191e810c19729de860ea";
    expect(
      userOptionsQuerySchema.parse({
        context: "program-mentor",
        resourceId,
        page: "2",
        limit: "100",
      }),
    ).toMatchObject({
      context: "program-mentor",
      resourceId,
      page: 2,
      limit: 100,
    });
  });
});
