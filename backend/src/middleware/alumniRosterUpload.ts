import path from "path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer, { type FileFilterCallback } from "multer";
import { ALUMNI_ROSTER_CSV_LIMITS } from "../services/alumni/AlumniRosterCsvParser";

const CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

class AlumniRosterFileTypeError extends Error {
  readonly name = "AlumniRosterFileTypeError";
}

function csvFileFilter(
  _req: Request,
  file: Express.Multer.File,
  callback: FileFilterCallback,
): void {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = file.mimetype.trim().toLowerCase();
  if (extension !== ".csv" || !CSV_MIME_TYPES.has(mimeType)) {
    callback(new AlumniRosterFileTypeError());
    return;
  }
  callback(null, true);
}

const receiveRoster = multer({
  storage: multer.memoryStorage(),
  fileFilter: csvFileFilter,
  limits: {
    fileSize: ALUMNI_ROSTER_CSV_LIMITS.maxBytes,
    files: 1,
    fields: 0,
    // Busboy emits LIMIT_PART_COUNT when the observed count reaches this
    // threshold, so two is the minimum that permits exactly one file part.
    parts: 2,
  },
}).single("roster");

function failure(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ success: false, message, code });
}

export const uploadAlumniRosterCsv: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const contentType = req.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    failure(
      res,
      400,
      "ALUMNI_ROSTER_UPLOAD_INVALID",
      "A CSV roster upload is required.",
    );
    return;
  }

  receiveRoster(req, res, (error: unknown) => {
    if (error instanceof AlumniRosterFileTypeError) {
      failure(
        res,
        415,
        "ALUMNI_ROSTER_FILE_TYPE_INVALID",
        "The roster must be a CSV file.",
      );
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        failure(
          res,
          413,
          "ALUMNI_ROSTER_FILE_TOO_LARGE",
          "The roster CSV exceeds the 8 MiB limit.",
        );
        return;
      }
      failure(
        res,
        400,
        "ALUMNI_ROSTER_UPLOAD_INVALID",
        "A valid single CSV roster upload is required.",
      );
      return;
    }
    if (error) {
      failure(
        res,
        400,
        "ALUMNI_ROSTER_UPLOAD_INVALID",
        "The roster upload could not be processed.",
      );
      return;
    }
    if (!req.file?.buffer || req.file.buffer.length === 0) {
      failure(
        res,
        400,
        "ALUMNI_ROSTER_FILE_REQUIRED",
        "A non-empty CSV roster file is required.",
      );
      return;
    }
    next();
  });
};
