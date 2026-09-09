import { Request, Response } from "express";
import mongoose from "mongoose";
import { Program } from "../../models";
import AuditLog from "../../models/AuditLog";
import { socketService } from "../../services/infrastructure/SocketService";

export default class AdminUnenrollController {
  /**
   * Admin unenrollment - removes admin from mentee or class rep list
   *
   * @route DELETE /programs/:id/admin-enroll
   * @returns {Object} Updated program without admin enrollment
   */
  static async adminUnenroll(req: Request, res: Response): Promise<void> {
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
          message: "Only Super Admin and Administrator can unenroll.",
        });
        return;
      }

      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid program ID." });
        return;
      }

      const program = await Program.findById(id);
      if (!program) {
        res.status(404).json({ success: false, message: "Program not found." });
        return;
      }

      if (!program.adminEnrollments) {
        res.status(400).json({
          success: false,
          message: "You are not enrolled in this program.",
        });
        return;
      }

      // Remove user from both lists (in case they're in one)
      const userId = req.user._id as mongoose.Types.ObjectId;
      const menteeIndex =
        program.adminEnrollments.mentees?.findIndex(
          (uid: mongoose.Types.ObjectId) => uid.toString() === userId.toString()
        ) ?? -1;
      const classRepIndex =
        program.adminEnrollments.classReps?.findIndex(
          (uid: mongoose.Types.ObjectId) => uid.toString() === userId.toString()
        ) ?? -1;

      let enrollmentType = "";
      if (menteeIndex !== -1) {
        program.adminEnrollments.mentees?.splice(menteeIndex, 1);
        enrollmentType = "mentee";
      } else if (classRepIndex !== -1) {
        program.adminEnrollments.classReps?.splice(classRepIndex, 1);
        enrollmentType = "classRep";
      } else {
        res.status(400).json({
          success: false,
          message: "You are not enrolled in this program.",
        });
        return;
      }

      await program.save();
      socketService.disconnectUser(userId.toString());

      // Audit log
      try {
        await AuditLog.create({
          action: "program_admin_unenroll",
          actor: {
            id: req.user._id,
            role: req.user.role,
            email: req.user.email,
          },
          targetModel: "Program",
          targetId: id,
          details: {
            programTitle: program.title,
            enrollmentType,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || "unknown",
        });
      } catch (auditError) {
        console.error(
          "Failed to create audit log for admin unenrollment:",
          auditError
        );
      }

      res.status(200).json({
        success: true,
        message: "Successfully unenrolled from program.",
        data: program,
      });
    } catch (error) {
      console.error("Error unenrolling admin:", error);
      res.status(500).json({
        success: false,
        message: "Failed to unenroll admin.",
      });
    }
  }
}
