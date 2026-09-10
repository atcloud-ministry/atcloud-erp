import { describe, expect, it } from "vitest";
import {
  AlumniNetworkFeatureConfigurationError,
  getAlumniNetworkCapabilities,
  readAlumniNetworkReleaseAvailable,
} from "../../../src/config/alumniNetworkFeature";

describe("alumni network deployment ceiling", () => {
  it.each([
    [{}, false],
    [{ ALUMNI_NETWORK_RELEASE_AVAILABLE: "false" }, false],
    [{ ALUMNI_NETWORK_RELEASE_AVAILABLE: "true" }, true],
  ] as const)("parses the exact supported environment values", (environment, expected) => {
    expect(
      readAlumniNetworkReleaseAvailable(environment as NodeJS.ProcessEnv),
    ).toBe(expected);
  });

  it.each(["", "TRUE", "False", "1", " true ", "yes"])(
    "rejects invalid value %j",
    (value) => {
      expect(() =>
        readAlumniNetworkReleaseAvailable({
          ALUMNI_NETWORK_RELEASE_AVAILABLE: value,
        }),
      ).toThrow(AlumniNetworkFeatureConfigurationError);
    },
  );

  it("maps off, read_only, and on to their read/write capabilities", () => {
    expect(getAlumniNetworkCapabilities("off")).toEqual({
      readable: false,
      writable: false,
    });
    expect(getAlumniNetworkCapabilities("read_only")).toEqual({
      readable: true,
      writable: false,
    });
    expect(getAlumniNetworkCapabilities("on")).toEqual({
      readable: true,
      writable: true,
    });
  });
});
