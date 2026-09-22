export const ALUMNI_NETWORK_MODES = ["off", "read_only", "on"] as const;

export type AlumniNetworkMode = (typeof ALUMNI_NETWORK_MODES)[number];

export const ALUMNI_NETWORK_RELEASE_ENV =
  "ALUMNI_NETWORK_RELEASE_AVAILABLE" as const;

export class AlumniNetworkFeatureConfigurationError extends Error {
  readonly name = "AlumniNetworkFeatureConfigurationError";
  readonly code = "ALUMNI_NETWORK_FEATURE_CONFIGURATION_INVALID";

  constructor() {
    super("The alumni network release ceiling is not configured correctly.");
  }
}

export function isAlumniNetworkMode(value: unknown): value is AlumniNetworkMode {
  return (
    typeof value === "string" &&
    (ALUMNI_NETWORK_MODES as readonly string[]).includes(value)
  );
}

/**
 * Read the deployment ceiling at call time so dotenv/bootstrap has already run.
 * Missing is deliberately equivalent to false; every other value is exact.
 */
export function readAlumniNetworkReleaseAvailable(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = environment[ALUMNI_NETWORK_RELEASE_ENV];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new AlumniNetworkFeatureConfigurationError();
}

export function getAlumniNetworkCapabilities(mode: AlumniNetworkMode): {
  readonly readable: boolean;
  readonly writable: boolean;
} {
  switch (mode) {
    case "off":
      return Object.freeze({ readable: false, writable: false });
    case "read_only":
      return Object.freeze({ readable: true, writable: false });
    case "on":
      return Object.freeze({ readable: true, writable: true });
  }
}
