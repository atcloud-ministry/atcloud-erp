import { Router, type NextFunction, type Request, type Response } from "express";
import { alumniHelpRequestController } from "../controllers/alumni/AlumniHelpRequestController";
import {
  requireAlumniNetworkReadable,
  requireAlumniNetworkWritable,
} from "../middleware/alumniNetworkFeatureGate";
import { authenticate, authorizePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/roleUtils";

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.VIEW_USER_PROFILES));

router.get("/terms", requireAlumniNetworkReadable, alumniHelpRequestController.terms);
router.get(
  "/action-required-count",
  requireAlumniNetworkReadable,
  alumniHelpRequestController.actionRequiredCount,
);
router.get("/", requireAlumniNetworkReadable, alumniHelpRequestController.list);
router.post("/", requireAlumniNetworkWritable, alumniHelpRequestController.create);
router.get("/:requestId", requireAlumniNetworkReadable, alumniHelpRequestController.get);
// Read receipts only acknowledge content already shown to this participant.
router.post("/:requestId/read", requireAlumniNetworkReadable, alumniHelpRequestController.markRead);

const transitions = [
  ["request-information", "request_information"],
  ["provide-information", "provide_information"],
  ["propose-alternative", "propose_alternative"],
  ["confirm-alternative", "confirm_alternative"],
  ["reject-alternative", "reject_alternative"],
  ["accept", "accept"],
  ["decline", "decline"],
  ["withdraw", "withdraw"],
  ["start", "start"],
  ["complete", "complete"],
  ["close", "close"],
] as const;

for (const [path, action] of transitions) {
  router.post(
    `/:requestId/${path}`,
    requireAlumniNetworkWritable,
    alumniHelpRequestController.transition(action),
  );
}

router.post(
  "/:requestId/outcomes",
  requireAlumniNetworkWritable,
  alumniHelpRequestController.submitOutcome,
);
router.post(
  "/:requestId/outcomes/:outcomeId/confirm",
  requireAlumniNetworkWritable,
  alumniHelpRequestController.decideOutcome("confirm"),
);
router.post(
  "/:requestId/outcomes/:outcomeId/deny",
  requireAlumniNetworkWritable,
  alumniHelpRequestController.decideOutcome("deny"),
);

export default router;
