import { Router, type NextFunction, type Request, type Response } from "express";
import { pushNotificationController } from "../controllers/push/PushNotificationController";
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
router.use(
  authorizeHttp({
    action: AUTHORIZATION_ACTIONS.NOTIFICATION_SETTINGS_MANAGE,
    resource: (req) => ({ type: "notification_settings", id: req.userId ?? "" }),
    concealDeniedResource: true,
  }),
);

router.get("/config", pushNotificationController.config);
router.get("/subscriptions", pushNotificationController.list);
router.post("/subscriptions", pushNotificationController.upsert);
router.delete(
  "/subscriptions/:installationId",
  pushNotificationController.unsubscribe,
);
router.get("/preferences", pushNotificationController.getPreferences);
router.patch("/preferences", pushNotificationController.setPreferences);

export default router;
