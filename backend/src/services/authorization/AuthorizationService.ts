import {
  Conversation,
  ConversationMember,
  Event,
  Program,
  Purchase,
} from "../../models";
import { hasOpenAccessWindow } from "../../contracts/chatRooms";
import {
  hasPermission,
  Permission,
  PERMISSIONS,
  RoleUtils,
  type UserRole,
} from "../../utils/roleUtils";
import { isAffiliatedProgramEditor } from "../../utils/event/eventPermissions";
import { hasAnnualMembershipAccessToPrograms } from "../AnnualMembershipAccessService";
import {
  AUTHORIZATION_ACTIONS,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type UserAuthorizationPrincipal,
} from "./types";

type AuthorizationPolicy = (
  request: AuthorizationRequest,
) => Promise<AuthorizationDecision> | AuthorizationDecision;

const allow = (): AuthorizationDecision => ({
  allowed: true,
  reasonCode: "allowed",
  concealExistence: false,
});

const deny = (
  reasonCode: AuthorizationDecision["reasonCode"],
  concealExistence = false,
): AuthorizationDecision => ({ allowed: false, reasonCode, concealExistence });

function userPrincipal(
  request: AuthorizationRequest,
): UserAuthorizationPrincipal | null {
  return request.principal.kind === "user" ? request.principal : null;
}

function isPermission(value: unknown): value is Permission {
  return Object.values(PERMISSIONS).includes(value as Permission);
}

function isUserRole(value: unknown): value is UserRole {
  return (
    typeof value === "string" &&
    (typeof RoleUtils.isValidRole !== "function" || RoleUtils.isValidRole(value))
  );
}

async function authorizeEventManage(
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  const principal = userPrincipal(request);
  if (!principal) return deny("principal_source_mismatch");
  if (request.resource?.type !== "event" || !request.resource.id) {
    return deny("resource_required", true);
  }

  const eventQuery = Event.findById(request.resource.id);
  const event =
    typeof (eventQuery as unknown as { select?: unknown }).select === "function"
      ? await eventQuery.select(
          "createdBy organizerDetails.userId programLabels",
        )
      : await eventQuery;
  if (!event) return deny("resource_not_found", true);

  if (
    RoleUtils.isAdmin(principal.role) ||
    String(event.createdBy ?? "") === principal.userId ||
    event.organizerDetails?.some(
      (organizer: { userId?: unknown }) =>
        String(organizer.userId ?? "") === principal.userId,
    ) ||
    (await isAffiliatedProgramEditor(event, principal.userId, principal.role))
  ) {
    return allow();
  }

  return deny("not_resource_member");
}

async function authorizeEventSubscription(
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  const principal = userPrincipal(request);
  if (!principal) return deny("principal_source_mismatch");
  if (request.resource?.type !== "event" || !request.resource.id) {
    return deny("resource_required", true);
  }

  const eventQuery = Event.findById(request.resource.id);
  const event =
    typeof (eventQuery as unknown as { select?: unknown }).select === "function"
      ? await eventQuery.select(
          "_id pricing.isFree createdBy organizerDetails.userId programLabels",
        )
      : await eventQuery;
  if (!event) return deny("resource_not_found", true);

  if (
    event.pricing?.isFree !== false ||
    RoleUtils.isAdmin(principal.role) ||
    String(event.createdBy ?? "") === principal.userId ||
    event.organizerDetails?.some(
      (organizer: { userId?: unknown }) =>
        String(organizer.userId ?? "") === principal.userId,
    )
  ) {
    return allow();
  }

  if (
    await isAffiliatedProgramEditor(
      event,
      principal.userId,
      principal.role,
    )
  ) {
    return allow();
  }

  const programIds = event.programLabels ?? [];
  if (programIds.length > 0) {
    const programPurchase = await Purchase.findOne({
      userId: principal.userId,
      purchaseType: "program",
      programId: { $in: programIds },
      status: "completed",
      unenrolledAt: { $exists: false },
    }).select("_id");
    if (programPurchase) return allow();

    if (
      await hasAnnualMembershipAccessToPrograms({
        userId: principal.userId,
        programIds,
      })
    ) {
      return allow();
    }
  }

  const eventPurchase = await Purchase.findOne({
    userId: principal.userId,
    purchaseType: "event",
    eventId: event._id,
    status: "completed",
    unenrolledAt: { $exists: false },
  }).select("_id");
  return eventPurchase ? allow() : deny("not_resource_member", true);
}

async function authorizeProgramManage(
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  const principal = userPrincipal(request);
  if (!principal) return deny("principal_source_mismatch");
  if (request.resource?.type !== "program" || !request.resource.id) {
    return deny("resource_required", true);
  }

  const program = await Program.findById(request.resource.id).select(
    "createdBy mentors.userId adminEnrollments.classReps",
  );
  if (!program) return deny("resource_not_found", true);

  const userId = principal.userId;
  if (
    RoleUtils.isAdmin(principal.role) ||
    String(program.createdBy) === userId ||
    program.mentors?.some(
      (mentor: { userId: unknown }) => String(mentor.userId) === userId,
    ) ||
    program.adminEnrollments?.classReps?.some(
      (id: unknown) => String(id) === userId,
    )
  ) {
    return allow();
  }

  const classRepPurchase = await Purchase.findOne({
    purchaseType: "program",
    programId: program._id,
    userId,
    status: "completed",
    isClassRep: true,
    unenrolledAt: { $exists: false },
  }).select("_id");

  return classRepPurchase ? allow() : deny("not_resource_member");
}

async function authorizeConversationAccess(
  request: AuthorizationRequest,
  currentAccessRequired: boolean,
): Promise<AuthorizationDecision> {
  const principal = userPrincipal(request);
  if (!principal) return deny("principal_source_mismatch");
  if (request.resource?.type !== "conversation" || !request.resource.id) {
    return deny("resource_required", true);
  }
  if (!/^[a-f\d]{24}$/i.test(request.resource.id)) {
    return deny("resource_not_found", true);
  }

  const now = new Date();
  const [conversation, member] = await Promise.all([
    Conversation.findOne({
      _id: request.resource.id,
      $or: [
        { purgeAt: { $exists: false } },
        { purgeAt: null },
        { purgeAt: { $gt: now } },
      ],
    })
      .select("_id status")
      .lean(),
    ConversationMember.findOne({
      conversationId: request.resource.id,
      userId: principal.userId,
      $or: [
        { purgeAt: { $exists: false } },
        { purgeAt: null },
        { purgeAt: { $gt: now } },
      ],
    })
      .select("_id status accessWindows")
      .lean(),
  ]);
  if (!conversation || !member) {
    return deny("resource_not_found", true);
  }
  if (
    currentAccessRequired &&
    (conversation.status !== "current" ||
      member.status !== "active" ||
      !hasOpenAccessWindow(member.accessWindows ?? []))
  ) {
    return deny("not_resource_member", true);
  }
  return allow();
}

const defaultPolicies: ReadonlyMap<string, AuthorizationPolicy> = new Map<
  string,
  AuthorizationPolicy
>([
  [
    AUTHORIZATION_ACTIONS.HAS_ANY_ROLE,
    (request: AuthorizationRequest) => {
      const principal = userPrincipal(request);
      const roles = request.context?.roles;
      if (
        !principal ||
        !Array.isArray(roles) ||
        roles.length === 0 ||
        !roles.every(isUserRole)
      ) {
        return deny("invalid_context");
      }
      return RoleUtils.hasAnyRole(principal.role, roles) ? allow() : deny("insufficient_permission");
    },
  ],
  [
    AUTHORIZATION_ACTIONS.HAS_MINIMUM_ROLE,
    (request: AuthorizationRequest) => {
      const principal = userPrincipal(request);
      const minimumRole = request.context?.minimumRole;
      if (!principal || !isUserRole(minimumRole)) {
        return deny("invalid_context");
      }
      return RoleUtils.hasMinimumRole(principal.role, minimumRole)
        ? allow()
        : deny("insufficient_permission");
    },
  ],
  [
    AUTHORIZATION_ACTIONS.HAS_PERMISSION,
    (request: AuthorizationRequest) => {
      const principal = userPrincipal(request);
      const permission = request.context?.permission;
      if (!principal || !isPermission(permission)) {
        return deny("invalid_context");
      }
      return hasPermission(principal.role, permission)
        ? allow()
        : deny("insufficient_permission");
    },
  ],
  [AUTHORIZATION_ACTIONS.EVENT_MANAGE, authorizeEventManage],
  [AUTHORIZATION_ACTIONS.EVENT_SUBSCRIBE_REALTIME, authorizeEventSubscription],
  [AUTHORIZATION_ACTIONS.PROGRAM_MANAGE, authorizeProgramManage],
  [
    AUTHORIZATION_ACTIONS.CONVERSATION_READ,
    (request) => authorizeConversationAccess(request, false),
  ],
  [
    AUTHORIZATION_ACTIONS.CONVERSATION_SEND,
    (request) => authorizeConversationAccess(request, true),
  ],
  [
    AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
    (request) => authorizeConversationAccess(request, false),
  ],
  [
    AUTHORIZATION_ACTIONS.CONVERSATION_UPDATE_STATE,
    (request) => authorizeConversationAccess(request, true),
  ],
  [
    AUTHORIZATION_ACTIONS.CONVERSATION_SUBSCRIBE_REALTIME,
    (request) => authorizeConversationAccess(request, true),
  ],
  [
    AUTHORIZATION_ACTIONS.NOTIFICATION_SETTINGS_MANAGE,
    (request: AuthorizationRequest) => {
      const principal = userPrincipal(request);
      if (!principal) return deny("principal_source_mismatch");
      if (
        request.resource?.type !== "notification_settings" ||
        !request.resource.id
      ) {
        return deny("resource_required", true);
      }
      return request.resource.id === principal.userId
        ? allow()
        : deny("not_resource_member", true);
    },
  ],
  [
    AUTHORIZATION_ACTIONS.WORKER_EXECUTE,
    (request: AuthorizationRequest) => {
      if (request.principal.kind !== "service" || request.source !== "worker") {
        return deny("principal_source_mismatch");
      }
      const capability = request.context?.capability;
      if (typeof capability !== "string" || !capability) {
        return deny("invalid_context");
      }
      return request.principal.capabilities.includes(capability)
        ? allow()
        : deny("worker_capability_denied");
    },
  ],
]);

/**
 * Transport-neutral, fail-closed authorization registry. HTTP, Socket.IO and
 * background workers all submit the same principal/action/resource request.
 */
export class AuthorizationService {
  private readonly policies: ReadonlyMap<string, AuthorizationPolicy>;

  constructor(policies: ReadonlyMap<string, AuthorizationPolicy> = defaultPolicies) {
    this.policies = policies;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    if (!request || typeof request !== "object") {
      return deny("invalid_context", true);
    }
    if (!(["http", "socket", "worker"] as const).includes(request.source)) {
      return deny("invalid_context", true);
    }
    if (
      !request.principal ||
      typeof request.principal !== "object" ||
      typeof request.action !== "string" ||
      !request.action.trim()
    ) {
      return deny("invalid_context", true);
    }

    if (request.principal.kind === "user") {
      if (
        typeof request.principal.userId !== "string" ||
        !request.principal.userId.trim() ||
        !isUserRole(request.principal.role) ||
        typeof request.principal.isActive !== "boolean" ||
        typeof request.principal.isVerified !== "boolean"
      ) {
        return deny("invalid_context", true);
      }
      if (!request.principal.isActive) return deny("principal_inactive");
      if (!request.principal.isVerified) return deny("principal_unverified");
      if (request.source === "worker") return deny("principal_source_mismatch");
    } else if (request.principal.kind === "service") {
      if (
        typeof request.principal.serviceKey !== "string" ||
        !request.principal.serviceKey.trim() ||
        !Array.isArray(request.principal.capabilities) ||
        !request.principal.capabilities.every(
          (capability) =>
            typeof capability === "string" && capability.trim().length > 0,
        )
      ) {
        return deny("invalid_context", true);
      }
      if (request.source !== "worker") {
        return deny("principal_source_mismatch");
      }
    } else {
      return deny("invalid_context", true);
    }

    const policy = this.policies.get(request.action);
    if (!policy) return deny("policy_not_found", true);

    try {
      return await policy(request);
    } catch {
      return deny("authorization_error", true);
    }
  }
}

export const authorizationService = new AuthorizationService();

export function createUserAuthorizationPrincipal(user: {
  _id?: unknown;
  id?: unknown;
  role?: unknown;
  isActive?: unknown;
  isVerified?: unknown;
}): UserAuthorizationPrincipal | null {
  const userId = String(user._id ?? user.id ?? "");
  if (!userId || !isUserRole(user.role)) return null;

  return Object.freeze({
    kind: "user" as const,
    userId,
    role: user.role,
    isActive: user.isActive === true,
    isVerified: user.isVerified === true,
  });
}
