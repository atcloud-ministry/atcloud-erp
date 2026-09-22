import { describe, expect, it } from "vitest";
import { isSchedulerEnabled } from "../../../src/config/scheduler";

describe("isSchedulerEnabled", () => {
  it("requires an explicit opt-in in production", () => {
    expect(isSchedulerEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      isSchedulerEnabled({
        NODE_ENV: "production",
        SCHEDULER_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      isSchedulerEnabled({
        NODE_ENV: "production",
        SCHEDULER_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("keeps development opt-out behavior", () => {
    expect(isSchedulerEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(
      isSchedulerEnabled({
        NODE_ENV: "development",
        SCHEDULER_ENABLED: "false",
      }),
    ).toBe(false);
  });

  it("never starts automatically in tests", () => {
    expect(
      isSchedulerEnabled({ NODE_ENV: "test", SCHEDULER_ENABLED: "true" }),
    ).toBe(false);
  });
});
