import type { Request, Response } from "express";
import {
  ChatRoomFlowValidationError,
  parseChatMessageHistoryQuery,
  parseChatRoomListQuery,
  parseMuteChatRoomBody,
  parseReadChatRoomBody,
  parseSendChatMessageBody,
} from "../../contracts/chatRoomFlow";
import { parsePublishProgramAnnouncementBody } from "../../contracts/programAnnouncements";
import {
  chatRoomService,
  type ChatActor,
  type ChatRoomService,
} from "../../services/chat/ChatRoomService";
import { socketService } from "../../services/infrastructure/SocketService";
import { sendChatRoomHttpError } from "./ChatRoomHttpErrorResponder";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(path: string): never {
  throw new ChatRoomFlowValidationError([
    Object.freeze({ path, msg: "Required request context is missing" }),
  ]);
}

function actor(req: Request): ChatActor {
  const id = req.userId;
  const role = req.userRole ?? req.user?.role;
  if (!id || !role) return invalid("actor");
  return Object.freeze({ id, role });
}

function idempotencyKey(req: Request): string {
  const value = req.get("Idempotency-Key");
  if (!value || !UUID_PATTERN.test(value)) return invalid("Idempotency-Key");
  return value.toLowerCase();
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

interface ChatUnreadEmitter {
  emitChatUnreadUpdate(
    userId: string,
    update: {
      readonly conversationId: string;
      readonly roomUnreadCount: number;
      readonly chatUnreadTotal: number;
      readonly lastReadSequence: number;
    },
  ): boolean;
}

export class ChatRoomController {
  constructor(
    private readonly service: ChatRoomService = chatRoomService,
    private readonly unreadEmitter: ChatUnreadEmitter = socketService,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const currentActor = actor(req);
      const data = await this.service.list(
        currentActor.id,
        parseChatRoomListQuery(req.query),
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  unreadCount = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const data = await this.service.unreadTotal(actor(req).id);
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  get = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const currentActor = actor(req);
      const data = await this.service.get(
        currentActor.id,
        req.params.conversationId ?? "",
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  getProgramRoomLink = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const data = await this.service.getProgramRoomLink(
        actor(req).id,
        req.params.programId ?? "",
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  history = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const currentActor = actor(req);
      const data = await this.service.history(
        currentActor.id,
        req.params.conversationId ?? "",
        parseChatMessageHistoryQuery(req.query),
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  send = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const currentActor = actor(req);
      const body = parseSendChatMessageBody(req.body);
      const data = await this.service.send({
        conversationId: req.params.conversationId ?? "",
        ...body,
        actor: currentActor,
        idempotencyKey: idempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(201).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  publishAnnouncement = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const currentActor = actor(req);
      const body = parsePublishProgramAnnouncementBody(req.body);
      const data = await this.service.publishAnnouncement({
        conversationId: req.params.conversationId ?? "",
        ...body,
        actor: currentActor,
        idempotencyKey: idempotencyKey(req),
        correlationId: req.correlationId,
      });
      res.status(201).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  markRead = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const currentActor = actor(req);
      const data = await this.service.markRead({
        conversationId: req.params.conversationId ?? "",
        ...parseReadChatRoomBody(req.body),
        actor: currentActor,
        correlationId: req.correlationId,
      });
      // The database result is authoritative. A best-effort user-scoped emit
      // synchronizes this account's other tabs without turning an already
      // committed read marker into an HTTP failure if Socket.IO is unavailable.
      try {
        this.unreadEmitter.emitChatUnreadUpdate(currentActor.id, {
          conversationId: data.conversationId,
          roomUnreadCount: data.unreadCount,
          chatUnreadTotal: data.chatUnreadTotal,
          lastReadSequence: data.lastReadSequence,
        });
      } catch {
        // Reconnect/list/unread-count reconciliation remains the recovery path.
      }
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };

  mute = async (req: Request, res: Response): Promise<void> => {
    noStore(res);
    try {
      const data = await this.service.setMuted({
        conversationId: req.params.conversationId ?? "",
        ...parseMuteChatRoomBody(req.body),
        actor: actor(req),
        correlationId: req.correlationId,
      });
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendChatRoomHttpError(res, error);
    }
  };
}

export const chatRoomController = new ChatRoomController();
