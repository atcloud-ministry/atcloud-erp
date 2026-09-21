import type { NextFunction, Request, Response } from "express";
import {
  authorizationService,
  createUserAuthorizationPrincipal,
} from "../services/authorization/AuthorizationService";
import { recordAuthorizationDenial } from "../services/authorization/AuthorizationAuditService";
import type {
  AuthorizationAction,
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationResource,
  UserAuthorizationPrincipal,
} from "../services/authorization/types";

export interface HttpAuthorizationOptions {
  readonly action: AuthorizationAction;
  readonly resource?: (req: Request) => AuthorizationResource | undefined;
  readonly context?: (req: Request) => Readonly<Record<string, unknown>>;
  readonly concealDeniedResource?: boolean;
}

export function getRequestUserPrincipal(
  req: Request,
): UserAuthorizationPrincipal | null {
  const principal =
    req.authPrincipal?.kind === "user"
      ? req.authPrincipal
      : req.user
        ? createUserAuthorizationPrincipal(req.user)
        : null;

  return principal?.isActive === true && principal.isVerified === true
    ? principal
    : null;
}

/** Thin Express adapter for the shared authorization contract. */
export function authorizeHttp(options: HttpAuthorizationOptions) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const principal = getRequestUserPrincipal(req);
    if (!principal) {
      res.status(401).json({
        success: false,
        message: "Authentication required.",
        reasonCode: "authentication_required",
      });
      return;
    }

    let authorizationRequest: AuthorizationRequest = {
      source: "http",
      principal,
      action: options.action,
    };
    let decision: AuthorizationDecision;
    try {
      authorizationRequest = {
        ...authorizationRequest,
        resource: options.resource?.(req),
        context: options.context?.(req),
      };
      decision = await authorizationService.authorize(authorizationRequest);
    } catch {
      decision = {
        allowed: false,
        reasonCode: "authorization_error",
        concealExistence: true,
      };
    }

    if (decision.allowed) {
      next();
      return;
    }

    recordAuthorizationDenial(
      authorizationRequest,
      decision,
      req.correlationId,
    );

    if (decision.reasonCode === "authorization_error") {
      res.status(500).json({
        success: false,
        message: "Authorization check failed.",
        reasonCode: decision.reasonCode,
      });
      return;
    }

    const conceal = options.concealDeniedResource || decision.concealExistence;
    if (decision.reasonCode === "resource_not_found" || conceal) {
      res.status(404).json({
        success: false,
        message: "Resource not found.",
        reasonCode: "resource_not_found",
      });
      return;
    }

    res.status(403).json({
      success: false,
      message: "Access denied.",
      reasonCode: decision.reasonCode,
    });
  };
}
