import { Router, Request, Response, type NextFunction } from "express";
import CreationController from "../controllers/programs/CreationController";
import ListController from "../controllers/programs/ListController";
import RetrievalController from "../controllers/programs/RetrievalController";
import EventListController from "../controllers/programs/EventListController";
import ParticipantsController from "../controllers/programs/ParticipantsController";
import UpdateController from "../controllers/programs/UpdateController";
import DeletionController from "../controllers/programs/DeletionController";
import AdminEnrollController from "../controllers/programs/AdminEnrollController";
import AdminUnenrollController from "../controllers/programs/AdminUnenrollController";
import SelfUnenrollController from "../controllers/programs/SelfUnenrollController";
import { communitySettingsController } from "../controllers/programs/CommunitySettingsController";
import { authenticate, authenticateOptional } from "../middleware/auth";
import {
  requireAlumniNetworkReadable,
  requireAlumniNetworkWritable,
} from "../middleware/alumniNetworkFeatureGate";
import { authorizeHttp } from "../middleware/authorization";
import { AUTHORIZATION_ACTIONS } from "../services/authorization/types";
import { EmailService } from "../services/infrastructure/EmailServiceFacade";
import { EmailRecipientUtils } from "../utils/emailRecipientUtils";
import { Program } from "../models";
import mongoose from "mongoose";

const router = Router();

const authorizeProgramManagement = authorizeHttp({
  action: AUTHORIZATION_ACTIONS.PROGRAM_MANAGE,
  resource: (req) => ({ type: "program", id: req.params.id ?? "" }),
  concealDeniedResource: true,
});

const requireCommunityProgramId = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id ?? "")) {
    res.status(404).json({
      success: false,
      message: "Resource not found.",
      reasonCode: "resource_not_found",
    });
    return;
  }
  next();
};

// Public list and get (with optional auth for contact info filtering)
router.get("/", ListController.list);
router.get("/:id", authenticateOptional, RetrievalController.getById);
router.get("/:id/events", EventListController.listEvents);
router.get(
  "/:id/participants",
  authenticateOptional,
  ParticipantsController.getParticipants,
);
router.get(
  "/:id/community-settings",
  authenticate,
  requireAlumniNetworkReadable,
  requireCommunityProgramId,
  authorizeProgramManagement,
  communitySettingsController.get,
);
router.put(
  "/:id/community-settings",
  authenticate,
  requireAlumniNetworkWritable,
  requireCommunityProgramId,
  authorizeProgramManagement,
  communitySettingsController.update,
);

// Authenticated admin-only operations are validated inside controller
router.post("/", authenticate, CreationController.create);
router.put("/:id", authenticate, UpdateController.update);
router.delete("/:id", authenticate, DeletionController.remove);

// Admin enrollment operations
router.post("/:id/admin-enroll", authenticate, AdminEnrollController.adminEnroll);
router.delete(
  "/:id/admin-enroll",
  authenticate,
  AdminUnenrollController.adminUnenroll,
);
router.get(
  "/:id/unenroll-preview",
  authenticate,
  SelfUnenrollController.preview,
);
router.post("/:id/unenroll", authenticate, SelfUnenrollController.unenroll);

// Email all participants (mentors, class reps, mentees) - authenticated
router.post("/:id/email", authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      subject,
      bodyHtml,
      bodyText,
      includeMentors = true,
      includeClassReps = true,
      includeMentees = true,
    } = req.body || {};

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid program ID" });
      return;
    }

    if (!subject || !bodyHtml) {
      res.status(400).json({
        success: false,
        message: "Subject and bodyHtml are required",
      });
      return;
    }

    // Load program to verify it exists and get mentor info for reply-to
    const program = await Program.findById(id).populate<{
      mentors?: Array<{
        userId?:
          | mongoose.Types.ObjectId
          | { email?: string; firstName?: string; lastName?: string };
      }>;
    }>("mentors.userId", "email firstName lastName");

    if (!program) {
      res.status(404).json({ success: false, message: "Program not found" });
      return;
    }

    // Check authorization: user must be:
    // 1. Super Admin or Administrator, OR
    // 2. Mentor or Class Rep of this program
    const user = req.user as
      | { id?: string; _id?: unknown; role?: string }
      | undefined;
    const userId = String(user?._id || user?.id || "");
    const isAdmin =
      user?.role === "Super Admin" || user?.role === "Administrator";

    // Check if user is a mentor
    const isMentor =
      program.mentors?.some((m: { userId?: unknown }) => {
        const mentorUserId = m.userId;
        if (!mentorUserId) return false;
        // Handle both ObjectId and populated user object
        let mentorId: string;
        if (
          typeof mentorUserId === "object" &&
          mentorUserId !== null &&
          "_id" in mentorUserId
        ) {
          mentorId = String((mentorUserId as { _id: unknown })._id);
        } else {
          mentorId = String(mentorUserId);
        }
        return mentorId === userId;
      }) ?? false;

    // Check if user is a class rep (via purchase or admin enrollment)
    let isClassRep = false;
    if (userId && !isMentor) {
      const Purchase = (await import("../models/Purchase")).default;
      const classRepPurchase = await Purchase.findOne({
        purchaseType: "program",
        programId: id,
        userId,
        isClassRep: true,
        status: "completed",
        unenrolledAt: { $exists: false },
      });
      if (classRepPurchase) {
        isClassRep = true;
      } else {
        // Also check admin enrollments for class reps
        isClassRep =
          program.adminEnrollments?.classReps?.some(
            (crId: unknown) => String(crId) === userId,
          ) ?? false;
      }
    }

    // Authorization check
    const canSendEmail = isAdmin || isMentor || isClassRep;
    if (!canSendEmail) {
      res.status(403).json({
        success: false,
        message:
          "You must be an admin, mentor, or class rep of this program to send emails",
      });
      return;
    }

    // Determine Reply-To (first mentor if available)
    let replyTo: string | undefined;
    if (program.mentors && program.mentors.length > 0) {
      const firstMentor = program.mentors[0];
      if (firstMentor.userId && typeof firstMentor.userId === "object") {
        const mentorUser = firstMentor.userId as {
          email?: string;
          firstName?: string;
          lastName?: string;
        };
        if (mentorUser.email) {
          const name =
            [mentorUser.firstName, mentorUser.lastName]
              .filter(Boolean)
              .join(" ") || "Mentor";
          replyTo = `${name} <${mentorUser.email}>`;
        }
      }
    }

    // Gather recipients
    const recipients = await EmailRecipientUtils.getProgramParticipants(id, {
      includeMentors,
      includeClassReps,
      includeMentees,
    });

    // Dedupe by email
    const seen = new Set<string>();
    const unique = recipients.filter((r) => {
      const key = r.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (unique.length === 0) {
      res.status(200).json({
        success: true,
        message: "No recipients found",
        recipientCount: 0,
        sent: 0,
      });
      return;
    }

    // Send emails
    const results = await Promise.allSettled(
      unique.map((r) =>
        EmailService.sendEmail({
          to: r.email,
          subject,
          html: bodyHtml,
          text: bodyText,
          replyTo,
        }),
      ),
    );

    const sent = results.filter(
      (x) => x.status === "fulfilled" && x.value === true,
    ).length;

    res.status(200).json({
      success: true,
      message: `Email sent to ${sent}/${unique.length} recipients`,
      recipientCount: unique.length,
      sent,
    });
  } catch (error) {
    console.error("Failed to send program emails:", error);
    res.status(500).json({ success: false, message: "Failed to send emails" });
  }
});

export default router;
