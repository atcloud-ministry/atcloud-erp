import type { Request, Response } from "express";
import { AlumniNetworkFeatureConfigurationError } from "../../config/alumniNetworkFeature";
import { FAIL_CLOSED_RUNTIME_CONFIG } from "../../contracts/runtimeConfig";
import { CasConflictError } from "../../services/reliability/CasService";
import {
  featureControlService,
  isFeatureControlInputError,
  isFeatureControlReleaseUnavailableError,
  type FeatureControlService,
} from "../../services/runtime/FeatureControlService";

interface PatchBody {
  readonly mode: "off" | "read_only" | "on";
  readonly expectedRevision: number;
}

function parsePatchBody(value: unknown): PatchBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "expectedRevision" ||
    keys[1] !== "mode"
  ) {
    return null;
  }
  if (
    !("value" in descriptors.mode) ||
    !("value" in descriptors.expectedRevision)
  ) {
    return null;
  }

  const mode = descriptors.mode.value;
  const expectedRevision = descriptors.expectedRevision.value;
  if (
    (mode !== "off" && mode !== "read_only" && mode !== "on") ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return null;
  }
  return Object.freeze({ mode, expectedRevision });
}

function setNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

export class FeatureControlController {
  constructor(private readonly service: FeatureControlService = featureControlService) {}

  getRuntimeConfig = async (_req: Request, res: Response): Promise<void> => {
    setNoStore(res);
    try {
      res.status(200).json(await this.service.getRuntimeConfig());
    } catch {
      res.status(200).json(FAIL_CLOSED_RUNTIME_CONFIG);
    }
  };

  getOperationalRuntimeConfig = async (
    _req: Request,
    res: Response,
  ): Promise<void> => {
    setNoStore(res);
    try {
      res
        .status(200)
        .json(await this.service.getOperationalRuntimeConfig());
    } catch {
      res.status(503).json({
        success: false,
        message: "Feature controls are temporarily unavailable.",
        code: "FEATURE_CONTROL_UNAVAILABLE",
      });
    }
  };

  updateAlumniNetworkMode = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    setNoStore(res);
    const input = parsePatchBody(req.body);
    const actorId = req.userId;
    const actorRole = req.userRole ?? req.user?.role;
    if (!input || !actorId || !actorRole) {
      res.status(400).json({
        success: false,
        message: "A valid feature control request is required.",
        code: "FEATURE_CONTROL_INPUT_INVALID",
      });
      return;
    }

    try {
      const result = await this.service.updateAlumniNetworkMode({
        ...input,
        actorId,
        actorRole,
        correlationId: req.correlationId,
      });
      res.status(200).json(result);
    } catch (error) {
      if (isFeatureControlInputError(error)) {
        res.status(400).json({
          success: false,
          message: "A valid feature control request is required.",
          code: "FEATURE_CONTROL_INPUT_INVALID",
        });
        return;
      }
      if (error instanceof CasConflictError) {
        res.status(409).json({
          success: false,
          message: "The feature control revision has changed.",
          code: "FEATURE_CONTROL_REVISION_CONFLICT",
        });
        return;
      }
      if (isFeatureControlReleaseUnavailableError(error)) {
        res.status(409).json({
          success: false,
          message: "The requested feature mode is unavailable.",
          code: "ALUMNI_NETWORK_RELEASE_UNAVAILABLE",
        });
        return;
      }
      if (error instanceof AlumniNetworkFeatureConfigurationError) {
        res.status(503).json({
          success: false,
          message: "Feature controls are temporarily unavailable.",
          code: "FEATURE_CONTROL_UNAVAILABLE",
        });
        return;
      }

      res.status(503).json({
        success: false,
        message: "Feature controls are temporarily unavailable.",
        code: "FEATURE_CONTROL_UNAVAILABLE",
      });
    }
  };
}

export const featureControlController = new FeatureControlController();
