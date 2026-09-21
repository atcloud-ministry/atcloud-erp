import Message from "../../models/Message";
import User from "../../models/User";
import { chatRoomService } from "../chat/ChatRoomService";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
export const MAX_PUSH_BADGE_COUNT = 99;

interface BadgeUserState {
  readonly id: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly isVerified: boolean;
}

interface BadgeUserReader {
  load(userId: string): Promise<BadgeUserState | null>;
}

interface ChatUnreadReader {
  unreadTotal(userId: string): Promise<{ readonly chatUnreadTotal: number }>;
}

interface SystemUnreadReader {
  getUnreadCountsForUser(
    userId: string,
    userRole: string,
  ): Promise<{ readonly systemMessages: number }>;
}

export interface NotificationBadgeCountDependencies {
  readonly users?: BadgeUserReader;
  readonly chat?: ChatUnreadReader;
  readonly systemMessages?: SystemUnreadReader;
}

const DEFAULT_USERS: BadgeUserReader = {
  async load(userId) {
    if (!OBJECT_ID_PATTERN.test(userId)) return null;
    const user = await User.findById(userId)
      .select({ role: 1, isActive: 1, isVerified: 1 })
      .lean<{
        _id: unknown;
        role?: unknown;
        isActive?: unknown;
        isVerified?: unknown;
      }>()
      .exec();
    if (!user || typeof user.role !== "string") return null;
    return Object.freeze({
      id: String(user._id),
      role: user.role,
      isActive: user.isActive === true,
      isVerified: user.isVerified === true,
    });
  },
};

const DEFAULT_SYSTEM_MESSAGES = Message as unknown as SystemUnreadReader;

function nonNegativeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

/**
 * Returns the absolute launcher count used by foreground and background PWA
 * updates. The operating-system badge is capped at the approved 99+ display
 * boundary; in-app counters keep their exact values.
 */
export class NotificationBadgeCountService {
  private readonly users: BadgeUserReader;
  private readonly chat: ChatUnreadReader;
  private readonly systemMessages: SystemUnreadReader;

  constructor(dependencies: NotificationBadgeCountDependencies = {}) {
    this.users = dependencies.users ?? DEFAULT_USERS;
    this.chat = dependencies.chat ?? chatRoomService;
    this.systemMessages =
      dependencies.systemMessages ?? DEFAULT_SYSTEM_MESSAGES;
  }

  async totalForUser(userId: string): Promise<number | null> {
    const user = await this.users.load(userId);
    if (
      !user ||
      user.id.toLowerCase() !== userId.toLowerCase() ||
      !user.isActive ||
      !user.isVerified
    ) {
      return null;
    }

    const [chat, system] = await Promise.all([
      this.chat.unreadTotal(user.id),
      this.systemMessages.getUnreadCountsForUser(user.id, user.role),
    ]);
    const total =
      nonNegativeCount(chat.chatUnreadTotal) +
      nonNegativeCount(system.systemMessages);
    return Math.min(total, MAX_PUSH_BADGE_COUNT);
  }
}

export const notificationBadgeCountService =
  new NotificationBadgeCountService();
