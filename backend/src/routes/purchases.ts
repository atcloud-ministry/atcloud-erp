import { Router } from "express";
import PurchaseCheckoutController from "../controllers/purchase/PurchaseCheckoutController";
import PurchaseVerificationController from "../controllers/purchase/PurchaseVerificationController";
import PurchaseHistoryController from "../controllers/purchase/PurchaseHistoryController";
import PurchasePendingController from "../controllers/purchase/PurchasePendingController";
import PurchaseRetryController from "../controllers/purchase/PurchaseRetryController";
import PurchaseAccessController from "../controllers/purchase/PurchaseAccessController";
import PurchaseRefundController from "../controllers/purchase/PurchaseRefundController";
import PurchaseRetrievalController from "../controllers/purchase/PurchaseRetrievalController";
import PurchaseReceiptController from "../controllers/purchase/PurchaseReceiptController";
import PurchaseCancellationController from "../controllers/purchase/PurchaseCancellationController";
import { authenticate } from "../middleware/auth";

const router = Router();

// All purchase routes require authentication
router.use(authenticate);

// Create checkout session for program purchase
router.post(
  "/create-checkout-session",
  PurchaseCheckoutController.createCheckoutSession
);

// Verify Stripe session and get purchase details
router.get("/verify-session/:sessionId", PurchaseVerificationController.verifySession);

// Get user's purchase history
router.get("/my-purchases", PurchaseHistoryController.getMyPurchases);

// Get user's pending purchases (with auto-cleanup of expired sessions)
router.get("/my-pending-purchases", PurchasePendingController.getMyPendingPurchases);

// Retry a pending purchase (creates new checkout session with duplicate check)
router.post("/retry/:id", PurchaseRetryController.retryPendingPurchase);

// Check if user has access to a program
router.post("/check-access/batch", PurchaseAccessController.checkProgramsAccess);

// Check if user has access to one program (kept for detail views)
router.get("/check-access/:programId", PurchaseAccessController.checkProgramAccess);

// Check refund eligibility for a purchase
router.get(
  "/refund-eligibility/:purchaseId",
  PurchaseRefundController.checkRefundEligibility
);

// Initiate a refund for a completed purchase
router.post("/refund", PurchaseRefundController.initiateRefund);

// Get specific purchase details
router.get("/:id", PurchaseRetrievalController.getPurchaseById);

// Get purchase receipt
router.get("/:id/receipt", PurchaseReceiptController.getPurchaseReceipt);

// Cancel a pending purchase
router.delete("/:id", PurchaseCancellationController.cancelPendingPurchase);

export default router;
