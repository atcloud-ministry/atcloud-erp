import { apiUrl } from "../lib/apiClient";

export const RUNTIME_CONFIG_VERSION = 1 as const;

export type AlumniNetworkMode = "off" | "read_only" | "on";

export interface AlumniNetworkRuntimeConfig {
  readonly mode: AlumniNetworkMode;
  readonly readable: boolean;
  readonly writable: boolean;
}

export interface RuntimeConfig {
  readonly version: typeof RUNTIME_CONFIG_VERSION;
  readonly revision: number;
  readonly alumniNetwork: AlumniNetworkRuntimeConfig;
}

export interface RuntimeConfigResponse {
  readonly success: true;
  readonly data: RuntimeConfig;
}

const MODE_CAPABILITIES: Readonly<
  Record<AlumniNetworkMode, Pick<AlumniNetworkRuntimeConfig, "readable" | "writable">>
> = Object.freeze({
  off: Object.freeze({ readable: false, writable: false }),
  read_only: Object.freeze({ readable: true, writable: false }),
  on: Object.freeze({ readable: true, writable: true }),
});

export const FAIL_CLOSED_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  version: RUNTIME_CONFIG_VERSION,
  revision: 0,
  alumniNetwork: Object.freeze({
    mode: "off",
    readable: false,
    writable: false,
  }),
});

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    )
  );
}

function isAlumniNetworkMode(value: unknown): value is AlumniNetworkMode {
  return value === "off" || value === "read_only" || value === "on";
}

function parseRuntimeConfigResponseUnsafe(value: unknown): RuntimeConfig {
  if (!isExactRecord(value, ["success", "data"]) || value.success !== true) {
    throw new Error("Invalid runtime configuration response");
  }

  const data = value.data;
  if (
    !isExactRecord(data, ["version", "revision", "alumniNetwork"]) ||
    data.version !== RUNTIME_CONFIG_VERSION ||
    !Number.isSafeInteger(data.revision) ||
    (data.revision as number) < 0
  ) {
    throw new Error("Invalid runtime configuration response");
  }

  const alumniNetwork = data.alumniNetwork;
  if (
    !isExactRecord(alumniNetwork, ["mode", "readable", "writable"]) ||
    !isAlumniNetworkMode(alumniNetwork.mode) ||
    typeof alumniNetwork.readable !== "boolean" ||
    typeof alumniNetwork.writable !== "boolean"
  ) {
    throw new Error("Invalid runtime configuration response");
  }

  const capabilities = MODE_CAPABILITIES[alumniNetwork.mode];
  if (
    alumniNetwork.readable !== capabilities.readable ||
    alumniNetwork.writable !== capabilities.writable
  ) {
    throw new Error("Invalid runtime configuration response");
  }

  return Object.freeze({
    version: RUNTIME_CONFIG_VERSION,
    revision: data.revision as number,
    alumniNetwork: Object.freeze({
      mode: alumniNetwork.mode,
      readable: alumniNetwork.readable,
      writable: alumniNetwork.writable,
    }),
  });
}

export function parseRuntimeConfigResponse(value: unknown): RuntimeConfig {
  try {
    return parseRuntimeConfigResponseUnsafe(value);
  } catch {
    throw new Error("Invalid runtime configuration response");
  }
}

export async function fetchRuntimeConfig(
  signal?: AbortSignal,
): Promise<RuntimeConfig> {
  const response = await fetch(apiUrl("/runtime-config"), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error("Unable to load runtime configuration");
  }

  return parseRuntimeConfigResponse(await response.json());
}
