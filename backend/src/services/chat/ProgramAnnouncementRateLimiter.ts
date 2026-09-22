import mongoose, { type ClientSession, type Model } from "mongoose";
import ChatMessage, { type IChatMessage } from "../../models/ChatMessage";
import { chatAnnouncementRateLimited } from "./ChatRoomErrors";

export const PROGRAM_ANNOUNCEMENT_RATE_LIMIT = Object.freeze({
  windowMs: 60 * 60_000,
  limit: 10,
});

export interface ProgramAnnouncementRateLimitInput {
  readonly conversationId: string;
  readonly occurredAt: Date;
  readonly session: ClientSession;
}

interface ProgramAnnouncementRateLimitDataSource {
  loadOldestCreatedAtWithinWindow(input: {
    readonly conversationId: mongoose.Types.ObjectId;
    readonly windowStartExclusive: Date;
    readonly occurredAt: Date;
    readonly limit: number;
    readonly session: ClientSession;
  }): Promise<readonly Date[]>;
}

class MongoProgramAnnouncementRateLimitDataSource
  implements ProgramAnnouncementRateLimitDataSource
{
  constructor(
    private readonly messages: Model<IChatMessage> = ChatMessage,
  ) {}

  async loadOldestCreatedAtWithinWindow(input: {
    readonly conversationId: mongoose.Types.ObjectId;
    readonly windowStartExclusive: Date;
    readonly occurredAt: Date;
    readonly limit: number;
    readonly session: ClientSession;
  }): Promise<readonly Date[]> {
    const rows = await this.messages
      .find({
        conversationId: input.conversationId,
        kind: "announcement",
        createdAt: {
          $gt: input.windowStartExclusive,
          $lte: input.occurredAt,
        },
      })
      .select({ createdAt: 1, _id: 0 })
      .sort({ createdAt: 1 })
      .limit(input.limit)
      .session(input.session)
      .lean<Array<{ readonly createdAt: Date }>>()
      .exec();
    return Object.freeze(rows.map((row) => new Date(row.createdAt)));
  }
}

export interface ProgramAnnouncementRateLimiterDependencies {
  readonly dataSource?: ProgramAnnouncementRateLimitDataSource;
}

/** Durable rolling-window limiter evaluated inside the announcement transaction. */
export class ProgramAnnouncementRateLimiter {
  private readonly dataSource: ProgramAnnouncementRateLimitDataSource;

  constructor(dependencies: ProgramAnnouncementRateLimiterDependencies = {}) {
    this.dataSource =
      dependencies.dataSource ??
      new MongoProgramAnnouncementRateLimitDataSource();
  }

  async assertAllowed(input: ProgramAnnouncementRateLimitInput): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(input.conversationId)) {
      throw new TypeError(
        "Program announcement rate limit requires a Conversation ID.",
      );
    }
    if (
      !(input.occurredAt instanceof Date) ||
      Number.isNaN(input.occurredAt.getTime())
    ) {
      throw new TypeError(
        "Program announcement rate limit requires a valid occurredAt.",
      );
    }
    const occurredAt = new Date(input.occurredAt);
    const windowStartExclusive = new Date(
      occurredAt.getTime() - PROGRAM_ANNOUNCEMENT_RATE_LIMIT.windowMs,
    );
    const createdAts = await this.dataSource.loadOldestCreatedAtWithinWindow({
      conversationId: new mongoose.Types.ObjectId(input.conversationId),
      windowStartExclusive,
      occurredAt,
      limit: PROGRAM_ANNOUNCEMENT_RATE_LIMIT.limit,
      session: input.session,
    });
    if (createdAts.length < PROGRAM_ANNOUNCEMENT_RATE_LIMIT.limit) return;

    const oldest = createdAts[0];
    const retryAfterMs = oldest
      ? oldest.getTime() + PROGRAM_ANNOUNCEMENT_RATE_LIMIT.windowMs - occurredAt.getTime()
      : PROGRAM_ANNOUNCEMENT_RATE_LIMIT.windowMs;
    throw chatAnnouncementRateLimited(
      Math.max(1, Math.ceil(retryAfterMs / 1_000)),
    );
  }
}

export const programAnnouncementRateLimiter =
  new ProgramAnnouncementRateLimiter();
