import { Request, Response } from "express";
import mongoose from "mongoose";
import { Program, Purchase, User } from "../../models";
import {
  canViewExactPrivateProfileFields,
  sanitizeParticipant,
  stripExactPrivateProfileFields,
} from "../../utils/privacy";
import {
  getDiscountStudentRole,
  normalizeProgramRoles,
} from "../../utils/programRoles";

export default class ParticipantsController {
  /**
   * Get all participants (mentees and class reps) for a program
   * Combines paid purchases and admin enrollments
   *
   * @route GET /programs/:id/participants
   * @returns {Object} Lists of mentees and classReps with user info and enrollment metadata
   */
  static async getParticipants(req: Request, res: Response): Promise<void> {
    try {
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

      const programRoles = normalizeProgramRoles(program);
      const defaultStudentRole =
        programRoles.studentRoles.find((role) => !role.discountEligible) ||
        programRoles.studentRoles[0];
      const discountStudentRole = getDiscountStudentRole(programRoles);
      const studentRoleGroups = programRoles.studentRoles.map((role) => ({
        roleId: role.id,
        name: role.name,
        discountEligible: role.discountEligible,
        participants: [] as Array<{
          user: Record<string, unknown>;
          isPaid: boolean;
          enrollmentDate: Date;
          studentRoleId: string;
          studentRoleName: string;
        }>,
      }));
      const roleGroupById = new Map(
        studentRoleGroups.map((group) => [group.roleId, group]),
      );
      const getRoleGroup = (roleId?: string) =>
        roleGroupById.get(roleId || "") ||
        roleGroupById.get(defaultStudentRole.id) ||
        studentRoleGroups[0];

      // Get all completed purchases for this program
      const purchases = await Purchase.find({
        purchaseType: "program",
        programId: id,
        status: "completed",
        unenrolledAt: { $exists: false },
      })
        .populate<{
          userId: {
            _id: mongoose.Types.ObjectId;
            firstName: string;
            lastName: string;
            email: string;
            phone?: string;
            avatar?: string;
            gender?: string;
            roleInAtCloud?: string;
          };
        }>(
          "userId",
          "firstName lastName email phone avatar gender roleInAtCloud",
        )
        .sort({ purchaseDate: 1 }); // Sort by enrollment date

      // Get admin enrollments
      const adminMenteeIds = program.adminEnrollments?.mentees || [];
      const adminClassRepIds = program.adminEnrollments?.classReps || [];

      const adminMentees = await User.find({
        _id: { $in: adminMenteeIds },
      }).select(
        "_id firstName lastName email phone avatar gender roleInAtCloud",
      );

      const adminClassReps = await User.find({
        _id: { $in: adminClassRepIds },
      }).select(
        "_id firstName lastName email phone avatar gender roleInAtCloud",
      );

      // Helper to convert Mongoose document to plain object with virtuals (for 'id' field)
      const toPlainUser = (
        doc: mongoose.Document | Record<string, unknown>,
      ) => {
        if (doc && typeof (doc as mongoose.Document).toObject === "function") {
          return (doc as mongoose.Document).toObject({ virtuals: true });
        }
        return doc;
      };

      purchases.forEach((purchase) => {
        const roleId =
          purchase.studentRoleId ||
          (purchase.isClassRep
            ? discountStudentRole?.id
            : defaultStudentRole.id);
        const group = getRoleGroup(roleId);
        group.participants.push({
          user: toPlainUser(purchase.userId) as Record<string, unknown>,
          isPaid: true,
          enrollmentDate: purchase.purchaseDate,
          studentRoleId: group.roleId,
          studentRoleName: purchase.studentRoleName || group.name,
        });
      });

      const menteeGroup = getRoleGroup(defaultStudentRole.id);
      adminMentees.forEach((user) => {
        menteeGroup.participants.push({
          user: toPlainUser(user) as Record<string, unknown>,
          isPaid: false,
          enrollmentDate: program.updatedAt,
          studentRoleId: menteeGroup.roleId,
          studentRoleName: menteeGroup.name,
        });
      });

      const classRepGroup = discountStudentRole
        ? getRoleGroup(discountStudentRole.id)
        : getRoleGroup(defaultStudentRole.id);
      adminClassReps.forEach((user) => {
        classRepGroup.participants.push({
          user: toPlainUser(user) as Record<string, unknown>,
          isPaid: false,
          enrollmentDate: program.updatedAt,
          studentRoleId: classRepGroup.roleId,
          studentRoleName: classRepGroup.name,
        });
      });

      const allMentees = menteeGroup.participants;
      const allClassReps = discountStudentRole ? classRepGroup.participants : [];

      // Determine if user can view contact information:
      // - Super Admin and Administrator can always see contacts
      // - Mentors of this program can see contacts
      // - Everyone else cannot see participant contact info
      const user = req.user;
      const isAdmin =
        user?.role === "Super Admin" || user?.role === "Administrator";
      const isMentor = program.mentors?.some(
        (mentor: { userId: mongoose.Types.ObjectId }) =>
          mentor.userId.toString() === String(user?._id),
      );
      const isClassRep = allClassReps.some((participant) => {
        const participantUser = participant.user as {
          _id?: unknown;
          id?: unknown;
        };
        return (
          String(participantUser._id || participantUser.id) ===
          String(user?._id)
        );
      });
      const canViewContact = isAdmin || isMentor || isClassRep;
      const viewerId = user?._id;
      const viewerRole = user?.role || req.userRole;
      const sanitizeForViewer = <
        T extends { user: Record<string, unknown> },
      >(
        participant: T,
      ): T => {
        const participantUserId =
          participant.user._id || participant.user.id || "";
        const isSelf =
          String(viewerId || "") !== "" &&
          String(viewerId) === String(participantUserId);
        const contactSanitized = sanitizeParticipant(
          participant,
          canViewContact || isSelf,
        );

        if (
          canViewExactPrivateProfileFields(
            viewerId,
            viewerRole,
            participantUserId,
          )
        ) {
          return contactSanitized;
        }

        return {
          ...contactSanitized,
          user: stripExactPrivateProfileFields(contactSanitized.user),
        };
      };

      res.status(200).json({
        success: true,
        data: {
          mentees: allMentees.map(sanitizeForViewer),
          classReps: allClassReps.map(sanitizeForViewer),
          studentRoles: studentRoleGroups.map((group) => ({
            roleId: group.roleId,
            name: group.name,
            discountEligible: group.discountEligible,
            participants: group.participants.map(sanitizeForViewer),
          })),
        },
      });
    } catch (error) {
      console.error("Error fetching program participants:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch program participants.",
      });
    }
  }
}
