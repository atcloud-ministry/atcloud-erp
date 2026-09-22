import { Router } from "express";
import UserReadController from "../controllers/UserReadController";
import { authenticate, authorizePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/roleUtils";

const router = Router();
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.VIEW_USER_PROFILES));
router.get("/members", UserReadController.listCommunityMembers);
router.get("/members/:id", UserReadController.getCommunityMember);

export default router;
