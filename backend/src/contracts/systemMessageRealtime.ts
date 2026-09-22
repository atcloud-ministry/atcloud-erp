export type SystemMessageRealtimeCreatorDTO = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  avatar?: string;
  gender: "male" | "female";
  authLevel: string;
  roleInAtCloud?: string;
};

/**
 * Recipient-safe message snapshot sent with `message_created`.
 *
 * This is intentionally narrower than the persisted Message document. In
 * particular, recipient state maps, targeting rules and persistence metadata
 * must never cross the realtime boundary.
 */
export type SystemMessageRealtimeDTO = {
  id: string;
  title: string;
  content: string;
  type: string;
  priority: string;
  createdAt: string;
  creator?: SystemMessageRealtimeCreatorDTO;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
};

export type SystemMessageCreatedRealtimeData = {
  message: SystemMessageRealtimeDTO;
};
