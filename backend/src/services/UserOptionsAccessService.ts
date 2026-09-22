import type { IUser } from "../models";
import type { UserOptionsQuery } from "../contracts/userReadContracts";
import {
  authorizationService,
  createUserAuthorizationPrincipal,
} from "./authorization/AuthorizationService";
import { recordAuthorizationDenial } from "./authorization/AuthorizationAuditService";
import {
  AUTHORIZATION_ACTIONS,
  type AuthorizationRequest,
} from "./authorization/types";
import { PERMISSIONS } from "../utils/roleUtils";

export class UserOptionsAccessError extends Error {
  constructor(
    readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "UserOptionsAccessError";
  }
}

export class UserOptionsAccessService {
  static async assertCanRead(
    query: UserOptionsQuery,
    user: IUser,
    correlationId?: string,
  ): Promise<void> {
    const principal = createUserAuthorizationPrincipal({
      _id: user._id,
      role: user.role,
      isActive: user.isActive,
      isVerified: user.isVerified,
    });
    if (!principal) {
      throw new UserOptionsAccessError(403, "Insufficient permissions.");
    }

    const authorizationRequest: AuthorizationRequest = query.resourceId
      ? {
          source: "http",
          principal,
          action:
            query.context === "program-mentor"
              ? AUTHORIZATION_ACTIONS.PROGRAM_MANAGE
              : AUTHORIZATION_ACTIONS.EVENT_MANAGE,
          resource: {
            type:
              query.context === "program-mentor" ? "program" : "event",
            id: query.resourceId,
          },
        }
      : {
          source: "http",
          principal,
          action: AUTHORIZATION_ACTIONS.HAS_PERMISSION,
          context: { permission: PERMISSIONS.CREATE_EVENT },
        };
    const decision = await authorizationService.authorize(
      authorizationRequest,
    );

    if (decision.allowed) return;

    recordAuthorizationDenial(
      authorizationRequest,
      decision,
      correlationId,
    );

    if (decision.reasonCode === "resource_not_found") {
      throw new UserOptionsAccessError(
        404,
        query.context === "program-mentor"
          ? "Program not found."
          : "Event not found.",
      );
    }

    if (decision.reasonCode === "authorization_error") {
      throw new Error("User options authorization check failed.");
    }

    throw new UserOptionsAccessError(
      403,
      `Insufficient permissions for ${query.context} user options.`,
    );
  }
}
