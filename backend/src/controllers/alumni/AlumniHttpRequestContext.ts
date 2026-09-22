import type { Request, Response } from "express";
import { AlumniHelpFlowValidationError } from "../../contracts/alumniHelpFlow";
import { AlumniProfileFlowValidationError } from "../../contracts/alumniProfileFlow";
import { AlumniRosterFlowValidationError } from "../../contracts/alumniRosterFlow";
import type { AlumniFlowActor } from "../../services/alumni/AlumniFlowActor";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AlumniRequestContextValidationScope = "roster" | "help" | "profile";

function invalidInput(
  path: string,
  validationScope: AlumniRequestContextValidationScope,
): never {
  const issues = [
    Object.freeze({ path, msg: "Required request context is missing" }),
  ];
  if (validationScope === "help") {
    throw new AlumniHelpFlowValidationError(issues);
  }
  if (validationScope === "profile") {
    throw new AlumniProfileFlowValidationError(issues);
  }
  throw new AlumniRosterFlowValidationError(issues);
}

export function getAlumniRequestActor(
  req: Request,
  validationScope: AlumniRequestContextValidationScope = "roster",
): AlumniFlowActor {
  const id = req.userId;
  const role = req.userRole ?? req.user?.role;
  if (!id || !role) return invalidInput("actor", validationScope);
  return Object.freeze({ id, role });
}

export function getAlumniIdempotencyKey(
  req: Request,
  validationScope: AlumniRequestContextValidationScope = "roster",
): string {
  const value = req.get("Idempotency-Key");
  if (!value || !UUID_PATTERN.test(value)) {
    return invalidInput("Idempotency-Key", validationScope);
  }
  return value.toLowerCase();
}

export function setAlumniNoStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}
