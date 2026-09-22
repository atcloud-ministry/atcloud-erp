import { Request, Response } from "express";
import { Program } from "../../models";
import { RoleUtils } from "../../utils/roleUtils";
import {
  AssignmentSnapshotError,
  UserAssignmentSnapshotService,
} from "../../services/UserAssignmentSnapshotService";
import {
  initializeProgramRoleCounts,
  selectMutableProgramFields,
} from "../../services/ProgramPayloadService";

export default class CreationController {
  static async create(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res
          .status(401)
          .json({ success: false, message: "Authentication required." });
        return;
      }
      // Leaders and above can create programs
      if (!RoleUtils.isLeaderOrHigher(req.user.role)) {
        res.status(403).json({
          success: false,
          message: "Only Leaders and above can create programs.",
        });
        return;
      }

      const payload = selectMutableProgramFields(req.body);
      if (Object.prototype.hasOwnProperty.call(payload, "mentors")) {
        payload.mentors =
          await UserAssignmentSnapshotService.resolveProgramMentors(
            payload.mentors,
          );
      }
      if (Object.prototype.hasOwnProperty.call(payload, "programRoles")) {
        payload.programRoles = initializeProgramRoleCounts(
          payload.programRoles,
        );
      }
      const doc = await Program.create({
        ...payload,
        classRepCount: 0,
        createdBy: req.user._id,
      });
      res.status(201).json({ success: true, data: doc });
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
