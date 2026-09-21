import { Router, type NextFunction, type Request, type Response } from "express";
import { chatRoomController } from "../controllers/chat/ChatRoomController";
import {
  requireAlumniNetworkReadable,
  requireAlumniNetworkWritable,
} from "../middleware/alumniNetworkFeatureGate";
import { authenticate, authorizePermission } from "../middleware/auth";
import { authorizeHttp } from "../middleware/authorization";
import { AUTHORIZATION_ACTIONS } from "../services/authorization/types";
import { PERMISSIONS } from "../utils/roleUtils";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.VIEW_USER_PROFILES));

const authorizeConversationRead = authorizeHttp({
  action: AUTHORIZATION_ACTIONS.CONVERSATION_READ,
  resource: (req) => ({
    type: "conversation",
    id: req.params.conversationId ?? "",
  }),
  concealDeniedResource: true,
});

router.get("/unread-count", requireAlumniNetworkReadable, chatRoomController.unreadCount);
router.get("/", requireAlumniNetworkReadable, chatRoomController.list);
router.get(
  "/program/:programId",
  requireAlumniNetworkReadable,
  chatRoomController.getProgramRoomLink,
);
router.get(
  "/:conversationId",
  requireAlumniNetworkReadable,
  authorizeConversationRead,
  chatRoomController.get,
);
router.get(
  "/:conversationId/messages",
  requireAlumniNetworkReadable,
  authorizeConversationRead,
  chatRoomController.history,
);
router.post(
  "/:conversationId/messages",
  // A retained member must be able to replay a canonically committed request
  // after an ACK is lost, even if the room was archived or runtime became
  // read-only. ChatRoomService gates genuinely new writes again in-transaction.
  requireAlumniNetworkReadable,
  authorizeHttp({
    action: AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
    resource: (req) => ({
      type: "conversation",
      id: req.params.conversationId ?? "",
    }),
    concealDeniedResource: true,
  }),
  chatRoomController.send,
);
router.post(
  "/:conversationId/announcements",
  requireAlumniNetworkReadable,
  authorizeHttp({
    action: AUTHORIZATION_ACTIONS.CONVERSATION_SEND_OR_REPLAY,
    resource: (req) => ({
      type: "conversation",
      id: req.params.conversationId ?? "",
    }),
    concealDeniedResource: true,
  }),
  chatRoomController.publishAnnouncement,
);
router.patch(
  "/:conversationId/read",
  requireAlumniNetworkWritable,
  authorizeHttp({
    action: AUTHORIZATION_ACTIONS.CONVERSATION_UPDATE_STATE,
    resource: (req) => ({
      type: "conversation",
      id: req.params.conversationId ?? "",
    }),
    concealDeniedResource: true,
  }),
  chatRoomController.markRead,
);
router.patch(
  "/:conversationId/mute",
  requireAlumniNetworkWritable,
  authorizeConversationRead,
  chatRoomController.mute,
);

export default router;
