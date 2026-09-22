import { Router } from "express";
import { SearchController } from "../controllers/searchController";
import { authenticate, authorizePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/roleUtils";
import {
  validateSearch,
  handleValidationErrors,
} from "../middleware/validation";
import { searchLimiter } from "../middleware/rateLimiting";

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticate);
router.use(searchLimiter);

// Search users
router.get(
  "/users",
  authorizePermission(PERMISSIONS.MANAGE_USERS),
  validateSearch,
  handleValidationErrors,
  SearchController.searchUsers
);

// Search events
router.get(
  "/events",
  validateSearch,
  handleValidationErrors,
  SearchController.searchEvents
);

// Global search (users and events)
router.get(
  "/global",
  validateSearch,
  handleValidationErrors,
  SearchController.globalSearch
);

export default router;
