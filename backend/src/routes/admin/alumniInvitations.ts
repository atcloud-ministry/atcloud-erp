import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { alumniInvitationController } from "../../controllers/alumni/AlumniInvitationController";
import {
  requireAlumniNetworkReadable,
  requireAlumniNetworkWritable,
} from "../../middleware/alumniNetworkFeatureGate";
import { authenticate, authorizePermission } from "../../middleware/auth";
import { PERMISSIONS } from "../../utils/roleUtils";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.MANAGE_USERS));
router.get(
  "/",
  requireAlumniNetworkReadable,
  alumniInvitationController.list,
);
router.post(
  "/:invitationId/reissue",
  requireAlumniNetworkWritable,
  alumniInvitationController.reissue,
);

export default router;
