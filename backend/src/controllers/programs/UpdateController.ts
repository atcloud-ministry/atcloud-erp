import { Request, Response } from "express";
import mongoose from "mongoose";
import { Program, Purchase } from "../../models";
import { RoleUtils } from "../../utils/roleUtils";
import {
  AssignmentSnapshotError,
  UserAssignmentSnapshotService,
} from "../../services/UserAssignmentSnapshotService";
import {
  preserveProgramRoleCounts,
  selectMutableProgramFields,
} from "../../services/ProgramPayloadService";
import { socketService } from "../../services/infrastructure/SocketService";
import { programMembershipMutationSyncTrigger } from "../../services/programs/ProgramMembershipMutationSyncTrigger";

export default class UpdateController {
  static async update(req: Request, res: Response): Promise<void> {
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
          .json({ success: false, message: "Invalid program ID." });
        return;
      }

      // Fetch the program to check permissions
      const program = await Program.findById(id);
      if (!program) {
        res.status(404).json({ success: false, message: "Program not found." });
        return;
      }

      // Authorization logic:
      // 1. Super Admin and Administrator can edit any program
      // 2. Program creator can edit their own program
      // 3. Mentors assigned to this program can edit it
      const isAdmin = RoleUtils.isAdmin(req.user.role);
      const isCreator =
        program.createdBy &&
        String(program.createdBy) === String(req.user!._id);
      const isMentor =
        program.mentors?.some(
          (mentor: { userId: unknown }) =>
            String(mentor.userId) === String(req.user!._id),
        ) ?? false;
      const needsClassRepCheck = !isAdmin && !isCreator && !isMentor;
      const isAdminEnrolledClassRep =
        needsClassRepCheck &&
        (program.adminEnrollments?.classReps?.some(
          (classRepId: unknown) => String(classRepId) === String(req.user!._id),
        ) ??
          false);
      const classRepPurchase =
        needsClassRepCheck && !isAdminEnrolledClassRep
          ? await Purchase.findOne({
              purchaseType: "program",
              programId: program._id,
              userId: req.user._id,
              status: "completed",
              isClassRep: true,
              unenrolledAt: { $exists: false },
            }).select("_id")
          : null;
      const isClassRep = isAdminEnrolledClassRep || !!classRepPurchase;

      if (!isAdmin && !isCreator && !isMentor && !isClassRep) {
        res.status(403).json({
          success: false,
          message:
            "You do not have permission to edit this program. Only Administrators, the program creator, assigned mentors, and class reps can edit programs.",
        });
        return;
      }

      const payload = selectMutableProgramFields(req.body);
      let removedMentorIds: string[] = [];
      if (Object.prototype.hasOwnProperty.call(payload, "mentors")) {
        const existingMentorIds: string[] = (program.mentors || []).map(
          (mentor: { userId: unknown }) => String(mentor.userId),
        );
        const resolvedMentors =
          await UserAssignmentSnapshotService.resolveProgramMentors(
            payload.mentors,
            existingMentorIds,
          );
        const nextMentorIds = new Set(
          resolvedMentors.map((mentor: { userId: unknown }) =>
            String(mentor.userId),
          ),
        );
        removedMentorIds = existingMentorIds.filter(
          (mentorId) => !nextMentorIds.has(mentorId),
        );
        payload.mentors = resolvedMentors;
      }
      if (Object.prototype.hasOwnProperty.call(payload, "programRoles")) {
        payload.programRoles = preserveProgramRoleCounts(
          program,
          payload.programRoles,
        );
      }
      program.set(payload);
      const updated = await program.save();
      programMembershipMutationSyncTrigger.programAssignmentsChanged(
        String(updated._id),
        {
          actor: {
            type: "user",
            id: String(req.user._id),
            role: req.user.role,
          },
          source: "http",
          correlationId: req.correlationId,
        },
      );
      removedMentorIds.forEach((mentorId) => {
        socketService.disconnectUser(mentorId);
      });
      res.status(200).json({ success: true, data: updated });
    } catch (error) {
      if (error instanceof AssignmentSnapshotError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      res
        .status(400)
        .json({ success: false, message: (error as Error).message });
    }
  }
}
