import { Request, Response } from "express";
import mongoose from "mongoose";
import { Program } from "../../models";
import AuditLog from "../../models/AuditLog";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

export default class AdminEnrollController {
  /**
   * Admin enrollment - allows Super Admin & Administrator to enroll as mentee or class rep
   *
   * @route POST /programs/:id/admin-enroll
   * @body { enrollAs: 'mentee' | 'classRep' }
   * @returns {Object} Updated program with admin enrollment
   */
  static async adminEnroll(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res
          .status(401)
          .json({ success: false, message: "Authentication required." });
        return;
      }

      // Only Super Admin and Administrator can use this endpoint
      if (
        req.user.role !== "Super Admin" &&
        req.user.role !== "Administrator"
      ) {
        res.status(403).json({
          success: false,
          message: "Only Super Admin and Administrator can enroll for free.",
        });
        return;
      }

      const { id } = req.params;
      const { enrollAs } = req.body;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid program ID." });
        return;
      }

      if (enrollAs !== "mentee" && enrollAs !== "classRep") {
        res.status(400).json({
          success: false,
          message: "enrollAs must be 'mentee' or 'classRep'.",
        });
        return;
      }

      const program = await Program.findById(id);
      if (!program) {
        res.status(404).json({ success: false, message: "Program not found." });
        return;
      }

      // Initialize adminEnrollments if it doesn't exist
      if (!program.adminEnrollments) {
        program.adminEnrollments = { mentees: [], classReps: [] };
      }
      if (!program.adminEnrollments.mentees) {
        program.adminEnrollments.mentees = [];
      }
      if (!program.adminEnrollments.classReps) {
        program.adminEnrollments.classReps = [];
      }

      // Check if user is already enrolled in either category
      const userId = req.user._id as mongoose.Types.ObjectId;
      const isMentee = program.adminEnrollments.mentees.some(
        (uid: mongoose.Types.ObjectId) => uid.toString() === userId.toString()
      );
      const isClassRep = program.adminEnrollments.classReps.some(
        (uid: mongoose.Types.ObjectId) => uid.toString() === userId.toString()
      );

      if (isMentee || isClassRep) {
        res.status(400).json({
          success: false,
          message:
            "You are already enrolled. Please unenroll first before enrolling as a different type.",
        });
        return;
      }

      // Add user to the appropriate list
      if (enrollAs === "mentee") {
        program.adminEnrollments.mentees.push(req.user._id);
      } else {
        program.adminEnrollments.classReps.push(req.user._id);
      }

      await program.save();
      programMembershipMutationSyncTrigger.programAssignmentsChanged(id, {
        actor: {
          type: "user",
          id: String(req.user._id),
          role: req.user.role,
        },
        source: "http",
        correlationId: req.correlationId,
      });

      // Audit log
      try {
        await AuditLog.create({
          action: "program_admin_enroll",
          actor: {
            id: req.user._id,
            role: req.user.role,
            email: req.user.email,
          },
          targetModel: "Program",
          targetId: id,
          details: {
            programTitle: program.title,
            enrollAs,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || "unknown",
        });
      } catch (auditError) {
        console.error(
          "Failed to create audit log for admin enrollment:",
          auditError
        );
      }

      res.status(200).json({
        success: true,
        message: `Successfully enrolled as ${enrollAs}.`,
        data: program,
      });
    } catch (error) {
      console.error("Error enrolling admin:", error);
      res.status(500).json({
        success: false,
        message: "Failed to enroll admin.",
      });
    }
  }
}
