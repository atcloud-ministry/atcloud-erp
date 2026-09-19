import { describe, expect, it } from "vitest";
import { isTokenCurrentForPasswordChange } from "../../../src/utils/tokenRevocation";

describe("tokenRevocation", () => {
  const changedAt = new Date("2026-09-18T12:00:00.750Z");
  const changedSecond = Math.floor(changedAt.getTime() / 1_000);

  it("revokes a token issued in an earlier second", () => {
    expect(
      isTokenCurrentForPasswordChange(
        { iat: changedSecond - 1 },
        { passwordChangedAt: changedAt },
      ),
    ).toBe(false);
  });

  it("revokes a token at the ambiguous JWT same-second precision boundary", () => {
    expect(
      isTokenCurrentForPasswordChange(
        { iat: changedSecond },
        { passwordChangedAt: changedAt },
      ),
    ).toBe(false);
  });

  it("accepts a token issued in a later second", () => {
    expect(
      isTokenCurrentForPasswordChange(
        { iat: changedSecond + 1 },
        { passwordChangedAt: changedAt },
      ),
    ).toBe(true);
  });

  it("fails closed on a missing iat only when a password-change marker exists", () => {
    expect(
      isTokenCurrentForPasswordChange({}, { passwordChangedAt: changedAt }),
    ).toBe(false);
    expect(isTokenCurrentForPasswordChange({}, {})).toBe(true);
  });
});
