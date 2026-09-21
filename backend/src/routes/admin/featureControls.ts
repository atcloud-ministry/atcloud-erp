import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { featureControlController } from "../../controllers/runtime/FeatureControlController";
import { authenticate, authorizePermission } from "../../middleware/auth";
import { PERMISSIONS } from "../../utils/roleUtils";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.MANAGE_SYSTEM_SETTINGS));
router.get("/", featureControlController.getOperationalRuntimeConfig);
router.patch(
  "/alumni-network",
  featureControlController.updateAlumniNetworkMode,
);

export default router;
