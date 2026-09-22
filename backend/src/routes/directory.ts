import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { alumniProfileController } from "../controllers/alumni/AlumniProfileController";
import { alumniDirectoryController } from "../controllers/alumni/AlumniDirectoryController";
import {
  requireAlumniNetworkReadable,
  requireAlumniNetworkWritable,
} from "../middleware/alumniNetworkFeatureGate";
import { authenticate, authorizePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/roleUtils";
import {
  directoryAccountLimiter,
  directoryIpLimiter,
} from "../middleware/rateLimiting";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);

router.get(
  "/me/preview",
  requireAlumniNetworkReadable,
  alumniProfileController.previewOwn,
);
router.get("/me", requireAlumniNetworkReadable, alumniProfileController.getOwn);
router.post(
  "/me/draft",
  requireAlumniNetworkWritable,
  alumniProfileController.ensureOwnDraft,
);
router.patch(
  "/me",
  requireAlumniNetworkWritable,
  alumniProfileController.updateOwn,
);
router.post(
  "/me/publish",
  requireAlumniNetworkWritable,
  alumniProfileController.publishOwn,
);
router.post(
  "/me/withdraw",
  requireAlumniNetworkWritable,
  alumniProfileController.withdrawOwn,
);

router.get(
  "/",
  directoryIpLimiter,
  directoryAccountLimiter,
  authorizePermission(PERMISSIONS.VIEW_USER_PROFILES),
  requireAlumniNetworkReadable,
  alumniDirectoryController.list,
);
router.get(
  "/:profileId",
  directoryIpLimiter,
  directoryAccountLimiter,
  authorizePermission(PERMISSIONS.VIEW_USER_PROFILES),
  requireAlumniNetworkReadable,
  alumniDirectoryController.get,
);

export default router;
