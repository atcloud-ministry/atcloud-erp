import { Router } from "express";
import UserReadController from "../controllers/UserReadController";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);
router.get("/", UserReadController.listUserOptions);

export default router;
