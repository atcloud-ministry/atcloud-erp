import { Router } from "express";
import OverviewAnalyticsController from "../controllers/analytics/OverviewAnalyticsController";
import UserAnalyticsController from "../controllers/analytics/UserAnalyticsController";
import EventAnalyticsController from "../controllers/analytics/EventAnalyticsController";
import EngagementAnalyticsController from "../controllers/analytics/EngagementAnalyticsController";
import AttendanceAnalyticsController from "../controllers/analytics/AttendanceAnalyticsController";
import ProgramAnalyticsController from "../controllers/analytics/ProgramAnalyticsController";
import DonationAnalyticsController from "../controllers/analytics/DonationAnalyticsController";
import FinancialAnalyticsController from "../controllers/analytics/FinancialAnalyticsController";
import TrendsAnalyticsController from "../controllers/analytics/TrendsAnalyticsController";
import ExportAnalyticsController from "../controllers/analytics/ExportAnalyticsController";
import RegistrationProfileKpiExportController from "../controllers/analytics/RegistrationProfileKpiExportController";
import { authenticate, authorizePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/roleUtils";
import { analyticsLimiter, exportLimiter } from "../middleware/rateLimiting";

const router = Router();

// All routes require authentication and analytics permissions
router.use(authenticate);
router.use(authorizePermission(PERMISSIONS.VIEW_SYSTEM_ANALYTICS));

// Analytics routes with rate limiting
router.get("/", analyticsLimiter, OverviewAnalyticsController.getAnalytics);
router.get("/users", analyticsLimiter, UserAnalyticsController.getUserAnalytics);
router.get("/events", analyticsLimiter, EventAnalyticsController.getEventAnalytics);
router.get(
  "/engagement",
  analyticsLimiter,
  EngagementAnalyticsController.getEngagementAnalytics
);
router.get(
  "/attendance",
  analyticsLimiter,
  AttendanceAnalyticsController.getAttendanceAnalytics
);
router.get(
  "/programs",
  analyticsLimiter,
  ProgramAnalyticsController.getProgramAnalytics
);
router.get(
  "/donations",
  analyticsLimiter,
  DonationAnalyticsController.getDonationAnalytics
);
router.get(
  "/financial-summary",
  analyticsLimiter,
  FinancialAnalyticsController.getFinancialSummary
);
router.get("/trends", analyticsLimiter, TrendsAnalyticsController.getTrends);
router.get(
  "/registration-profile-kpis/export",
  exportLimiter,
  RegistrationProfileKpiExportController.exportRegistrationProfileKpis,
);
router.get("/export", exportLimiter, ExportAnalyticsController.exportAnalytics);

export default router;
