import type { Request, Response } from "express";
import { AlumniRosterFlowValidationError } from "../../contracts/alumniRosterFlow";
import type { AlumniFlowActor } from "../../services/alumni/AlumniInvitationService";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidInput(path: string): never {
  throw new AlumniRosterFlowValidationError([
    Object.freeze({ path, msg: "Required request context is missing" }),
  ]);
}

export function getAlumniRequestActor(req: Request): AlumniFlowActor {
  const id = req.userId;
  const role = req.userRole ?? req.user?.role;
  if (!id || !role) return invalidInput("actor");
  return Object.freeze({ id, role });
}

export function getAlumniIdempotencyKey(req: Request): string {
  const value = req.get("Idempotency-Key");
  if (!value || !UUID_PATTERN.test(value)) return invalidInput("Idempotency-Key");
  return value.toLowerCase();
}

export function setAlumniNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}
