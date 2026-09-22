import type { NextFunction, Request, RequestHandler, Response } from "express";
import { featureControlService } from "../services/runtime/FeatureControlService";

export type AlumniNetworkGateCapability = "read" | "write";

export interface RuntimeConfigReader {
  getRuntimeConfig(): ReturnType<typeof featureControlService.getRuntimeConfig>;
}

function deny(res: Response, capability: AlumniNetworkGateCapability): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(503).json({
    success: false,
    message: "The alumni network is temporarily unavailable.",
    code:
      capability === "read"
        ? "ALUMNI_NETWORK_READ_UNAVAILABLE"
        : "ALUMNI_NETWORK_WRITE_UNAVAILABLE",
  });
}

export function createAlumniNetworkFeatureGate(
  capability: AlumniNetworkGateCapability,
  reader: RuntimeConfigReader = featureControlService,
): RequestHandler {
  return async (
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const config = await reader.getRuntimeConfig();
      const feature = config.data.alumniNetwork;
      const allowed =
        capability === "read"
          ? feature.readable === true &&
            (feature.mode === "read_only" || feature.mode === "on")
          : feature.writable === true && feature.mode === "on";
      if (allowed) {
        next();
        return;
      }
    } catch {
      // Fail closed below.
    }
    deny(res, capability);
  };
}

export const requireAlumniNetworkReadable = createAlumniNetworkFeatureGate("read");
export const requireAlumniNetworkWritable = createAlumniNetworkFeatureGate("write");
