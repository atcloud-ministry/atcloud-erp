import { Router } from "express";
import { authenticate, authorizePermission } from "../middleware/auth";
import { AuditLogController } from "../controllers/auditLogController";
import { PERMISSIONS } from "../utils/roleUtils";

const router = Router();

// GET /api/audit-logs - Get audit logs with pagination and filtering (auth required)
router.get(
  "/",
  authenticate,
  authorizePermission(PERMISSIONS.ACCESS_AUDIT_LOGS),
  AuditLogController.getAuditLogs,
);

export default router;
