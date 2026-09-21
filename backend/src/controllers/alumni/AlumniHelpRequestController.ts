import type { Request, Response } from "express";
import {
  parseCreateHelpRequestBody,
  parseHelpRequestListQuery,
  parseHelpTransitionBody,
  parseOutcomeDecisionBody,
  parseSubmitHelpOutcomeBody,
  type HelpTransitionAction,
} from "../../contracts/alumniHelpFlow";
import {
  alumniHelpRequestService,
  type AlumniHelpRequestService,
} from "../../services/alumni/AlumniHelpRequestService";
import { reliabilityFoundationService } from "../../services/reliability/ReliabilityFoundationService";
import { sendAlumniHttpError } from "./AlumniHttpErrorResponder";
import {
  getAlumniIdempotencyKey,
  getAlumniRequestActor,
  setAlumniNoStore,
} from "./AlumniHttpRequestContext";

export class AlumniHelpRequestController {
  constructor(
    private readonly service: AlumniHelpRequestService = alumniHelpRequestService,
  ) {}

  /**
   * The service resolves only after its transaction and durable outbox enqueue
   * have committed. Waking the worker here reduces idle-poll latency without
   * making Socket delivery part of the HTTP transaction or response contract.
   */
  private wakeCommittedOutbox(): void {
    try {
      reliabilityFoundationService.wakeNotificationOutbox();
    } catch {
      // The outbox record is durable; normal polling recovers a transient
      // in-process wake failure without changing a successful mutation.
    }
  }

  terms = async (_req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    res.status(200).json({ success: true, data: { terms: this.service.terms() } });
  };

  list = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req, "help");
      const data = await this.service.list(actor.id, parseHelpRequestListQuery(req.query));
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  actionRequiredCount = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req, "help");
      const data = await this.service.actionRequiredCount(actor.id);
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  get = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req, "help");
      const data = await this.service.get(actor.id, req.params.requestId ?? "");
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  create = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req, "help");
      const data = await this.service.create({
        ...parseCreateHelpRequestBody(req.body),
        actor,
        idempotencyKey: getAlumniIdempotencyKey(req, "help"),
        correlationId: req.correlationId,
      });
      this.wakeCommittedOutbox();
      res.status(201).json({ success: true, data });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  transition =
    (action: HelpTransitionAction) =>
    async (req: Request, res: Response): Promise<void> => {
      setAlumniNoStore(res);
      try {
        const actor = getAlumniRequestActor(req, "help");
        const data = await this.service.transition({
          requestId: req.params.requestId ?? "",
          action,
          ...parseHelpTransitionBody(action, req.body),
          actor,
          idempotencyKey: getAlumniIdempotencyKey(req, "help"),
          correlationId: req.correlationId,
        });
        this.wakeCommittedOutbox();
        res.status(200).json({ success: true, data });
      } catch (error) {
        sendAlumniHttpError(res, error);
      }
    };

  submitOutcome = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req, "help");
      const data = await this.service.submitOutcome({
        requestId: req.params.requestId ?? "",
        ...parseSubmitHelpOutcomeBody(req.body),
        actor,
        idempotencyKey: getAlumniIdempotencyKey(req, "help"),
        correlationId: req.correlationId,
      });
      this.wakeCommittedOutbox();
      res.status(201).json({ success: true, data });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  decideOutcome =
    (decision: "confirm" | "deny") =>
    async (req: Request, res: Response): Promise<void> => {
      setAlumniNoStore(res);
      try {
        const actor = getAlumniRequestActor(req, "help");
        const data = await this.service.decideOutcome({
          requestId: req.params.requestId ?? "",
          outcomeId: req.params.outcomeId ?? "",
          decision,
          ...parseOutcomeDecisionBody(req.body),
          actor,
          idempotencyKey: getAlumniIdempotencyKey(req, "help"),
          correlationId: req.correlationId,
        });
        this.wakeCommittedOutbox();
        res.status(200).json({ success: true, data });
      } catch (error) {
        sendAlumniHttpError(res, error);
      }
    };
}

export const alumniHelpRequestController = new AlumniHelpRequestController();
