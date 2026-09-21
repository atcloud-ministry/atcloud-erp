import { Request, Response } from "express";
import mongoose from "mongoose";
import { Purchase } from "../../models";
import { processRefund } from "../../services/stripeService";
import { PurchaseEmailService } from "../../services/email/domains/PurchaseEmailService";
import {
  calculateRefundEligibility,
  getPurchaseItemDetails,
  persistPurchaseUnenrollment,
} from "../../services/PurchaseRefundService";
import { RefundRequestService } from "../../services/RefundRequestService";

/**
 * PurchaseRefundController
 * Handles refund requests and eligibility checks for purchases
 */
class PurchaseRefundController {
  /**
   * Check refund eligibility for a purchase
   * GET /api/purchases/refund-eligibility/:purchaseId
   */
  static async checkRefundEligibility(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      if (!req.user) {
        res
          .status(401)
          .json({ success: false, message: "Authentication required." });
        return;
      }

      const { purchaseId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(purchaseId)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid purchase ID." });
        return;
      }

      const purchase = await Purchase.findById(purchaseId)
        .populate("programId", "title")
        .populate("eventId", "title")
        .populate("membershipId", "title");

      if (!purchase) {
        res
          .status(404)
          .json({ success: false, message: "Purchase not found." });
        return;
      }

      // Verify ownership
      if (
        purchase.userId.toString() !==
        (req.user._id as mongoose.Types.ObjectId).toString()
      ) {
        res.status(403).json({
          success: false,
          message: "You don't have permission to refund this purchase.",
        });
        return;
      }

      // Check if purchase is eligible for refund
      const eligibility = calculateRefundEligibility(purchase);

      res.status(200).json({
        success: true,
        data: eligibility,
      });
    } catch (error) {
      console.error("Error checking refund eligibility:", error);
      res.status(500).json({
        success: false,
        message: "Failed to check refund eligibility.",
      });
    }
  }

  /**
   * Initiate a refund for a completed purchase
   * POST /api/purchases/refund
   * Body: { purchaseId: string }
   */
  static async initiateRefund(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res
          .status(401)
          .json({ success: false, message: "Authentication required." });
        return;
      }

      const { purchaseId } = req.body;

      if (!purchaseId || !mongoose.Types.ObjectId.isValid(purchaseId)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid purchase ID." });
        return;
      }

      const purchase = await Purchase.findById(purchaseId)
        .populate("programId", "title programType")
        .populate("eventId", "title")
        .populate("membershipId", "title");

      if (!purchase) {
        res
          .status(404)
          .json({ success: false, message: "Purchase not found." });
        return;
      }

      // Verify ownership
      if (
        purchase.userId.toString() !==
        (req.user._id as mongoose.Types.ObjectId).toString()
      ) {
        res.status(403).json({
          success: false,
          message: "You don't have permission to refund this purchase.",
        });
        return;
      }

      // Check eligibility
      const eligibility = calculateRefundEligibility(purchase);

      if (eligibility.requiresApproval) {
        const { request, created } =
          await RefundRequestService.createApprovalRequest({
            purchase,
            requester: req.user,
            source: "purchase_history",
            reason: eligibility.reason,
          });

        res.status(200).json({
          success: true,
          message: created
            ? "Your refund request has been sent to administrators for review."
            : "You already have a pending refund request for this purchase.",
          data: {
            purchaseId: purchase._id,
            orderNumber: purchase.orderNumber,
            status: "pending_approval",
            approvalRequired: true,
            refundRequestId: request._id,
            existingRequest: !created,
          },
        });
        return;
      }

      if (!eligibility.isEligible) {
        res.status(400).json({
          success: false,
          message: eligibility.reason || "Purchase is not eligible for refund.",
          data: eligibility,
        });
        return;
      }

      // Check if already refunding or refunded
      if (
        purchase.status === "refund_processing" ||
        purchase.status === "refunded"
      ) {
        res.status(400).json({
          success: false,
          message:
            "This purchase is already being refunded or has been refunded.",
        });
        return;
      }

      const { itemTitle } = getPurchaseItemDetails(purchase);

      // Update purchase status to refund_processing
      purchase.status = "refund_processing";
      purchase.refundInitiatedAt = new Date();
      purchase.refundFailureReason = undefined;
      await persistPurchaseUnenrollment(purchase, "refund_requested");

      // Send refund initiated email to user
      try {
        await PurchaseEmailService.sendRefundInitiatedEmail({
          userEmail: purchase.billingInfo.email,
          userName: purchase.billingInfo.fullName,
          orderNumber: purchase.orderNumber,
          programTitle: itemTitle,
          refundAmount: purchase.finalPrice,
          purchaseDate: purchase.purchaseDate,
        });
      } catch (emailError) {
        console.error("Failed to send refund initiated email:", emailError);
        // Continue with refund even if email fails
      }

      // Process refund with Stripe
      try {
        if (!purchase.stripePaymentIntentId) {
          throw new Error("No payment intent found for this purchase");
        }

        const refund = await processRefund({
          paymentIntentId: purchase.stripePaymentIntentId,
          amount: purchase.finalPrice,
          reason: "requested_by_customer",
          metadata: {
            purchaseId: purchase._id.toString(),
            orderNumber: purchase.orderNumber,
            userId: (req.user._id as mongoose.Types.ObjectId).toString(),
          },
        });

        // Update purchase with refund ID
        purchase.stripeRefundId = refund.id;
        await purchase.save();

        try {
          await RefundRequestService.notifyAdminsOfAutomaticRefund({
            purchase,
            requester: req.user,
            source: "purchase_history",
            refundId: refund.id,
          });
        } catch (adminNotifyError) {
          console.error(
            "Failed to notify admins of automatic refund:",
            adminNotifyError,
          );
        }

        // Note: The webhook handler will update status to 'refunded' and send completion email
        // when Stripe confirms the refund

        res.status(200).json({
          success: true,
          message:
            "Refund initiated successfully. You will receive an email confirmation shortly.",
          data: {
            purchaseId: purchase._id,
            orderNumber: purchase.orderNumber,
            refundId: refund.id,
            status: purchase.status,
          },
        });
      } catch (stripeError) {
        console.error("Stripe refund error:", stripeError);

        // Update purchase status to refund_failed
        purchase.status = "refund_failed";
        purchase.refundFailureReason =
          stripeError instanceof Error ? stripeError.message : "Unknown error";
        await purchase.save();

        // Send refund failed email
        try {
          await PurchaseEmailService.sendRefundFailedEmail({
            userEmail: purchase.billingInfo.email,
            userName: purchase.billingInfo.fullName,
            orderNumber: purchase.orderNumber,
            programTitle: itemTitle,
            failureReason: purchase.refundFailureReason || "Unknown error",
          });
        } catch (emailError) {
          console.error("Failed to send refund failed email:", emailError);
        }

        res.status(500).json({
          success: false,
          message: "Failed to process refund. Please contact support.",
          error:
            stripeError instanceof Error
              ? stripeError.message
              : "Unknown error",
        });
      }
    } catch (error) {
      console.error("Error initiating refund:", error);
      res.status(500).json({
        success: false,
        message: "Failed to initiate refund.",
      });
    }
  }

}

export default PurchaseRefundController;
