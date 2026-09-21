import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logSafeErrorEvent,
  logSafeWarningEvent,
} from "../../../src/utils/safeEventLogger";

describe("safeEventLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never serializes an error message, email, token, or provider payload", () => {
    const canaryEmail = "canary+private@example.test";
    const canaryToken = "provider-token-canary-value";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    logSafeErrorEvent(
      "AUTH_PROVIDER_FAILED",
      new Error(`${canaryEmail} ${canaryToken}`),
      "507f1f77bcf86cd799439011",
    );

    const output = JSON.stringify(consoleError.mock.calls);
    expect(output).not.toContain(canaryEmail);
    expect(output).not.toContain(canaryToken);
    expect(output).toContain("AUTH_PROVIDER_FAILED");
    expect(output).toContain("507f1f77bcf86cd799439011");
    expect(output).toContain("Error");
  });

  it("replaces attacker-controlled event, user, and error names", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostileError = { name: "Bad\nprovider-secret" };

    logSafeWarningEvent(
      "bad event code",
      hostileError,
      "victim@example.test",
    );

    expect(consoleWarn).toHaveBeenCalledWith(
      "Application operation degraded",
      {
        eventCode: "APPLICATION_OPERATION_FAILED",
        errorName: "UnknownError",
      },
    );
  });
});
