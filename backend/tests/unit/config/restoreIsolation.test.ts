import { describe, expect, it } from "vitest";
import {
  assertRestoreIsolationConfiguration,
  assertRestoreIsolationDatabase,
  assertWebRuntimeIsNotRestoreIsolation,
  getRestoreIsolationConfigurationIssues,
  RestoreIsolationConfigurationError,
  RestoreIsolationDatabaseError,
  RestoreIsolationWebRuntimeError,
  type RestoreIsolationEnvironment,
} from "../../../src/config/restoreIsolation";

const SAFE_RESTORE_ENVIRONMENT: RestoreIsolationEnvironment = {
  RESTORE_ISOLATION_MODE: "true",
  RESTORE_ISOLATION_DATABASE: "atcloud-restore-test",
  NOTIFICATION_OUTBOX_ENABLED: "false",
  SCHEDULER_ENABLED: "false",
  WEB_PUSH_ENABLED: "false",
  ALUMNI_NETWORK_RELEASE_AVAILABLE: "false",
};

describe("restore isolation configuration", () => {
  it("accepts only the explicit isolated restore environment", () => {
    expect(getRestoreIsolationConfigurationIssues(SAFE_RESTORE_ENVIRONMENT)).toEqual(
      [],
    );
    expect(() =>
      assertRestoreIsolationConfiguration(SAFE_RESTORE_ENVIRONMENT),
    ).not.toThrow();
  });

  it.each([
    ["RESTORE_ISOLATION_MODE", "false"],
    ["RESTORE_ISOLATION_DATABASE", "atcloud-production"],
    ["NOTIFICATION_OUTBOX_ENABLED", "true"],
    ["SCHEDULER_ENABLED", "true"],
    ["WEB_PUSH_ENABLED", "true"],
    ["ALUMNI_NETWORK_RELEASE_AVAILABLE", "true"],
  ] as const)("rejects %s=%s", (name, value) => {
    const environment = { ...SAFE_RESTORE_ENVIRONMENT, [name]: value };

    expect(getRestoreIsolationConfigurationIssues(environment)).toEqual([name]);
    expect(() => assertRestoreIsolationConfiguration(environment)).toThrow(
      RestoreIsolationConfigurationError,
    );
  });

  it("rejects missing or non-exact values instead of relying on defaults", () => {
    expect(getRestoreIsolationConfigurationIssues({})).toEqual([
      "RESTORE_ISOLATION_MODE",
      "RESTORE_ISOLATION_DATABASE",
      "NOTIFICATION_OUTBOX_ENABLED",
      "SCHEDULER_ENABLED",
      "WEB_PUSH_ENABLED",
      "ALUMNI_NETWORK_RELEASE_AVAILABLE",
    ]);
    expect(
      getRestoreIsolationConfigurationIssues({
        ...SAFE_RESTORE_ENVIRONMENT,
        SCHEDULER_ENABLED: "False",
        WEB_PUSH_ENABLED: "",
      }),
    ).toEqual(["SCHEDULER_ENABLED", "WEB_PUSH_ENABLED"]);
  });

  it("provides a stable error code and only the invalid variable names", () => {
    try {
      assertRestoreIsolationConfiguration({
        ...SAFE_RESTORE_ENVIRONMENT,
        NOTIFICATION_OUTBOX_ENABLED: "true",
        WEB_PUSH_ENABLED: "true",
      });
      throw new Error("Expected restore isolation configuration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreIsolationConfigurationError);
      const configurationError = error as RestoreIsolationConfigurationError;
      expect(configurationError.code).toBe(
        "RESTORE_ISOLATION_CONFIGURATION_INVALID",
      );
      expect(configurationError.invalidVariables).toEqual([
        "NOTIFICATION_OUTBOX_ENABLED",
        "WEB_PUSH_ENABLED",
      ]);
      expect(configurationError.message).not.toContain("true");
    }
  });

  it("reserves restore isolation mode for the dedicated recovery CLI", () => {
    expect(() =>
      assertWebRuntimeIsNotRestoreIsolation({
        RESTORE_ISOLATION_MODE: "true",
      }),
    ).toThrow(RestoreIsolationWebRuntimeError);
    try {
      assertWebRuntimeIsNotRestoreIsolation({
        RESTORE_ISOLATION_MODE: "true",
      });
      throw new Error("Expected restore isolation web-runtime guard to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreIsolationWebRuntimeError);
      expect((error as RestoreIsolationWebRuntimeError).code).toBe(
        "RESTORE_ISOLATION_WEB_RUNTIME_FORBIDDEN",
      );
    }
    expect(() =>
      assertWebRuntimeIsNotRestoreIsolation({
        RESTORE_ISOLATION_MODE: "false",
      }),
    ).not.toThrow();
  });

  it("requires the connected database to match the named restore target", () => {
    expect(() =>
      assertRestoreIsolationDatabase(
        SAFE_RESTORE_ENVIRONMENT,
        "atcloud-restore-test",
      ),
    ).not.toThrow();
    expect(() =>
      assertRestoreIsolationDatabase(
        SAFE_RESTORE_ENVIRONMENT,
        "atcloud-restore-other",
      ),
    ).toThrow(RestoreIsolationDatabaseError);
  });
});
