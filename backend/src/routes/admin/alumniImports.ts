import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { alumniImportController } from "../../controllers/alumni/AlumniImportController";
import {
  requireAlumniNetworkReadable,
  requireAlumniNetworkWritable,
} from "../../middleware/alumniNetworkFeatureGate";
import { uploadAlumniRosterCsv } from "../../middleware/alumniRosterUpload";
import { authenticate, authorizePermission } from "../../middleware/auth";
import { uploadLimiter } from "../../middleware/rateLimiting";
import { PERMISSIONS } from "../../utils/roleUtils";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.MANAGE_USERS));

router.get("/", requireAlumniNetworkReadable, alumniImportController.listBatches);
router.post(
  "/dry-run",
  requireAlumniNetworkWritable,
  uploadLimiter,
  uploadAlumniRosterCsv,
  alumniImportController.dryRun,
);
router.get(
  "/:batchId/rows",
  requireAlumniNetworkReadable,
  alumniImportController.listRows,
);
router.patch(
  "/:batchId/review",
  requireAlumniNetworkWritable,
  alumniImportController.review,
);
router.post(
  "/:batchId/apply",
  requireAlumniNetworkWritable,
  alumniImportController.apply,
);
router.post(
  "/:batchId/rerun",
  requireAlumniNetworkWritable,
  alumniImportController.rerun,
);
router.get(
  "/:batchId",
  requireAlumniNetworkReadable,
  alumniImportController.getBatch,
);

export default router;
