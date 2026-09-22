import type { Request, Response } from "express";
import {
  parseAlumniProfilePublishBody,
  parseAlumniProfileUpdateBody,
  parseAlumniProfileWithdrawBody,
} from "../../contracts/alumniProfileFlow";
import {
  alumniProfileService,
  type AlumniProfileService,
} from "../../services/alumni/AlumniProfileService";
import { sendAlumniHttpError } from "./AlumniHttpErrorResponder";
import {
  getAlumniIdempotencyKey,
  getAlumniRequestActor,
  setAlumniNoStore,
} from "./AlumniHttpRequestContext";

export class AlumniProfileController {
  constructor(
    private readonly service: AlumniProfileService = alumniProfileService,
  ) {}

  getOwn = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req);
      const profile = await this.service.getOwn(actor.id);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  ensureOwnDraft = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req);
      const profile = await this.service.ensureOwnDraft(actor.id);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  previewOwn = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req);
      const profile = await this.service.previewOwn(actor.id);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  updateOwn = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req);
      const body = parseAlumniProfileUpdateBody(req.body);
      await this.service.updateOwn({
        ...body,
        actor,
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      const profile = await this.service.getOwn(actor.id);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  publishOwn = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req);
      const body = parseAlumniProfilePublishBody(req.body);
      await this.service.publishOwn({
        ...body,
        actor,
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      const profile = await this.service.getOwn(actor.id);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  withdrawOwn = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req);
      const body = parseAlumniProfileWithdrawBody(req.body);
      await this.service.withdrawOwn({
        ...body,
        actor,
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      const profile = await this.service.getOwn(actor.id);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };
}

export const alumniProfileController = new AlumniProfileController();
