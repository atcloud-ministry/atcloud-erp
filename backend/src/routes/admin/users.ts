import { Router } from "express";
import UserReadController from "../../controllers/UserReadController";
import { authenticate, authorizePermission } from "../../middleware/auth";
import { PERMISSIONS } from "../../utils/roleUtils";

const router = Router();
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.MANAGE_USERS));
router.get("/", UserReadController.listAdminUsers);
router.get("/:id", UserReadController.getAdminUser);

export default router;
