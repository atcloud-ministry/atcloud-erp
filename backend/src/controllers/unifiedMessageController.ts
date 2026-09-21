import type { IMessage } from "../models/Message";
import TargetedSystemMessagesController, {
  type TargetedSystemMessageDeliveryOptions,
} from "./message/TargetedSystemMessagesController";

/**
 * Internal notification gateway retained for service callers. HTTP handlers
 * route directly to focused message controllers.
 */
export class UnifiedMessageController {
  static createTargetedSystemMessage(
    messageData: {
      title: string;
      content: string;
      type?: string;
      priority?: string;
      hideCreator?: boolean;
      targetRoles?: string[];
      metadata?: Record<string, unknown>;
      expiresAt?: Date;
    },
    targetUserIds: string[],
    creator?: {
      id: string;
      firstName: string;
      lastName: string;
      username: string;
      avatar?: string;
      gender: string;
      authLevel: string;
      roleInAtCloud?: string;
    },
    deliveryOptions?: TargetedSystemMessageDeliveryOptions,
  ): Promise<IMessage> {
    return TargetedSystemMessagesController.createTargetedSystemMessage(
      messageData,
      targetUserIds,
      creator,
      deliveryOptions,
    );
  }
}
