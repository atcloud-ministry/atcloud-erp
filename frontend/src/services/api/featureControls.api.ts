import {
  parseRuntimeConfigResponse,
  type AlumniNetworkMode,
  type RuntimeConfig,
} from "../../config/runtimeConfig";
import { BaseApiClient } from "./common";

const ALUMNI_NETWORK_MODES: readonly AlumniNetworkMode[] = [
  "off",
  "read_only",
  "on",
];

export interface UpdateAlumniNetworkModeInput {
  readonly mode: AlumniNetworkMode;
  readonly expectedRevision: number;
}

function normalizeUpdateInput(
  input: UpdateAlumniNetworkModeInput,
): UpdateAlumniNetworkModeInput {
  if (!ALUMNI_NETWORK_MODES.includes(input.mode)) {
    throw new Error("Invalid Alumni Network mode");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Expected revision must be a non-negative safe integer");
  }
  return Object.freeze({
    mode: input.mode,
    expectedRevision: input.expectedRevision,
  });
}

/** Super Admin runtime controls; server-side permission checks remain authoritative. */
export class FeatureControlsApiClient extends BaseApiClient {
  async get(signal?: AbortSignal): Promise<RuntimeConfig> {
    const response = await this.request<unknown>("/system/feature-controls", {
      method: "GET",
      cache: "no-store",
      signal,
    });
    return parseRuntimeConfigResponse(response);
  }

  async updateAlumniNetworkMode(
    input: UpdateAlumniNetworkModeInput,
  ): Promise<RuntimeConfig> {
    const body = normalizeUpdateInput(input);
    const response = await this.request<unknown>(
      "/system/feature-controls/alumni-network",
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
    return parseRuntimeConfigResponse(response);
  }
}

export const featureControlsService = new FeatureControlsApiClient();
