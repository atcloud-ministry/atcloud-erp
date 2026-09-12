import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { alumniInvitationController } from "../controllers/alumni/AlumniInvitationController";
import { requireAlumniNetworkWritable } from "../middleware/alumniNetworkFeatureGate";
import { authenticate } from "../middleware/auth";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.post(
  "/claim",
  requireAlumniNetworkWritable,
  alumniInvitationController.claim,
);

export default router;
