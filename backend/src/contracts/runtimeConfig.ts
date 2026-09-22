import {
  getAlumniNetworkCapabilities,
  type AlumniNetworkMode,
} from "../config/alumniNetworkFeature";

export interface RuntimeConfigSuccessDTO {
  readonly success: true;
  readonly data: {
    readonly version: 1;
    readonly revision: number;
    readonly alumniNetwork: {
      readonly mode: AlumniNetworkMode;
      readonly readable: boolean;
      readonly writable: boolean;
    };
  };
}

export function createRuntimeConfigDTO(
  mode: AlumniNetworkMode,
  revision: number,
): RuntimeConfigSuccessDTO {
  const capabilities = getAlumniNetworkCapabilities(mode);
  const alumniNetwork = Object.freeze({ mode, ...capabilities });
  const data = Object.freeze({
    version: 1 as const,
    revision,
    alumniNetwork,
  });
  return Object.freeze({ success: true as const, data });
}

export const FAIL_CLOSED_RUNTIME_CONFIG = createRuntimeConfigDTO("off", 0);
