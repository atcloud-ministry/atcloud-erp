import { Request, Response } from "express";
import mongoose from "mongoose";
import { Event, Program } from "../../models";
import AuditLog from "../../models/AuditLog";
import { EventCascadeService } from "../../services/EventCascadeService";
import { RoleUtils } from "../../utils/roleUtils";
import { resourceAuthorizationInvalidationService } from "../../services/authorization/ResourceAuthorizationInvalidationService";

export default class DeletionController {
  /**
   * Deletes a program with optional cascade deletion of linked events
   *
   * @route DELETE /programs/:id?deleteLinkedEvents=true|false
   * @param req.params.id - Program ObjectId (required)
   * @param req.query.deleteLinkedEvents - Boolean flag for cascade deletion (optional, default: false)
   * @security Requires Administrator or Super Admin role
   * @returns {Object} Success response with deletion details
   *
   * @example
   * // Unlink-only mode (deleteLinkedEvents=false or omitted)
   * {
   *   "success": true,
   *   "message": "Program deleted. Unlinked 3 related events.",
   *   "unlinkedEvents": 3
   * }
   *
   * @example
   * // Cascade mode (deleteLinkedEvents=true)
   * {
   *   "success": true,
   *   "message": "Program and 3 events deleted with cascades.",
   *   "deletedEvents": 3,
   *   "deletedRegistrations": 15,
   *   "deletedGuestRegistrations": 8
   * }
   *
   * @throws {401} Authentication required
   * @throws {403} Only Administrators can delete programs
   * @throws {400} Invalid program ID format
   * @throws {500} Database error during deletion
   */
  static async remove(req: Request, res: Response): Promise<void> {
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

      // Get program details before permission check
      const program = await Program.findById(id).lean();
      if (!program) {
        res.status(404).json({ success: false, message: "Program not found." });
        return;
      }

      const programData = program as {
        _id: unknown;
        title?: string;
        programType?: string;
        createdBy?: unknown;
      };

      // Authorization: Admin can delete any program, Leader can delete their own
      const isAdmin = RoleUtils.isAdmin(req.user.role);
      const isCreator =
        programData.createdBy &&
        String(programData.createdBy) === String(req.user._id);

      if (!isAdmin && !isCreator) {
        res.status(403).json({
          success: false,
          message:
            "You do not have permission to delete this program. Only Administrators or the program creator can delete programs.",
        });
        return;
      }

      const deleteLinkedEvents =
        String(
          (req.query as { deleteLinkedEvents?: string }).deleteLinkedEvents ??
            "false",
        ).toLowerCase() === "true";

      if (!deleteLinkedEvents) {
        const linkedEventIds =
          await resourceAuthorizationInvalidationService.findEventIdsForPrograms([
            id,
          ]);
        // Remove this program from all events' programLabels arrays
        const result = await Event.updateMany(
          { programLabels: id },
          { $pull: { programLabels: id } },
        );
        resourceAuthorizationInvalidationService.invalidateEventRooms(
          linkedEventIds,
        );
        await Program.findByIdAndDelete(id);

        // Audit log for program deletion (unlink mode)
        try {
          await AuditLog.create({
            action: "program_deletion",
            actor: {
              id: req.user._id,
              role: req.user.role,
              email: req.user.email,
            },
            targetModel: "Program",
            targetId: id,
            details: {
              targetProgram: {
                id: programData._id,
                title: programData.title,
                programType: programData.programType,
              },
              cascadeMode: "unlink",
              unlinkedEvents: result.modifiedCount || 0,
            },
            ipAddress: req.ip,
            userAgent: req.get("user-agent") || "unknown",
          });
        } catch (auditError) {
          console.error(
            "Failed to create audit log for program deletion:",
            auditError,
          );
          // Don't fail the request if audit logging fails
        }

        res.status(200).json({
          success: true,
          message: `Program deleted. Unlinked ${
            result.modifiedCount || 0
          } related events.`,
          unlinkedEvents: result.modifiedCount || 0,
        });
        return;
      }

      // Cascade delete all linked events (events that have this program in programLabels)
      const events = await Event.find({ programLabels: id }).select("_id");
      let totalDeletedRegs = 0;
      let totalDeletedGuests = 0;
      for (const e of events) {
        const { deletedRegistrations, deletedGuestRegistrations } =
          await EventCascadeService.deleteEventFully(String(e._id));
        totalDeletedRegs += deletedRegistrations;
        totalDeletedGuests += deletedGuestRegistrations;
      }
      await Program.findByIdAndDelete(id);

      // Audit log for program deletion (cascade mode)
      try {
        await AuditLog.create({
          action: "program_deletion",
          actor: {
            id: req.user._id,
            role: req.user.role,
            email: req.user.email,
          },
          targetModel: "Program",
          targetId: id,
          details: {
            targetProgram: {
              id: programData._id,
              title: programData.title,
              programType: programData.programType,
            },
            cascadeMode: "delete",
            deletedEvents: events.length,
            deletedRegistrations: totalDeletedRegs,
            deletedGuestRegistrations: totalDeletedGuests,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent") || "unknown",
        });
      } catch (auditError) {
        console.error(
          "Failed to create audit log for program deletion:",
          auditError,
        );
        // Don't fail the request if audit logging fails
      }

      res.status(200).json({
        success: true,
        message: `Program and ${events.length} events deleted with cascades.`,
        deletedEvents: events.length,
        deletedRegistrations: totalDeletedRegs,
        deletedGuestRegistrations: totalDeletedGuests,
      });
    } catch {
      res
        .status(500)
        .json({ success: false, message: "Failed to delete program." });
    }
  }
}
