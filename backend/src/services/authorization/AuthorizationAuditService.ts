import type { AuditActor, AuditTarget } from "../../contracts/auditLog";
import { AuditLogService } from "../AuditLogService";
import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "./types";

function auditActor(request: AuthorizationRequest): AuditActor {
  if (request.principal.kind === "user") {
    return {
      type: "user",
      id: request.principal.userId,
      role: request.principal.role,
    };
  }
  return {
    type: "worker",
    key: request.principal.serviceKey,
  };
}

function auditTarget(request: AuthorizationRequest): AuditTarget | undefined {
  if (!request.resource?.id) return undefined;
  const model = request.resource.type
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
  if (!model) return undefined;
  return { model, id: request.resource.id };
}

/**
 * Persist authenticated authorization denials without delaying or changing the
 * caller's decision. Anonymous authentication failures are intentionally not
 * written to MongoDB.
 */
export function recordAuthorizationDenial(
  request: AuthorizationRequest,
  decision: AuthorizationDecision,
  correlationId?: string,
): void {
  if (decision.allowed) return;

  void AuditLogService.record({
    action: "authorization.denied",
    actor: auditActor(request),
    source: request.source,
    outcome: "denied",
    target: auditTarget(request),
    correlationId,
    reasonCode: decision.reasonCode,
    details: {
      authorizationAction: request.action,
      resourceType: request.resource?.type,
    },
  });
}
