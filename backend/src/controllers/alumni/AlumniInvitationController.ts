import type { Request, Response } from "express";
import {
  AlumniRosterFlowValidationError,
  buildAlumniInvitationClaimResultDTO,
  buildAlumniInvitationReissueResultDTO,
  parseAlumniInvitationClaimBody,
  parseAlumniInvitationListQuery,
  parseAlumniInvitationReissueBody,
  parseAlumniObjectId,
} from "../../contracts/alumniRosterFlow";
import {
  alumniInvitationService,
  type AlumniInvitationService,
} from "../../services/alumni/AlumniInvitationService";
import { alumniInvitationUnavailable } from "../../services/alumni/AlumniFlowErrors";
import { sendAlumniHttpError } from "./AlumniHttpErrorResponder";
import {
  getAlumniIdempotencyKey,
  getAlumniRequestActor,
  setAlumniNoStore,
} from "./AlumniHttpRequestContext";

export class AlumniInvitationController {
  constructor(
    private readonly service: AlumniInvitationService = alumniInvitationService,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const query = parseAlumniInvitationListQuery(req.query);
      const result = await this.service.listInvitations(query);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  reissue = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const invitationId = parseAlumniObjectId(
        req.params.invitationId,
        "invitationId",
      );
      const body = parseAlumniInvitationReissueBody(req.body);
      const result = await this.service.reissue({
        invitationId,
        expectedRevision: body.expectedRevision,
        actor: getAlumniRequestActor(req),
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(200).json({
        success: true,
        data: buildAlumniInvitationReissueResultDTO(result),
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  claim = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      let body: ReturnType<typeof parseAlumniInvitationClaimBody>;
      try {
        body = parseAlumniInvitationClaimBody(req.body);
      } catch (error) {
        if (error instanceof AlumniRosterFlowValidationError) {
          throw alumniInvitationUnavailable();
        }
        throw error;
      }
      const result = await this.service.claim({
        token: body.token,
        actor: getAlumniRequestActor(req),
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(200).json({
        success: true,
        data: buildAlumniInvitationClaimResultDTO(result),
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };
}

export const alumniInvitationController = new AlumniInvitationController();
