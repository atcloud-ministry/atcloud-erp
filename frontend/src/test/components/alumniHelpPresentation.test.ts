import { describe, expect, it } from "vitest";
import {
  OUTCOME_LABELS,
  outcomeOptions,
} from "../../components/alumniHelp/presentation";

describe("Alumni Help result labels", () => {
  it("exposes the seven approved type-specific result choices", () => {
    expect(outcomeOptions("career_advice")).toEqual([
      {
        value: "not_fulfilled",
        label: "Career Advice did not take place",
      },
      { value: "completed", label: "Career Advice completed" },
    ]);
    expect(outcomeOptions("warm_introduction")).toEqual([
      {
        value: "not_fulfilled",
        label: "Warm Introduction did not take place",
      },
      { value: "completed", label: "Warm Introduction completed" },
    ]);
    expect(outcomeOptions("formal_employee_referral")).toHaveLength(3);
    expect(
      Object.values(OUTCOME_LABELS).flatMap((labels) =>
        Object.values(labels),
      ),
    ).toHaveLength(7);
  });
});
