import { describe, expect, it } from "vitest";
import {
  getProgramMentorUserId,
  toProgramMentorPayload,
  toProgramMentorPayloads,
} from "../../utils/programMentorPayload";

describe("program mentor identity payload", () => {
  it("sends only userId and never picker-derived profile/contact snapshots", () => {
    expect(
      toProgramMentorPayload({
        id: "mentor-1",
        firstName: "Amy",
        lastName: "Chen",
        email: "amy@example.com",
        gender: "female",
        avatar: "/amy.jpg",
        roleInAtCloud: "Mentor",
      }),
    ).toEqual({ userId: "mentor-1" });
  });

  it("normalizes populated IDs and drops entries without an identity", () => {
    expect(getProgramMentorUserId({ userId: { _id: "mentor-2" } })).toBe(
      "mentor-2",
    );
    expect(
      toProgramMentorPayloads([{ userId: "mentor-1" }, { firstName: "No ID" }]),
    ).toEqual([{ userId: "mentor-1" }]);
  });
});
