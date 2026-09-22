import type { Request, Response } from "express";
import {
  buildAlumniImportBatchSummaryDTO,
  parseAlumniImportApplyBody,
  parseAlumniImportBatchListQuery,
  parseAlumniImportDryRunBody,
  parseAlumniImportRerunBody,
  parseAlumniImportReviewBody,
  parseAlumniImportRowListQuery,
  parseAlumniObjectId,
} from "../../contracts/alumniRosterFlow";
import {
  alumniImportService,
  type AlumniImportService,
} from "../../services/alumni/AlumniImportService";
import { sendAlumniHttpError } from "./AlumniHttpErrorResponder";
import {
  getAlumniIdempotencyKey,
  getAlumniRequestActor,
  setAlumniNoStore,
} from "./AlumniHttpRequestContext";

export class AlumniImportController {
  constructor(
    private readonly service: AlumniImportService = alumniImportService,
  ) {}

  listBatches = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const query = parseAlumniImportBatchListQuery(req.query);
      const result = await this.service.listBatches(query);
      res.status(200).json({
        success: true,
        data: {
          batches: result.batches.map(buildAlumniImportBatchSummaryDTO),
          pagination: {
            currentPage: result.pagination.currentPage,
            totalPages: result.pagination.totalPages,
            hasNext: result.pagination.hasNext,
            hasPrev: result.pagination.hasPrev,
            totalBatches: result.pagination.totalBatches,
          },
        },
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  getBatch = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const batchId = parseAlumniObjectId(req.params.batchId, "batchId");
      const result = await this.service.getBatch(batchId);
      res.status(200).json({
        success: true,
        data: buildAlumniImportBatchSummaryDTO(result),
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  listRows = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const batchId = parseAlumniObjectId(req.params.batchId, "batchId");
      const query = parseAlumniImportRowListQuery(req.query);
      const result = await this.service.listRows({ batchId, ...query });
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  dryRun = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      parseAlumniImportDryRunBody(req.body);
      const result = await this.service.dryRun({
        csv: req.file!.buffer,
        actor: getAlumniRequestActor(req),
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(201).json({
        success: true,
        data: {
          replayed: result.replayed,
          batchId: parseAlumniObjectId(result.batchId, "batchId"),
          status: result.status,
          revision: result.revision,
          totalRows: result.totalRows,
          validRows: result.validRows,
          invalidRows: result.invalidRows,
          matchedRows: result.matchedRows,
          unmatchedRows: result.unmatchedRows,
          ambiguousRows: result.ambiguousRows,
        },
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  review = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const batchId = parseAlumniObjectId(req.params.batchId, "batchId");
      const body = parseAlumniImportReviewBody(req.body);
      const result = await this.service.review({
        batchId,
        expectedRevision: body.expectedRevision,
        decisions: body.decisions,
        actor: getAlumniRequestActor(req),
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(200).json({
        success: true,
        data: {
          replayed: result.replayed,
          batchId: parseAlumniObjectId(result.batchId, "batchId"),
          status: result.status,
          revision: result.revision,
          approvedRows: result.approvedRows,
          rejectedRows: result.rejectedRows,
          pendingReviewRows: result.pendingReviewRows,
        },
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  apply = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const batchId = parseAlumniObjectId(req.params.batchId, "batchId");
      const body = parseAlumniImportApplyBody(req.body);
      const result = await this.service.apply({
        batchId,
        expectedRevision: body.expectedRevision,
        actor: getAlumniRequestActor(req),
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(200).json({
        success: true,
        data: {
          replayed: result.replayed,
          batchId: parseAlumniObjectId(result.batchId, "batchId"),
          status: result.status,
          revision: result.revision,
          appliedRows: result.appliedRows,
          invitationsCreated: result.invitationsCreated,
          remainingRows: result.remainingRows,
        },
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  rerun = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const batchId = parseAlumniObjectId(req.params.batchId, "batchId");
      const body = parseAlumniImportRerunBody(req.body);
      const result = await this.service.rerun({
        batchId,
        expectedRevision: body.expectedRevision,
        actor: getAlumniRequestActor(req),
        idempotencyKey: getAlumniIdempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(201).json({
        success: true,
        data: {
          replayed: result.replayed,
          sourceBatchId: parseAlumniObjectId(
            result.sourceBatchId,
            "sourceBatchId",
          ),
          sourceRevision: result.sourceRevision,
          batchId: parseAlumniObjectId(result.batchId, "batchId"),
          status: result.status,
          revision: result.revision,
          totalRows: result.totalRows,
          validRows: result.validRows,
          invalidRows: result.invalidRows,
          matchedRows: result.matchedRows,
          unmatchedRows: result.unmatchedRows,
          ambiguousRows: result.ambiguousRows,
        },
      });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };
}

export const alumniImportController = new AlumniImportController();
