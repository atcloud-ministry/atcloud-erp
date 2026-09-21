import { Request, Response } from "express";
import mongoose, { HydratedDocument } from "mongoose";
import {
  AuditLog,
  Program,
  Purchase,
  type IProgram,
  type IPurchase,
} from "../../models";
import { PurchaseEmailService } from "../../services/email/domains/PurchaseEmailService";
import { processRefund } from "../../services/stripeService";
import {
  calculateRefundEligibility,
  getPurchaseItemDetails,
  persistPurchaseUnenrollment,
} from "../../services/PurchaseRefundService";
import { RefundRequestService } from "../../services/RefundRequestService";
import { socketService } from "../../services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

type EnrollmentType = "mentee" | "classRep";
type ProgramDocument = HydratedDocument<IProgram>;
type PurchaseDocument = HydratedDocument<IPurchase>;

type EnrollmentContext = {
  program: ProgramDocument;
  purchase: PurchaseDocument | null;
  adminEnrollmentType: EnrollmentType | null;
};

export default class SelfUnenrollController {
  static async preview(req: Request, res: Response): Promise<void> {
    try {
      const context = await SelfUnenrollController.loadEnrollmentContext(
        req,
        res,
      );
      if (!context) return;

      const { purchase, adminEnrollmentType } = context;
      const enrollmentType = purchase?.isClassRep
        ? "classRep"
        : adminEnrollmentType || "mentee";
      const studentRoleId = purchase?.studentRoleId;
      const studentRoleName =
        purchase?.studentRoleName ||
        (enrollmentType === "classRep" ? "Class Representative" : "Mentee");

      if (!purchase) {
        res.status(200).json({
          success: true,
          data: {
            enrollmentType,
            studentRoleId,
            studentRoleName,
            isPaid: false,
            refundEligible: false,
            requiresApproval: false,
            refundAmount: 0,
            refundWindowExpired: false,
            reason: "No payment was collected for this enrollment.",
          },
        });
        return;
      }

      const eligibility = calculateRefundEligibility(purchase);
      res.status(200).json({
        success: true,
        data: {
          enrollmentType,
          isPaid: true,
          refundEligible: eligibility.isEligible,
          requiresApproval: eligibility.requiresApproval,
          refundAmount:
            eligibility.isEligible || eligibility.requiresApproval
              ? purchase.finalPrice
              : 0,
          studentRoleId,
          studentRoleName,
          daysRemaining: eligibility.daysRemaining,
          purchaseDate: eligibility.purchaseDate,
          refundDeadline: eligibility.refundDeadline,
          refundWindowExpired: eligibility.refundWindowExpired,
          reason: eligibility.reason,
        },
      });
    } catch (error) {
      console.error("Error preparing program unenroll preview:", error);
      res.status(500).json({
        success: false,
        message: "Failed to prepare unenrollment details.",
      });
    }
  }

  static async unenroll(req: Request, res: Response): Promise<void> {
    try {
      const context = await SelfUnenrollController.loadEnrollmentContext(
        req,
        res,
      );
      if (!context) return;

      const { program, purchase, adminEnrollmentType } = context;
      const userId = req.user!._id as mongoose.Types.ObjectId;

      if (!purchase) {
        const removedAdminEnrollment =
          SelfUnenrollController.removeAdminEnrollment(program, userId);
        if (removedAdminEnrollment) {
          await program.save();
          programMembershipMutationSyncTrigger.programAssignmentsChanged(
            String(program._id),
            {
              actor: {
                type: "user",
                id: userId.toString(),
                role: req.user!.role,
              },
              source: "http",
              correlationId: req.correlationId,
            },
          );
          socketService.disconnectUser(userId.toString());
        }

        await SelfUnenrollController.writeAuditLog(
          req,
          program,
          adminEnrollmentType || "mentee",
          {
            refundStatus: "not_applicable",
          },
        );

        res.status(200).json({
          success: true,
          message: "You have been unenrolled from this program.",
          data: {
            refundStatus: "not_applicable",
            enrollmentType: adminEnrollmentType || "mentee",
            studentRoleName:
              adminEnrollmentType === "classRep"
                ? "Class Representative"
                : "Mentee",
          },
        });
        return;
      }

      const enrollmentType = purchase.isClassRep ? "classRep" : "mentee";
      const studentRoleId = purchase.studentRoleId;
      const studentRoleName =
        purchase.studentRoleName ||
        (enrollmentType === "classRep" ? "Class Representative" : "Mentee");
      const eligibility = calculateRefundEligibility(purchase);
      const { itemTitle } = getPurchaseItemDetails(purchase);

      if (eligibility.requiresApproval) {
        const { request, created } =
          await RefundRequestService.createApprovalRequest({
            purchase,
            requester: req.user!,
            source: "program_unenroll",
            reason: eligibility.reason,
          });

        await SelfUnenrollController.writeAuditLog(
          req,
          program,
          enrollmentType,
          {
            refundStatus: "pending_approval",
            refundRequestId: String(request._id),
            existingRequest: !created,
          },
        );

        res.status(200).json({
          success: true,
          message: created
            ? "Your unenrollment and refund request has been sent to administrators for review."
            : "You already have a pending unenrollment and refund request for this program.",
          data: {
            refundStatus: "pending_approval",
            refundRequestId: request._id,
            existingRequest: !created,
            enrollmentType,
            studentRoleId,
            studentRoleName,
          },
        });
        return;
      }

      if (!eligibility.isEligible) {
        const removedAdminEnrollment =
          SelfUnenrollController.removeAdminEnrollment(program, userId);
        if (removedAdminEnrollment) {
          await program.save();
        }

        await persistPurchaseUnenrollment(
          purchase,
          "self_unenroll_no_refund",
        );
        await SelfUnenrollController.writeAuditLog(
          req,
          program,
          enrollmentType,
          {
            refundStatus: "not_eligible",
            reason: eligibility.reason,
          },
        );

        res.status(200).json({
          success: true,
          message:
            "You have been unenrolled from this program. No refund was issued.",
          data: {
            refundStatus: "not_eligible",
            enrollmentType,
            studentRoleId,
            studentRoleName,
            reason: eligibility.reason,
          },
        });
        return;
      }

      const removedAdminEnrollment =
        SelfUnenrollController.removeAdminEnrollment(program, userId);
      if (removedAdminEnrollment) {
        await program.save();
      }

      purchase.status = "refund_processing";
      purchase.refundInitiatedAt = new Date();
      purchase.refundFailureReason = undefined;
      await persistPurchaseUnenrollment(purchase, "self_unenroll_refund");

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
      }

      try {
        const refund = await processRefund({
          paymentIntentId: purchase.stripePaymentIntentId!,
          amount: purchase.finalPrice,
          reason: "requested_by_customer",
          metadata: {
            purchaseId: String(purchase._id),
            orderNumber: purchase.orderNumber,
            userId: userId.toString(),
            source: "program_self_unenroll",
          },
        });

        purchase.stripeRefundId = refund.id;
        await purchase.save();

        try {
          await RefundRequestService.notifyAdminsOfAutomaticRefund({
            purchase,
            requester: req.user!,
            source: "program_unenroll",
            refundId: refund.id,
          });
        } catch (adminNotifyError) {
          console.error(
            "Failed to notify admins of automatic refund:",
            adminNotifyError,
          );
        }

        await SelfUnenrollController.writeAuditLog(
          req,
          program,
          enrollmentType,
          {
            refundStatus: "processing",
            refundId: refund.id,
          },
        );

        res.status(200).json({
          success: true,
          message:
            "You have been unenrolled from this program. Your refund request has been submitted.",
          data: {
            refundStatus: "processing",
            refundId: refund.id,
            enrollmentType,
            studentRoleId,
            studentRoleName,
          },
        });
      } catch (stripeError) {
        console.error(
          "Stripe refund error during program unenroll:",
          stripeError,
        );

        purchase.status = "refund_failed";
        purchase.refundFailureReason =
          stripeError instanceof Error ? stripeError.message : "Unknown error";
        await purchase.save();

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

        await SelfUnenrollController.writeAuditLog(
          req,
          program,
          enrollmentType,
          {
            refundStatus: "failed",
            reason: purchase.refundFailureReason,
          },
        );

        res.status(200).json({
          success: true,
          message:
            "You have been unenrolled from this program, but the automatic refund request failed. Please contact support.",
          data: {
            refundStatus: "failed",
            enrollmentType,
            studentRoleId,
            studentRoleName,
            reason: purchase.refundFailureReason,
          },
        });
      }
    } catch (error) {
      console.error("Error unenrolling from program:", error);
      res.status(500).json({
        success: false,
        message: "Failed to unenroll from program.",
      });
    }
  }

  private static async loadEnrollmentContext(
    req: Request,
    res: Response,
  ): Promise<EnrollmentContext | null> {
    if (!req.user) {
      res
        .status(401)
        .json({ success: false, message: "Authentication required." });
      return null;
    }

    if (
      req.user.role === "Super Admin" ||
      req.user.role === "Administrator"
    ) {
      res.status(403).json({
        success: false,
        message:
          "Administrators should use the administrator enrollment controls.",
      });
      return null;
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res
        .status(400)
        .json({ success: false, message: "Invalid program ID." });
      return null;
    }

    const program = await Program.findById(id);
    if (!program) {
      res
        .status(404)
        .json({ success: false, message: "Program not found." });
      return null;
    }

    const userId = req.user._id as mongoose.Types.ObjectId;
    const purchase = (await Purchase.findOne({
      purchaseType: "program",
      programId: program._id,
      userId,
      status: "completed",
      unenrolledAt: { $exists: false },
    })
      .sort({ purchaseDate: -1 })
      .populate("programId", "title programType")) as PurchaseDocument | null;

    const adminEnrollmentType =
      SelfUnenrollController.getAdminEnrollmentType(program, userId);

    if (!purchase && !adminEnrollmentType) {
      res.status(400).json({
        success: false,
        message: "You are not currently enrolled in this program.",
      });
      return null;
    }

    return { program, purchase, adminEnrollmentType };
  }

  private static getAdminEnrollmentType(
    program: NonNullable<EnrollmentContext["program"]>,
    userId: mongoose.Types.ObjectId,
  ): EnrollmentType | null {
    const isMentee =
      program.adminEnrollments?.mentees?.some(
        (id: mongoose.Types.ObjectId) => id.toString() === userId.toString(),
      ) ?? false;
    if (isMentee) return "mentee";

    const isClassRep =
      program.adminEnrollments?.classReps?.some(
        (id: mongoose.Types.ObjectId) => id.toString() === userId.toString(),
      ) ?? false;
    return isClassRep ? "classRep" : null;
  }

  private static removeAdminEnrollment(
    program: NonNullable<EnrollmentContext["program"]>,
    userId: mongoose.Types.ObjectId,
  ): boolean {
    let removed = false;
    const userIdText = userId.toString();

    if (program.adminEnrollments?.mentees) {
      const originalLength = program.adminEnrollments.mentees.length;
      program.adminEnrollments.mentees = program.adminEnrollments.mentees.filter(
        (id: mongoose.Types.ObjectId) => id.toString() !== userIdText,
      );
      removed =
        removed || program.adminEnrollments.mentees.length !== originalLength;
    }

    if (program.adminEnrollments?.classReps) {
      const originalLength = program.adminEnrollments.classReps.length;
      program.adminEnrollments.classReps =
        program.adminEnrollments.classReps.filter(
          (id: mongoose.Types.ObjectId) => id.toString() !== userIdText,
        );
      removed =
        removed || program.adminEnrollments.classReps.length !== originalLength;
    }

    return removed;
  }

  private static async writeAuditLog(
    req: Request,
    program: NonNullable<EnrollmentContext["program"]>,
    enrollmentType: EnrollmentType,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await AuditLog.create({
        action: "program_self_unenroll",
        actor: {
          id: req.user!._id,
          role: req.user!.role,
          email: req.user!.email,
        },
        targetModel: "Program",
        targetId: program._id,
        details: {
          programTitle: program.title,
          enrollmentType,
          ...details,
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent") || "unknown",
      });
    } catch (auditError) {
      console.error(
        "Failed to create audit log for self unenroll:",
        auditError,
      );
    }
  }
}
