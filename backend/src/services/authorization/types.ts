import type { Permission, UserRole } from "../../utils/roleUtils";

export type AuthorizationSource = "http" | "socket" | "worker";

export interface UserAuthorizationPrincipal {
  readonly kind: "user";
  readonly userId: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly isVerified: boolean;
}

export interface ServiceAuthorizationPrincipal {
  readonly kind: "service";
  readonly serviceKey: string;
  readonly capabilities: readonly string[];
  readonly runId?: string;
  readonly initiatedByUserId?: string;
}

export type AuthorizationPrincipal =
  | UserAuthorizationPrincipal
  | ServiceAuthorizationPrincipal;

export interface AuthorizationResource {
  readonly type: string;
  readonly id?: string;
}

export interface AuthorizationRequest {
  readonly source: AuthorizationSource;
  readonly principal: AuthorizationPrincipal;
  readonly action: string;
  readonly resource?: AuthorizationResource;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reasonCode:
    | "allowed"
    | "authentication_required"
    | "principal_inactive"
    | "principal_unverified"
    | "principal_source_mismatch"
    | "policy_not_found"
    | "resource_required"
    | "resource_not_found"
    | "invalid_context"
    | "insufficient_permission"
    | "not_resource_member"
    | "worker_capability_denied"
    | "authorization_error";
  readonly concealExistence: boolean;
}

export const AUTHORIZATION_ACTIONS = {
  HAS_ANY_ROLE: "platform.has_any_role",
  HAS_MINIMUM_ROLE: "platform.has_minimum_role",
  HAS_PERMISSION: "platform.has_permission",
  EVENT_MANAGE: "event.manage",
  EVENT_SUBSCRIBE_REALTIME: "event.subscribe_realtime",
  PROGRAM_MANAGE: "program.manage",
  CONVERSATION_READ: "conversation.read",
  CONVERSATION_SEND: "conversation.send",
  CONVERSATION_SEND_OR_REPLAY: "conversation.send_or_replay",
  CONVERSATION_UPDATE_STATE: "conversation.update_state",
  CONVERSATION_SUBSCRIBE_REALTIME: "conversation.subscribe_realtime",
  NOTIFICATION_SETTINGS_MANAGE: "notification_settings.manage",
  WORKER_EXECUTE: "worker.execute",
} as const;

export type AuthorizationAction =
  (typeof AUTHORIZATION_ACTIONS)[keyof typeof AUTHORIZATION_ACTIONS];

export interface PermissionAuthorizationContext
  extends Readonly<Record<string, unknown>> {
  readonly permission: Permission;
}

export interface RolesAuthorizationContext
  extends Readonly<Record<string, unknown>> {
  readonly roles: readonly UserRole[];
}

export interface MinimumRoleAuthorizationContext
  extends Readonly<Record<string, unknown>> {
  readonly minimumRole: UserRole;
}
