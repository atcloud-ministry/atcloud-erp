import type { FilterQuery } from "mongoose";
import type { IMessage } from "../../models/Message";
import { buildMessageRoleVisibilityClauses } from "../../utils/messageAuthorization";

/**
 * Scope a message lookup to users that were included in its persisted
 * recipient set and still satisfy its current role restriction. Returning no
 * document for an unknown message, a non-recipient, or a role mismatch avoids
 * exposing message existence and prevents unauthorized state changes.
 */
export function buildRecipientMessageFilter(
  messageId: string,
  userId: string,
  userRole?: string
): FilterQuery<IMessage> {
  return {
    _id: messageId,
    isActive: true,
    [`userStates.${userId}`]: { $exists: true },
    $or: buildMessageRoleVisibilityClauses(userRole),
  };
}
