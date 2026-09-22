import { Request, Response } from "express";
import mongoose from "mongoose";
import { AnnualMembership, Purchase, Program } from "../../models";
import { hasAnnualMembershipAccessToProgram } from "../../services/AnnualMembershipAccessService";

type ProgramAccessReason =
  | "admin"
  | "creator"
  | "mentor"
  | "class_rep"
  | "membership"
  | "purchased"
  | "not_purchased";

interface ProgramAccessResult {
  programId: string;
  hasAccess: boolean;
  reason: ProgramAccessReason;
}

const MAX_BATCH_PROGRAMS = 100;

/**
 * PurchaseAccessController
 * Handles checking program access for users
 */
class PurchaseAccessController {
  /**
   * Check access to multiple programs with a bounded set of database queries.
   * POST /api/purchases/check-access/batch
   */
  static async checkProgramsAccess(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res
          .status(401)
          .json({ success: false, message: "Authentication required." });
        return;
      }

      const submittedIds = req.body?.programIds;
      if (!Array.isArray(submittedIds) || submittedIds.length === 0) {
        res.status(400).json({
          success: false,
          message: "programIds must be a non-empty array.",
        });
        return;
      }

      if (submittedIds.length > MAX_BATCH_PROGRAMS) {
        res.status(400).json({
          success: false,
          message: `No more than ${MAX_BATCH_PROGRAMS} program IDs may be checked at once.`,
        });
        return;
      }

      const submittedProgramIds = submittedIds.map((id: unknown) =>
        String(id).trim(),
      );
      if (
        submittedProgramIds.some(
          (programId) => !mongoose.Types.ObjectId.isValid(programId),
        )
      ) {
        res.status(400).json({
          success: false,
          message: "Every program ID must be valid.",
        });
        return;
      }

      const programIds = Array.from(
        new Set(
          submittedProgramIds.map((programId) =>
            new mongoose.Types.ObjectId(programId).toString(),
          ),
        ),
      );

      const objectIds = programIds.map(
        (programId) => new mongoose.Types.ObjectId(programId),
      );
      const userId = req.user._id;

      const [programs, programPurchases, memberships] = await Promise.all([
        Program.find({ _id: { $in: objectIds } }).select(
          "_id createdBy mentors adminEnrollments",
        ),
        Purchase.find({
          userId,
          programId: { $in: objectIds },
          purchaseType: "program",
          status: "completed",
          unenrolledAt: { $exists: false },
        }).select("programId isClassRep"),
        AnnualMembership.find({
          programs: { $in: objectIds },
          isActive: true,
        }).select("_id programs"),
      ]);

      const purchaseReasonByProgram = new Map<
        string,
        "class_rep" | "purchased"
      >();
      for (const purchase of programPurchases) {
        if (!purchase.programId) continue;
        const programId = String(purchase.programId);
        const reason = purchase.isClassRep ? "class_rep" : "purchased";
        if (
          reason === "class_rep" ||
          !purchaseReasonByProgram.has(programId)
        ) {
          purchaseReasonByProgram.set(programId, reason);
        }
      }

      const membershipIds = memberships.map((membership) => membership._id);
      const membershipPurchases =
        membershipIds.length === 0
          ? []
          : await Purchase.find({
              userId,
              membershipId: { $in: membershipIds },
              purchaseType: "membership",
              status: "completed",
              unenrolledAt: { $exists: false },
            }).select("membershipId");
      const purchasedMembershipIds = new Set(
        membershipPurchases
          .map((purchase) => purchase.membershipId)
          .filter(Boolean)
          .map(String),
      );
      const membershipAccessPrograms = new Set<string>();
      for (const membership of memberships) {
        if (!purchasedMembershipIds.has(String(membership._id))) continue;
        for (const programId of membership.programs) {
          membershipAccessPrograms.add(String(programId));
        }
      }

      const programById = new Map(
        programs.map((program) => [String(program._id), program]),
      );
      const actorId = String(userId);
      const isAdministrator =
        req.user.role === "Super Admin" || req.user.role === "Administrator";

      const access: ProgramAccessResult[] = programIds.map((programId) => {
        const program = programById.get(programId);
        if (!program) {
          return { programId, hasAccess: false, reason: "not_purchased" };
        }

        const purchaseReason = purchaseReasonByProgram.get(programId);
        if (purchaseReason) {
          return { programId, hasAccess: true, reason: purchaseReason };
        }
        if (membershipAccessPrograms.has(programId)) {
          return { programId, hasAccess: true, reason: "membership" };
        }
        if (isAdministrator) {
          return { programId, hasAccess: true, reason: "admin" };
        }
        if (program.createdBy && String(program.createdBy) === actorId) {
          return { programId, hasAccess: true, reason: "creator" };
        }
        if (
          program.mentors?.some(
            (mentor: { userId: mongoose.Types.ObjectId }) =>
              String(mentor.userId) === actorId,
          )
        ) {
          return { programId, hasAccess: true, reason: "mentor" };
        }

        const isClassRep = program.adminEnrollments?.classReps?.some(
          (id: mongoose.Types.ObjectId) => String(id) === actorId,
        );
        if (isClassRep) {
          return { programId, hasAccess: true, reason: "class_rep" };
        }
        const isMentee = program.adminEnrollments?.mentees?.some(
          (id: mongoose.Types.ObjectId) => String(id) === actorId,
        );
        if (isMentee) {
          return { programId, hasAccess: true, reason: "purchased" };
        }

        return { programId, hasAccess: false, reason: "not_purchased" };
      });

      res.status(200).json({ success: true, data: { access } });
    } catch (error) {
      console.error("Error checking program access in batch:", error);
      res.status(500).json({
        success: false,
        message: "Failed to check program access.",
      });
    }
  }

  /**
   * Check if user has access to a program
   * GET /api/purchases/check-access/:programId
   */
  static async checkProgramAccess(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res
          .status(401)
          .json({ success: false, message: "Authentication required." });
        return;
      }

      const { programId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(programId)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid program ID." });
        return;
      }

      const program = await Program.findById(programId);
      if (!program) {
        res.status(404).json({ success: false, message: "Program not found." });
        return;
      }

      const purchase = await Purchase.findOne({
        userId: req.user._id,
        programId: program._id,
        purchaseType: "program",
        status: "completed",
        unenrolledAt: { $exists: false },
      });

      if (purchase) {
        res.status(200).json({
          success: true,
          data: {
            hasAccess: true,
            reason: purchase.isClassRep ? "class_rep" : "purchased",
          },
        });
        return;
      }

      const hasMembershipAccess = await hasAnnualMembershipAccessToProgram({
        userId: req.user._id,
        programId: program._id,
      });

      if (hasMembershipAccess) {
        res.status(200).json({
          success: true,
          data: { hasAccess: true, reason: "membership" },
        });
        return;
      }

      // Super Admin and Administrator have access to all programs
      if (
        req.user.role === "Super Admin" ||
        req.user.role === "Administrator"
      ) {
        res.status(200).json({
          success: true,
          data: { hasAccess: true, reason: "admin" },
        });
        return;
      }

      // Check if user is the creator of this program (Leader who created it)
      const isCreator =
        program.createdBy && String(program.createdBy) === String(req.user._id);
      if (isCreator) {
        res.status(200).json({
          success: true,
          data: { hasAccess: true, reason: "creator" },
        });
        return;
      }

      // Check if user is a mentor of this program
      const isMentor = program.mentors?.some(
        (mentor: { userId: mongoose.Types.ObjectId }) =>
          mentor.userId.toString() ===
          (req.user!._id as mongoose.Types.ObjectId).toString(),
      );
      if (isMentor) {
        res.status(200).json({
          success: true,
          data: { hasAccess: true, reason: "mentor" },
        });
        return;
      }

      const isAdminEnrolled =
        program.adminEnrollments?.mentees?.some(
          (id: mongoose.Types.ObjectId) => id.toString() === String(req.user!._id),
        ) ||
        program.adminEnrollments?.classReps?.some(
          (id: mongoose.Types.ObjectId) => id.toString() === String(req.user!._id),
        );
      if (isAdminEnrolled) {
        res.status(200).json({
          success: true,
          data: {
            hasAccess: true,
            reason: program.adminEnrollments?.classReps?.some(
              (id: mongoose.Types.ObjectId) =>
                id.toString() === String(req.user!._id),
            )
              ? "class_rep"
              : "purchased",
          },
        });
        return;
      }

      // No access
      res.status(200).json({
        success: true,
        data: { hasAccess: false, reason: "not_purchased" },
      });
    } catch (error) {
      console.error("Error checking program access:", error);
      res.status(500).json({
        success: false,
        message: "Failed to check program access.",
      });
    }
  }
}

export default PurchaseAccessController;
