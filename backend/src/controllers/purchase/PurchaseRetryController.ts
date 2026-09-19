import { Request, Response } from "express";
import mongoose from "mongoose";
import Purchase from "../../models/Purchase";
import type { IProgram } from "../../models/Program";
import { createCheckoutSession as stripeCreateCheckoutSession } from "../../services/stripeService";
import { resolveCanonicalProgramPurchaseRole } from "../../services/programs/ProgramPurchaseRolePreflightService";
import type { IPurchase } from "../../models/Purchase";

/**
 * PurchaseRetryController
 * Handles retrying failed or pending purchases
 */
class PurchaseRetryController {
  private static async reservePendingAttempt(
    purchase: IPurchase,
    ownerId: mongoose.Types.ObjectId,
    fields: Record<string, unknown> = {},
  ): Promise<number | null> {
    const versionedPurchase = purchase as IPurchase & { __v?: number };
    const observedVersion = versionedPurchase.__v ?? 0;
    const update: Record<string, unknown> = {
      $unset: {
        stripeSessionId: 1,
        stripePaymentIntentId: 1,
      },
      $inc: { __v: 1 },
    };
    if (Object.keys(fields).length > 0) update.$set = fields;

    const result = await Purchase.updateOne(
      {
        _id: purchase._id,
        userId: ownerId,
        status: "pending",
        __v: observedVersion,
      },
      update,
      { runValidators: true },
    );
    if (result.matchedCount !== 1) return null;

    Object.assign(purchase, fields, {
      stripeSessionId: undefined,
      stripePaymentIntentId: undefined,
      __v: observedVersion + 1,
    });
    return observedVersion + 1;
  }

  private static async expireUnboundSession(sessionId: string): Promise<void> {
    try {
      const { stripe } = await import("../../services/stripeService");
      await stripe.checkout.sessions.expire(sessionId);
    } catch (error) {
      console.error("Failed to expire unbound retry session:", error);
    }
  }

  /**
   * Retry a pending purchase - creates a new checkout session
   * POST /api/purchases/retry/:id
   * Validates that user hasn't already purchased the program
   */
  static async retryPendingPurchase(
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

      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid purchase ID." });
        return;
      }

      // Find the pending purchase
      const pendingPurchase = await Purchase.findById(id)
        .populate("programId")
        .populate("eventId")
        .populate("membershipId");

      if (!pendingPurchase) {
        res
          .status(404)
          .json({ success: false, message: "Purchase not found." });
        return;
      }

      // Verify ownership
      if (
        pendingPurchase.userId.toString() !==
        (req.user._id as mongoose.Types.ObjectId).toString()
      ) {
        res.status(403).json({
          success: false,
          message: "You can only retry your own purchases.",
        });
        return;
      }

      // Verify it's still pending
      if (pendingPurchase.status !== "pending") {
        res.status(400).json({
          success: false,
          message: `Cannot retry a ${pendingPurchase.status} purchase.`,
        });
        return;
      }

      // CRITICAL: Check if user already has a completed purchase for this item
      let existingCompletedPurchase = null;
      if (pendingPurchase.purchaseType === "program") {
        existingCompletedPurchase = await Purchase.findOne({
          userId: req.user._id,
          programId: pendingPurchase.programId,
          purchaseType: "program",
          status: "completed",
          unenrolledAt: { $exists: false },
        });
      } else if (pendingPurchase.purchaseType === "event") {
        existingCompletedPurchase = await Purchase.findOne({
          userId: req.user._id,
          eventId: pendingPurchase.eventId,
          purchaseType: "event",
          status: "completed",
          unenrolledAt: { $exists: false },
        });
      } else if (pendingPurchase.purchaseType === "membership") {
        existingCompletedPurchase = await Purchase.findOne({
          userId: req.user._id,
          membershipId: pendingPurchase.membershipId,
          purchaseType: "membership",
          status: "completed",
          unenrolledAt: { $exists: false },
        });
      }

      if (existingCompletedPurchase) {
        const itemType =
          pendingPurchase.purchaseType === "event"
            ? "event"
            : pendingPurchase.purchaseType === "membership"
              ? "annual membership"
              : "program";
        res.status(400).json({
          success: false,
          message: `You have already purchased this ${itemType}. Check your purchase history.`,
        });
        return;
      }

      // Reserve this retry before any external Stripe call. Clearing the old
      // Stripe identities makes already-read success/failure events lose their
      // own identity-bound status CAS, while __v admits only one retry caller.
      let session;
      let reservedVersion: number;

      if (pendingPurchase.purchaseType === "program") {
        const program = pendingPurchase.programId as unknown as IProgram;
        if (!program || typeof program !== "object" || !("_id" in program)) {
          res.status(409).json({
            success: false,
            message:
              "This purchase's Program role needs staff review before retry.",
          });
          return;
        }
        const role = resolveCanonicalProgramPurchaseRole(program, {
          studentRoleId: pendingPurchase.studentRoleId,
          isClassRep: pendingPurchase.isClassRep === true,
        });
        if (role.status !== "resolved") {
          res.status(409).json({
            success: false,
            message:
              "This purchase's Program role needs staff review before retry.",
          });
          return;
        }
        const reservation = await PurchaseRetryController.reservePendingAttempt(
          pendingPurchase,
          req.user._id as mongoose.Types.ObjectId,
          {
            studentRoleId: role.studentRoleId,
            studentRoleName: role.studentRoleName,
          },
        );
        if (reservation == null) {
          res.status(409).json({
            success: false,
            message: "This purchase changed while retrying. Please refresh and try again.",
          });
          return;
        }
        reservedVersion = reservation;

        session = await stripeCreateCheckoutSession({
          userId: (req.user._id as mongoose.Types.ObjectId).toString(),
          userEmail: req.user.email,
          programId: (program._id as mongoose.Types.ObjectId).toString(),
          programTitle: program.title,
          fullPrice: pendingPurchase.fullPrice,
          classRepDiscount: pendingPurchase.classRepDiscount,
          earlyBirdDiscount: pendingPurchase.earlyBirdDiscount,
          finalPrice: pendingPurchase.finalPrice,
          isClassRep: pendingPurchase.isClassRep,
          isEarlyBird: pendingPurchase.isEarlyBird,
          purchaseId: pendingPurchase._id.toString(),
        });
      } else if (pendingPurchase.purchaseType === "event") {
        // Event purchase retry
        const { default: Event } = await import("../../models/Event");
        const event = await Event.findById(pendingPurchase.eventId);

        if (!event) {
          res.status(404).json({
            success: false,
            message: "Event not found.",
          });
          return;
        }

        const reservation = await PurchaseRetryController.reservePendingAttempt(
          pendingPurchase,
          req.user._id as mongoose.Types.ObjectId,
        );
        if (reservation == null) {
          res.status(409).json({
            success: false,
            message: "This purchase changed while retrying. Please refresh and try again.",
          });
          return;
        }
        reservedVersion = reservation;

        const { stripe } = await import("../../services/stripeService");

        session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: event.title,
                  description: `Event on ${new Date(
                    event.date
                  ).toLocaleDateString()}`,
                },
                unit_amount: Math.round(pendingPurchase.finalPrice),
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.FRONTEND_URL}/dashboard/events/${event._id}/purchase/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.FRONTEND_URL}/dashboard/purchase/cancel?event_id=${event._id}`,
          customer_email: req.user.email,
          metadata: {
            userId: (req.user._id as mongoose.Types.ObjectId).toString(),
            eventId: (event._id as mongoose.Types.ObjectId).toString(),
            purchaseId: pendingPurchase._id.toString(),
          },
        });
      } else {
        const membership = pendingPurchase.membershipId as unknown as {
          _id: mongoose.Types.ObjectId;
          title: string;
          price: number;
        };
        const reservation = await PurchaseRetryController.reservePendingAttempt(
          pendingPurchase,
          req.user._id as mongoose.Types.ObjectId,
        );
        if (reservation == null) {
          res.status(409).json({
            success: false,
            message: "This purchase changed while retrying. Please refresh and try again.",
          });
          return;
        }
        reservedVersion = reservation;
        const { createMembershipCheckoutSession } = await import(
          "../../services/stripeService"
        );

        session = await createMembershipCheckoutSession({
          userId: (req.user._id as mongoose.Types.ObjectId).toString(),
          userEmail: req.user.email,
          membershipId: membership._id.toString(),
          membershipTitle: membership.title,
          price: pendingPurchase.finalPrice,
          purchaseId: pendingPurchase._id.toString(),
        });
      }

      // Bind the returned session only to the reservation that created it.
      // A signed completion webhook may win in this short window; that is an
      // idempotent success when it stored this exact session ID.
      let bindResult;
      try {
        bindResult = await Purchase.updateOne(
          {
            _id: pendingPurchase._id,
            userId: req.user._id,
            status: "pending",
            __v: reservedVersion,
          },
          {
            $set: { stripeSessionId: session.id },
            $inc: { __v: 1 },
          },
          { runValidators: true },
        );
      } catch (error) {
        await PurchaseRetryController.expireUnboundSession(session.id);
        throw error;
      }

      if (bindResult.matchedCount !== 1) {
        const current = await Purchase.findById(pendingPurchase._id);
        const completedByThisSession =
          current?.status === "completed" &&
          current.stripeSessionId === session.id;
        if (!completedByThisSession) {
          await PurchaseRetryController.expireUnboundSession(session.id);
          res.status(409).json({
            success: false,
            message: "This purchase changed while the payment session was being created. Please refresh and try again.",
          });
          return;
        }
      }

      pendingPurchase.stripeSessionId = session.id;
      (pendingPurchase as IPurchase & { __v?: number }).__v =
        reservedVersion + 1;

      console.log(
        `Created new checkout session for pending purchase ${pendingPurchase.orderNumber}`
      );

      res.status(200).json({
        success: true,
        data: {
          sessionId: session.id,
          sessionUrl: session.url,
        },
      });
    } catch (error) {
      console.error("Error retrying purchase:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retry purchase.",
      });
    }
  }
}

export default PurchaseRetryController;
