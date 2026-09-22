import mongoose from "mongoose";
import { IUser } from "../models/User";
import User from "../models/User";
import Registration from "../models/Registration";
import Event from "../models/Event";
import Message from "../models/Message";
import PromoCode from "../models/PromoCode";
import Program from "../models/Program";
import ShortLink from "../models/ShortLink";
import { CachePatterns } from "./infrastructure/CacheService";
import { resourceAuthorizationInvalidationService } from "./authorization/ResourceAuthorizationInvalidationService";
import { socketService } from "./infrastructure/SocketService";
import { alumniAccountDeletionService } from "./alumni/AlumniAccountDeletionService";
import {
  canonicalizeLocalUploadReference,
  fileCleanupService,
  type FileCleanupTarget,
  type NormalizedFileCleanupTarget,
} from "./privacy/FileCleanupService";

function canonicalizeFlyerReference(
  reference: string | null | undefined,
): FileCleanupTarget | null {
  return (
    canonicalizeLocalUploadReference(reference, "images") ??
    canonicalizeLocalUploadReference(reference, "events")
  );
}

export interface UserDeletionReport {
  userId: string;
  userEmail: string;
  deletedData: {
    userRecord: boolean;
    registrations: number;
    eventsCreated: number;
    eventOrganizations: number;
    messageStates: number;
    messagesCreated: number;
    promoCodes: number;
    programMentorships: number;
    programClassReps: number;
    programMentees: number;
    shortLinks: number;
    avatarFile: boolean;
    eventFlyerFiles: number;
  };
  updatedStatistics: {
    events: string[];
    affectedUsers: number;
  };
  errors: string[];
}

export class UserDeletionService {
  /**
   * Delete a user account and apply each associated record's approved
   * deletion or retention lifecycle.
   */
  static async deleteUserCompletely(
    userId: string,
    performedBy: IUser,
    correlationId?: string,
  ): Promise<UserDeletionReport> {
    const report: UserDeletionReport = {
      userId,
      userEmail: "",
      deletedData: {
        userRecord: false,
        registrations: 0,
        eventsCreated: 0,
        eventOrganizations: 0,
        messageStates: 0,
        messagesCreated: 0,
        promoCodes: 0,
        programMentorships: 0,
        programClassReps: 0,
        programMentees: 0,
        shortLinks: 0,
        avatarFile: false,
        eventFlyerFiles: 0,
      },
      updatedStatistics: {
        events: [],
        affectedUsers: 0,
      },
      errors: [],
    };

    try {
      // Read-only preparation is safe outside the transaction; every database
      // mutation is supplied to the account-deletion transaction below.
      const userToDelete = await User.findById(userId);
      if (!userToDelete) {
        throw new Error("User not found");
      }
      report.userEmail = userToDelete.email;
      let eventsCreatedByUser: Array<{
        _id: mongoose.Types.ObjectId;
        flyerUrl?: string | null;
        secondaryFlyerUrl?: string | null;
      }> = [];
      let fileCleanupTargets: readonly NormalizedFileCleanupTarget[] = [];

      await alumniAccountDeletionService.deleteAccount(
        {
          targetUserId: userId,
          actor: {
            id: String(performedBy._id),
            role: performedBy.role,
          },
          correlationId,
        },
        async ({ targetUserId, session }) => {
          // The transaction runner may retry the callback after a transient
          // commit error, so rebuild all in-memory reporting from this attempt.
          const transactionalUser = await User.findById(
            targetUserId,
            "email avatar",
            { session },
          );
          if (!transactionalUser) {
            throw new Error("User not found during account deletion.");
          }
          report.userEmail = transactionalUser.email;
          eventsCreatedByUser = [];
          fileCleanupTargets = [];
          Object.assign(report.deletedData, {
            userRecord: false,
            registrations: 0,
            eventsCreated: 0,
            eventOrganizations: 0,
            messageStates: 0,
            messagesCreated: 0,
            promoCodes: 0,
            programMentorships: 0,
            programClassReps: 0,
            programMentees: 0,
            shortLinks: 0,
            avatarFile: false,
            eventFlyerFiles: 0,
          });
          const deletedRegistrations = await Registration.deleteMany(
            { userId: targetUserId },
            { session },
          );
          report.deletedData.registrations =
            deletedRegistrations.deletedCount || 0;

          const deletedAsRegistrar = await Registration.deleteMany(
            { registeredBy: targetUserId },
            { session },
          );
          report.deletedData.registrations +=
            deletedAsRegistrar.deletedCount || 0;

          await Registration.updateMany(
            { "actionHistory.performedBy": targetUserId },
            {
              $pull: {
                actionHistory: { performedBy: targetUserId },
              },
            },
            { session },
          );

          eventsCreatedByUser = (await Event.find(
            { createdBy: targetUserId },
            "_id flyerUrl secondaryFlyerUrl",
            { session },
          )) as typeof eventsCreatedByUser;
          for (const event of eventsCreatedByUser) {
            await Event.findByIdAndDelete(event._id, { session });
            await Registration.deleteMany(
              { eventId: event._id },
              { session },
            );
            report.deletedData.eventsCreated += 1;
          }

          const eventsAsOrganizer = await Event.updateMany(
            { "organizerDetails.userId": targetUserId },
            {
              $pull: {
                organizerDetails: { userId: targetUserId },
              },
            },
            { session },
          );
          report.deletedData.eventOrganizations =
            eventsAsOrganizer.modifiedCount || 0;

          const messagesWithUserStates = await Message.updateMany(
            { [`userStates.${userId}`]: { $exists: true } },
            { $unset: { [`userStates.${userId}`]: 1 } },
            { session },
          );
          report.deletedData.messageStates =
            messagesWithUserStates.modifiedCount || 0;

          const deletedMessages = await Message.deleteMany(
            {
              $or: [
                { "creator.id": userId },
                { createdBy: targetUserId },
              ],
            },
            { session },
          );
          report.deletedData.messagesCreated =
            deletedMessages.deletedCount || 0;

          const deletedPromoCodes = await PromoCode.deleteMany(
            { ownerId: targetUserId },
            { session },
          );
          report.deletedData.promoCodes = deletedPromoCodes.deletedCount || 0;

          const programsAsMentor = await Program.updateMany(
            { "mentors.userId": targetUserId },
            { $pull: { mentors: { userId: targetUserId } } },
            { session },
          );
          report.deletedData.programMentorships =
            programsAsMentor.modifiedCount || 0;

          const programsAsClassRep = await Program.updateMany(
            { "adminEnrollments.classReps": targetUserId },
            {
              $pull: { "adminEnrollments.classReps": targetUserId },
              $inc: { classRepCount: -1 },
            },
            { session },
          );
          report.deletedData.programClassReps =
            programsAsClassRep.modifiedCount || 0;

          const programsAsMentee = await Program.updateMany(
            { "adminEnrollments.mentees": targetUserId },
            { $pull: { "adminEnrollments.mentees": targetUserId } },
            { session },
          );
          report.deletedData.programMentees =
            programsAsMentee.modifiedCount || 0;

          const eventIds = eventsCreatedByUser.map((event) =>
            event._id.toString(),
          );
          const deletedShortLinks = await ShortLink.deleteMany(
            { targetEventId: { $in: eventIds } },
            { session },
          );
          report.deletedData.shortLinks =
            deletedShortLinks.deletedCount || 0;

          const avatarCleanupTarget = canonicalizeLocalUploadReference(
            transactionalUser.avatar,
            "avatars",
          );
          fileCleanupTargets = await fileCleanupService.enqueueInTransaction(
            [
              ...(avatarCleanupTarget ? [avatarCleanupTarget] : []),
              ...eventsCreatedByUser.flatMap((event) =>
                [event.flyerUrl, event.secondaryFlyerUrl].flatMap(
                  (reference) => {
                    const target = canonicalizeFlyerReference(reference);
                    return target ? [target] : [];
                  },
                ),
              ),
            ],
            session,
          );
        },
      );
      report.deletedData.userRecord = true;
      const eventIdsCreatedByUser = eventsCreatedByUser.map((event) =>
        event._id.toString(),
      );
      report.updatedStatistics.events = eventIdsCreatedByUser;

      // Jobs were committed with account deletion. Try them immediately;
      // transient failures remain durable for the maintenance worker.
      try {
        const cleanupResults =
          await fileCleanupService.processTargets(fileCleanupTargets);
        for (const result of cleanupResults) {
          if (
            result.outcome !== "deleted" &&
            result.outcome !== "already_absent"
          ) {
            continue;
          }
          if (result.target.storageArea === "avatars") {
            report.deletedData.avatarFile = true;
          } else {
            report.deletedData.eventFlyerFiles += 1;
          }
        }
      } catch (error) {
        console.warn("Immediate file cleanup processing failed", {
          targetUserId: userId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }

      for (const eventId of eventIdsCreatedByUser) {
        resourceAuthorizationInvalidationService.invalidateEventRoom(eventId);
      }
      socketService.disconnectUser(userId);

      try {
        await CachePatterns.invalidateUserCache(userId);
        await CachePatterns.invalidateAllUserCaches();
        await CachePatterns.invalidateAnalyticsCache();
        for (const eventId of eventIdsCreatedByUser) {
          await CachePatterns.invalidateEventCache(eventId);
        }
      } catch (error) {
        console.warn("Post-deletion cache invalidation failed", {
          targetUserId: userId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }

      console.log("User deletion completed", {
        targetUserId: userId,
        actorId: String(performedBy._id),
        deletedCounts: report.deletedData,
      });

      return report;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(message);
      console.error("User deletion failed", {
        targetUserId: userId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  /**
   * Get user deletion impact analysis before actual deletion
   * Shows what would be deleted without performing the deletion
   */
  static async getUserDeletionImpact(userId: string): Promise<{
    user: {
      email: string;
      name: string;
      role: string;
      createdAt: Date;
    };
    impact: {
      registrations: number;
      eventsCreated: number;
      eventOrganizations: number;
      messageStates: number;
      messagesCreated: number;
      promoCodes: number;
      programMentorships: number;
      programClassReps: number;
      programMentees: number;
      shortLinks: number;
      avatarFile: boolean;
      eventFlyerFiles: number;
      affectedEvents: Array<{
        id: string;
        title: string;
        participantCount: number;
      }>;
    };
    risks: string[];
  }> {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      // Count registrations
      const registrationCount = await Registration.countDocuments({
        $or: [
          { userId: new mongoose.Types.ObjectId(userId) },
          { registeredBy: new mongoose.Types.ObjectId(userId) },
        ],
      });

      // Count events created
      const eventsCreated = await Event.find({
        createdBy: new mongoose.Types.ObjectId(userId),
      });

      // Count organizer roles
      const eventOrganizations = await Event.countDocuments({
        "organizerDetails.userId": new mongoose.Types.ObjectId(userId),
      });

      // Count message states
      const messagesWithStates = await Message.countDocuments({
        "userStates.userId": new mongoose.Types.ObjectId(userId),
      });

      // Count messages created
      const messagesCreated = await Message.countDocuments({
        $or: [
          { "creator.id": userId },
          { createdBy: new mongoose.Types.ObjectId(userId) },
        ],
      });

      // Count promo codes owned by user
      const promoCodesCount = await PromoCode.countDocuments({
        ownerId: new mongoose.Types.ObjectId(userId),
      });

      // Count program mentorships
      const programMentorships = await Program.countDocuments({
        "mentors.userId": new mongoose.Types.ObjectId(userId),
      });

      // Count program class rep enrollments
      const programClassReps = await Program.countDocuments({
        "adminEnrollments.classReps": new mongoose.Types.ObjectId(userId),
      });

      // Count program mentee enrollments
      const programMentees = await Program.countDocuments({
        "adminEnrollments.mentees": new mongoose.Types.ObjectId(userId),
      });

      // Count shortlinks for events created by user
      const eventIdsForShortLinks = eventsCreated.map((e) =>
        (e._id as mongoose.Types.ObjectId).toString()
      );
      const shortLinksCount = await ShortLink.countDocuments({
        targetEventId: { $in: eventIdsForShortLinks },
      });

      // Check if avatar file exists
      const hasAvatarFile = Boolean(
        canonicalizeLocalUploadReference(user.avatar, "avatars"),
      );

      // Count event flyer files
      const eventFlyerFilesCount = eventsCreated.flatMap((event) =>
        [event.flyerUrl, event.secondaryFlyerUrl].filter((reference) =>
          Boolean(canonicalizeFlyerReference(reference)),
        ),
      ).length;

      // Analyze risks
      const risks: string[] = [];
      if (eventsCreated.length > 0) {
        risks.push(
          `Will permanently delete ${eventsCreated.length} events created by this user`
        );
      }
      if (registrationCount > 0) {
        risks.push(`Will remove ${registrationCount} event registrations`);
      }
      if (promoCodesCount > 0) {
        risks.push(
          `Will delete ${promoCodesCount} promo codes owned by this user`
        );
      }
      if (programMentorships > 0) {
        risks.push(
          `Will remove user from ${programMentorships} programs as mentor`
        );
      }
      if (user.role === "Super Admin") {
        risks.push("WARNING: Attempting to delete a Super Admin user");
      }

      return {
        user: {
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          createdAt: user.createdAt,
        },
        impact: {
          registrations: registrationCount,
          eventsCreated: eventsCreated.length,
          eventOrganizations,
          messageStates: messagesWithStates,
          messagesCreated,
          promoCodes: promoCodesCount,
          programMentorships,
          programClassReps,
          programMentees,
          shortLinks: shortLinksCount,
          avatarFile: hasAvatarFile,
          eventFlyerFiles: eventFlyerFilesCount,
          affectedEvents: eventsCreated.map((event) => ({
            id: (event._id as mongoose.Types.ObjectId).toString(),
            title: event.title,
            participantCount: event.signedUp,
          })),
        },
        risks,
      };
    } catch (error: unknown) {
      // If the user is not found, throw specific error that tests expect
      if (error instanceof Error && error.message === "User not found") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to analyze deletion impact: ${message}`);
    }
  }
}
