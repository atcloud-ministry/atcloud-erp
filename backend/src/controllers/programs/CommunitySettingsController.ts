import type { Request, Response } from "express";
import {
  parseUpdateProgramCommunitySettingsBody,
  ProgramCommunitySettingsValidationError,
} from "../../contracts/programCommunitySettings";
import {
  programCommunitySettingsService,
  type ProgramCommunitySettingsService,
} from "../../services/programs/ProgramCommunitySettingsService";
import { sendProgramCommunitySettingsHttpError } from "./ProgramCommunitySettingsHttpErrorResponder";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(path: string): never {
  throw new ProgramCommunitySettingsValidationError([
    Object.freeze({ path, msg: "Required request context is missing" }),
  ]);
}

function actor(req: Request) {
  const id = req.userId;
  const role = req.userRole ?? req.user?.role;
  if (!id || !role) return invalid("actor");
  return Object.freeze({ id, role });
}

function idempotencyKey(req: Request): string {
  const value = req.get("Idempotency-Key");
  if (!value || !UUID_PATTERN.test(value)) return invalid("Idempotency-Key");
  return value.toLowerCase();
}

export class CommunitySettingsController {
  constructor(
    private readonly service: ProgramCommunitySettingsService =
      programCommunitySettingsService,
  ) {}

  get = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const settings = await this.service.get(req.params.id ?? "");
      res.status(200).json({ success: true, data: { settings } });
    } catch (error) {
      sendProgramCommunitySettingsHttpError(res, error);
    }
  };

  update = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = parseUpdateProgramCommunitySettingsBody(req.body);
      const requestActor = actor(req);
      const result = await this.service.update({
        ...body,
        programId: req.params.id ?? "",
        actor: requestActor,
        idempotencyKey: idempotencyKey(req),
        correlationId: req.correlationId,
      });
      programMembershipMutationSyncTrigger.communitySettingsChanged(
        req.params.id ?? "",
        {
          actor: { type: "user", ...requestActor },
          source: "http",
          correlationId: req.correlationId,
        },
      );
      res.status(200).json({
        success: true,
        data: { settings: result.settings },
      });
    } catch (error) {
      sendProgramCommunitySettingsHttpError(res, error);
    }
  };
}

export const communitySettingsController = new CommunitySettingsController();
