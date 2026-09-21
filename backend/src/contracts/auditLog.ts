export const AUDIT_LOG_VERSION = 2 as const;

export const AUDIT_ACTOR_TYPES = ["user", "worker", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_SOURCES = ["http", "socket", "worker", "system"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_OUTCOMES = [
  "success",
  "denied",
  "failure",
  "noop",
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export type AuditActor =
  | {
      type: "user";
      id: string;
      role: string;
    }
  | {
      type: "worker";
      key: string;
    }
  | {
      type: "system";
      key: string;
    };

export interface AuditTarget {
  model: string;
  id: string;
}

export interface AuditLogWriteInput {
  action: string;
  actor: AuditActor;
  source: AuditSource;
  outcome: AuditOutcome;
  target?: AuditTarget;
  correlationId?: string;
  reasonCode?: string;
  details?: Readonly<Record<string, unknown>>;
  hashes?: {
    email?: string;
    ip?: string;
  };
  userAgent?: string;
}
