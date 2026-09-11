/**
 * Response Builder Service
 *
 * Builds standardized API responses using Registration-based data
 * Part of Phase 2 Migration: Frontend Integration
 */

import { Event, GuestRegistration, Registration, User } from "../models";
import { Types } from "mongoose";
import { createLogger } from "./LoggerService";
import { RegistrationQueryService } from "./RegistrationQueryService";
import {
  EventWithRegistrationData,
  EventRoleWithCounts,
  RegistrationWithUser,
  UserBasicInfo,
  AnalyticsEventData,
  OrganizerDetail,
  EventListItemData,
} from "../types/api-responses";
import { deriveEventStatus } from "../utils/event/eventStatus";
import {
  canViewExactPrivateProfileFields,
  stripExactPrivateProfileFields,
} from "../utils/privacy";

export type EventRole = {
  id: string;
  name: string;
  description?: string;
  maxParticipants: number;
  maxSignups?: number;
  agenda?: string;
  // Whether this role is visible & registerable on the public (unauthenticated) event page
  openToPublic?: boolean;
};
export type LeanUser = {
  _id: Types.ObjectId;
  username: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  avatar?: string;
  gender?: "male" | "female";
  systemAuthorizationLevel?: string;
  roleInAtCloud?: string;
  role?: string;
};

type EventLean = {
  _id: Types.ObjectId;
  title: string;
  type?: string;
  date: string;
  endDate?: string;
  time: string;
  endTime?: string;
  location?: string;
  organizer?: string;
  hostedBy?: string;
  purpose?: string;
  agenda?: string;
  format?: string;
  timeZone?: string;
  flyerUrl?: string;
  secondaryFlyerUrl?: string;
  youtubeUrl?: string;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  disclaimer?: string;
  requirements?: string;
  materials?: string;
  workshopGroupTopics?: Record<string, unknown>;
  organizerDetails?: Array<Record<string, unknown>>;
  roles: EventRole[];
  createdBy: LeanUser;
  createdAt?: Date;
  updatedAt?: Date;
  status?: string;
  publish?: boolean;
  publishedAt?: Date | null;
  publicSlug?: string;
  programLabels?: Types.ObjectId[];
};

type OccupancyAggregateRow = {
  _id: { eventId: Types.ObjectId | string; roleId: string };
  count: number;
};

type RegLean = {
  _id: Types.ObjectId;
  userId: Types.ObjectId | (LeanUser & { _id: Types.ObjectId });
  eventId: Types.ObjectId;
  roleId: string;
  status?: string;
  attendanceConfirmed?: boolean;
  createdAt?: Date;
};

type PopulatedRegistration = Omit<RegLean, "userId"> & {
  userId: (LeanUser & { _id: Types.ObjectId }) | null;
  notes?: string;
  specialRequirements?: string;
};

type RoleCountRow = {
  _id: string;
  count: number;
};

// Minimal input shape for analytics event builder
export type AnalyticsEventInput = {
  _id: Types.ObjectId;
  title: string;
  date: string;
  endDate?: string;
  time: string;
  endTime?: string;
  location?: string;
  status?: string;
  format?: string;
  timeZone?: string;
  type?: string;
  hostedBy?: string;
  createdBy: LeanUser;
  roles: EventRole[];
};

export class ResponseBuilderService {
  private static logger = createLogger("ResponseBuilderService");

  private static getReadStatus(event: {
    status?: string;
    date?: string;
    endDate?: string;
    time?: string;
    endTime?: string;
    timeZone?: string;
  }): "upcoming" | "ongoing" | "completed" | "cancelled" {
    if (event.status === "cancelled") return "cancelled";

    if (typeof event.date === "string" && typeof event.time === "string") {
      return deriveEventStatus(
        event.date,
        typeof event.endDate === "string" ? event.endDate : event.date,
        event.time,
        typeof event.endTime === "string" ? event.endTime : event.time,
        event.timeZone,
      );
    }

    return event.status === "ongoing" || event.status === "completed"
      ? event.status
      : "upcoming";
  }

  private static getRegistrationCreatedTime(registration: {
    _id: Types.ObjectId;
    createdAt?: Date;
  }): number {
    if (registration.createdAt) {
      return new Date(registration.createdAt).getTime();
    }

    return registration._id.getTimestamp().getTime();
  }

  private static sortRegistrationsByCreatedTime<
    T extends { _id: Types.ObjectId; createdAt?: Date },
  >(
    registrations: T[],
  ): T[] {
    return [...registrations].sort((left, right) => {
      const timeDifference =
        ResponseBuilderService.getRegistrationCreatedTime(left) -
        ResponseBuilderService.getRegistrationCreatedTime(right);

      if (timeDifference !== 0) {
        return timeDifference;
      }

      return left._id.toString().localeCompare(right._id.toString());
    });
  }

  /**
   * Helper method to populate fresh organizer contact information
   */
  private static async populateFreshOrganizerContacts(
    organizerDetails: Array<Record<string, unknown>>,
    viewerId?: string,
    viewerRole?: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!organizerDetails || organizerDetails.length === 0) {
      return [];
    }

    const organizerUserIds = [
      ...new Set(
        organizerDetails
          .map((organizer) => organizer.userId?.toString())
          .filter(
            (userId): userId is string =>
              typeof userId === "string" && Types.ObjectId.isValid(userId),
          ),
      ),
    ];
    if (organizerUserIds.length === 0) {
      return organizerDetails.map((organizer) =>
        canViewExactPrivateProfileFields(
          viewerId,
          viewerRole,
          organizer.userId,
        )
          ? organizer
          : stripExactPrivateProfileFields(organizer),
      );
    }

    const users = (await User.find({ _id: { $in: organizerUserIds } })
      .select("email phone firstName lastName avatar")
      .lean()) as Array<{
      _id: Types.ObjectId;
      email?: string;
      phone?: string;
      firstName?: string;
      lastName?: string;
      avatar?: string;
    }>;
    const usersById = new Map(
      users.map((user) => [user._id.toString(), user]),
    );

    return organizerDetails.map((organizer) => {
      const userId = organizer.userId?.toString();
      const user = userId ? usersById.get(userId) : undefined;
      if (!user) {
        return canViewExactPrivateProfileFields(
          viewerId,
          viewerRole,
          organizer.userId,
        )
          ? organizer
          : stripExactPrivateProfileFields(organizer);
      }

      const hydratedOrganizer = {
        ...organizer,
        email: user.email,
        phone: user.phone || "Phone not provided",
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        avatar: user.avatar || (organizer as { avatar?: string }).avatar,
      };

      return canViewExactPrivateProfileFields(viewerId, viewerRole, userId)
        ? hydratedOrganizer
        : stripExactPrivateProfileFields(hydratedOrganizer);
    });
  }

  /**
   * Builds event data with registration information
   * Used for event detail API responses
   * @param eventId - The event ID to fetch
   * @param viewerId - The ID of the user viewing (optional)
   * @param viewerRole - The role of the user viewing (optional, for privacy checks)
   */
  static async buildEventWithRegistrations(
    eventId: string,
    viewerId?: string,
    viewerRole?: string,
  ): Promise<EventWithRegistrationData | null> {
    try {
      // Get basic event data
      const event = (await Event.findById(eventId)
        .populate(
          "createdBy",
          // Include contact and role fields so Organizer card can show email/phone
          "username firstName lastName email phone gender role roleInAtCloud avatar",
        )
        .lean()) as EventLean | null;

      if (!event) {
        return null;
      }

      const registrationQuery = Registration.find({ eventId: event._id })
        .select(
          "_id userId eventId roleId status attendanceConfirmed notes specialRequirements createdAt",
        )
        .populate({
          path: "userId",
          select:
            "username firstName lastName email phone avatar gender systemAuthorizationLevel roleInAtCloud role",
        })
        .lean();
      const [eventRegistrations, guestCounts, freshOrganizerDetails] =
        await Promise.all([
          registrationQuery as unknown as Promise<PopulatedRegistration[]>,
          GuestRegistration.aggregate<RoleCountRow>([
            { $match: { eventId: event._id, status: "active" } },
            { $group: { _id: "$roleId", count: { $sum: 1 } } },
          ]),
          ResponseBuilderService.populateFreshOrganizerContacts(
            event.organizerDetails || [],
            viewerId,
            viewerRole,
          ),
        ]);

      const sortedRegistrations =
        ResponseBuilderService.sortRegistrationsByCreatedTime(
          eventRegistrations || [],
        );
      const registrationsByRole = new Map<string, PopulatedRegistration[]>();
      for (const registration of sortedRegistrations) {
        const roleRegistrations =
          registrationsByRole.get(registration.roleId) || [];
        roleRegistrations.push(registration);
        registrationsByRole.set(registration.roleId, roleRegistrations);
      }
      const guestCountByRole = new Map(
        guestCounts.map((row) => [row._id, Number(row.count || 0)]),
      );

      // Determine if viewer can see all contact info (admin, event creator, or registered)
      const eventCreatorId = (
        event.createdBy as { _id?: Types.ObjectId }
      )?._id?.toString();
      const isEventCreator = viewerId && eventCreatorId === viewerId;

      const viewerRegistrations = viewerId
        ? sortedRegistrations.filter(
            (registration) =>
              registration.userId?._id.toString() === viewerId,
          )
        : [];
      const isRegistered = viewerRegistrations.length > 0;

      // Simplified visibility: admins, event creator, or ANY registered user can see ALL contacts
      const canManageUsers = canViewExactPrivateProfileFields(
        viewerId,
        viewerRole,
        undefined,
      );
      const canViewAllContacts =
        canManageUsers || isEventCreator || isRegistered;
      // Viewer can see mentor contacts if they're admin, event creator, or registered
      const canViewMentorContacts = canViewAllContacts;

      // Build roles with registration data and privacy-aware contact info
      const rolesWithRegistrations: EventRoleWithCounts[] = (
        event.roles || []
      ).map((role: EventRole) => {
        const registrations: RegistrationWithUser[] = [];
        const roleRegistrations = registrationsByRole.get(role.id) || [];

        // Transform each registration with privacy logic
        for (const reg of roleRegistrations) {
          if (!reg.userId) continue;
          let showEmail = false;
          let email = "";
          let phone = "";

          // Show contact information only to:
          // 1. Admins (Super Admin, Administrator)
          // 2. Event creator (organizer)
          // 3. The user themselves (viewing their own registration)
          const isOwnRegistration =
            viewerId && reg.userId._id.toString() === viewerId;
          if (canViewAllContacts || isOwnRegistration) {
            showEmail = true;
            email = reg.userId.email || "";
          }
          const showPhone = canViewExactPrivateProfileFields(
            viewerId,
            viewerRole,
            reg.userId._id,
          );
          if (showPhone) phone = reg.userId.phone || "";

          registrations.push({
            id: reg._id.toString(),
            userId: reg.userId._id.toString(),
            eventId: reg.eventId.toString(),
            roleId: reg.roleId,
            status: (reg.status ?? "active") as
              | "active"
              | "waitlisted"
              | "attended"
              | "no_show",
            attendanceConfirmed: reg.attendanceConfirmed === true,
            // Include participant-provided metadata
            notes: reg.notes,
            specialRequirements: reg.specialRequirements,
            user: {
              id: reg.userId._id.toString(),
              username: reg.userId.username,
              firstName: reg.userId.firstName,
              lastName: reg.userId.lastName,
              email: showEmail ? email : "",
              phone: showPhone ? phone : undefined,
              avatar: reg.userId.avatar,
              gender: reg.userId.gender,
              systemAuthorizationLevel:
                reg.userId.systemAuthorizationLevel || "Participant",
              roleInAtCloud: reg.userId.roleInAtCloud || "",
              role:
                reg.userId.role || reg.userId.systemAuthorizationLevel || "",
            },
            registeredAt: reg.createdAt || new Date(),
            eventSnapshot: {
              eventTitle: event.title,
              eventDate: event.date,
              eventTime: event.time,
              roleName: role.name,
              roleDescription: role.description || "",
            },
          });
        }

        const signupCount =
          roleRegistrations.length + (guestCountByRole.get(role.id) || 0);
        const maxParticipants = role.maxParticipants || role.maxSignups || 0;
        const availableSpots = Math.max(0, maxParticipants - signupCount);

        return {
          id: role.id,
          name: role.name,
          description: role.description || "",
          agenda: role.agenda,
          maxParticipants: maxParticipants,
          // Surface openToPublic so create/update responses reflect current flag state
          openToPublic:
            (role as { openToPublic?: boolean }).openToPublic === true,
          currentCount: signupCount,
          availableSpots: availableSpots,
          isFull: signupCount >= maxParticipants,
          waitlistCount: 0,
          registrations,
        };
      });
      const totalSlots = rolesWithRegistrations.reduce(
        (total, role) => total + role.maxParticipants,
        0,
      );
      const totalSignups = rolesWithRegistrations.reduce(
        (total, role) => total + role.currentCount,
        0,
      );

      // Build pricing object
      const pricingData = (
        event as { pricing?: { isFree?: boolean; price?: number } }
      ).pricing
        ? {
            isFree:
              (event as { pricing?: { isFree?: boolean; price?: number } })
                .pricing!.isFree ?? true,
            price:
              (event as { pricing?: { isFree?: boolean; price?: number } })
                .pricing!.price ?? undefined,
          }
        : { isFree: true };

      return {
        id: event._id.toString(),
        title: event.title,
        type: event.type || "",
        date: event.date,
        endDate: event.endDate || event.date,
        time: event.time,
        endTime: event.endTime || event.time,
        location: event.location || "",
        organizer: event.organizer || "",
        hostedBy: event.hostedBy,
        purpose: event.purpose || "",
        agenda: event.agenda,
        format: event.format || "",
        timeZone: event.timeZone,
        flyerUrl: event.flyerUrl,
        secondaryFlyerUrl: event.secondaryFlyerUrl,
        youtubeUrl: event.youtubeUrl,
        // Programs & Mentors (optional)
        programId: (event as unknown as { programId?: Types.ObjectId | null })
          .programId
          ? (
              event as unknown as { programId?: Types.ObjectId | null }
            ).programId!.toString()
          : null,
        programLabels: (() => {
          const programLabelsRaw = (
            event as unknown as { programLabels?: Types.ObjectId[] }
          ).programLabels;
          if (Array.isArray(programLabelsRaw)) {
            return programLabelsRaw.map((id) => id.toString());
          }
          return [];
        })(),
        mentorCircle:
          (event as unknown as { mentorCircle?: "E" | "M" | "B" | "A" | null })
            .mentorCircle ?? null,
        mentors:
          (
            event as unknown as {
              mentors?: Array<{
                userId?: Types.ObjectId;
                name?: string;
                email?: string;
                gender?: "male" | "female";
                avatar?: string;
                roleInAtCloud?: string;
              }> | null;
            }
          ).mentors?.map((m) => ({
            userId: m.userId ? m.userId.toString() : undefined,
            name: m.name,
            // Only show mentor email to admins, event creator, or registered users
            email: canViewMentorContacts ? m.email : undefined,
            gender: m.gender,
            avatar: m.avatar,
            roleInAtCloud: m.roleInAtCloud,
          })) ?? null,
        // Virtual meeting fields (optional)
        zoomLink: event.zoomLink,
        meetingId: event.meetingId,
        passcode: event.passcode,
        disclaimer: event.disclaimer,
        workshopGroupTopics: event.workshopGroupTopics || {},
        organizerDetails: freshOrganizerDetails as unknown as OrganizerDetail[],
        roles: rolesWithRegistrations,
        totalCapacity: totalSlots,
        totalRegistrations: totalSignups,
        availableSpots: Math.max(0, totalSlots - totalSignups),
        totalSlots,
        signedUp: totalSignups,
        maxParticipants: totalSlots,
        createdBy: ResponseBuilderService.buildUserBasicInfo(
          event.createdBy,
          canViewExactPrivateProfileFields(
            viewerId,
            viewerRole,
            eventCreatorId,
          ),
        ),
        createdAt: event.createdAt || new Date(0),
        updatedAt: event.updatedAt || new Date(0),
        status: ResponseBuilderService.getReadStatus(event),
        // Publish metadata (needed for organizer UI to persist state across refresh)
        publish: (event as { publish?: boolean }).publish === true,
        publishedAt: (event as { publishedAt?: Date }).publishedAt || null,
        publicSlug: event.publicSlug,
        autoUnpublishedAt:
          (event as { autoUnpublishedAt?: Date | null }).autoUnpublishedAt ||
          null,
        autoUnpublishedReason:
          (event as { autoUnpublishedReason?: string | null })
            .autoUnpublishedReason || null,
        // 48-hour grace period fields
        unpublishScheduledAt:
          (event as { unpublishScheduledAt?: Date | null })
            .unpublishScheduledAt || null,
        unpublishWarningFields:
          (event as { unpublishWarningFields?: string[] })
            .unpublishWarningFields || undefined,
        requirements: event.requirements,
        materials: event.materials,
        // Pricing (Paid Events Feature - Phase 6)
        pricing: pricingData,
      };
    } catch (error) {
      this.logger.error("buildEventWithRegistrations error", error as Error);
      return null;
    }
  }

  /**
   * Builds lightweight event-list DTOs with batched user and guest occupancy.
   * The query count is constant for a page: one registration aggregation and
   * one guest aggregation, regardless of the number of events or roles.
   */
  static async buildEventsWithRegistrations(
    events: Array<{ _id: Types.ObjectId } & Partial<EventLean>>,
  ): Promise<EventListItemData[]> {
    if (!events || events.length === 0) {
      return [];
    }

    const eventIds = events.map((event) => event._id);
    const [registrationCounts, guestCounts] = await Promise.all([
      Registration.aggregate<OccupancyAggregateRow>([
        { $match: { eventId: { $in: eventIds } } },
        {
          $group: {
            _id: { eventId: "$eventId", roleId: "$roleId" },
            count: { $sum: 1 },
          },
        },
      ]),
      GuestRegistration.aggregate<OccupancyAggregateRow>([
        { $match: { eventId: { $in: eventIds }, status: "active" } },
        {
          $group: {
            _id: { eventId: "$eventId", roleId: "$roleId" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const occupancyByRole = new Map<string, number>();
    const addCounts = (rows: OccupancyAggregateRow[]) => {
      rows.forEach((row) => {
        const key = `${row._id.eventId.toString()}:${row._id.roleId}`;
        occupancyByRole.set(
          key,
          (occupancyByRole.get(key) ?? 0) + Number(row.count || 0),
        );
      });
    };
    addCounts(registrationCounts);
    addCounts(guestCounts);

    return events.map((eventInput) => {
      const event = eventInput as EventLean;
      const eventId = event._id.toString();
      const roles = (event.roles || []).map((role) => {
        const currentCount = occupancyByRole.get(`${eventId}:${role.id}`) ?? 0;
        const maxParticipants = role.maxParticipants || role.maxSignups || 0;
        return {
          id: role.id,
          name: role.name,
          description: role.description || "",
          agenda: (role as { agenda?: string }).agenda,
          maxParticipants,
          openToPublic: role.openToPublic === true,
          currentCount,
          availableSpots: Math.max(0, maxParticipants - currentCount),
          isFull: currentCount >= maxParticipants,
          waitlistCount: 0,
          currentSignups: [] as [],
        };
      });
      const totalSlots = roles.reduce(
        (total, role) => total + role.maxParticipants,
        0,
      );
      const signedUp = roles.reduce(
        (total, role) => total + role.currentCount,
        0,
      );
      const status = ResponseBuilderService.getReadStatus(event);

      return {
        id: eventId,
        title: event.title,
        type: event.type || "",
        date: event.date,
        endDate: event.endDate || event.date,
        time: event.time,
        endTime: event.endTime || event.time,
        timeZone: event.timeZone,
        location: event.location || "",
        organizer: event.organizer || "",
        organizerDetails:
          ((event.organizerDetails || []).map((organizer) =>
            stripExactPrivateProfileFields(organizer),
          ) as unknown as OrganizerDetail[]) || [],
        hostedBy: event.hostedBy,
        format: event.format || "",
        status,
        createdBy: ResponseBuilderService.buildUserBasicInfo(
          event.createdBy || ({ id: "" } as { id: string }),
        ),
        createdAt: event.createdAt || new Date(0),
        roles,
        totalCapacity: totalSlots,
        totalRegistrations: signedUp,
        availableSpots: Math.max(0, totalSlots - signedUp),
        totalSlots,
        signedUp,
        maxParticipants: totalSlots,
        publish: event.publish === true,
        publishedAt: event.publishedAt || null,
        publicSlug: event.publicSlug,
        youtubeUrl: event.youtubeUrl,
        programLabels: (event.programLabels || []).map((id) => id.toString()),
      };
    });
  }

  /**
   * Builds basic user info
   * Used for user-related API responses
   */
  static buildUserBasicInfo(
    user: LeanUser | { id: string },
    includeExactPrivateFields = false,
  ): UserBasicInfo {
    return {
      id: (user as LeanUser)._id
        ? (user as LeanUser)._id.toString()
        : (user as { id: string }).id,
      username: (user as LeanUser).username,
      firstName: (user as LeanUser).firstName,
      lastName: (user as LeanUser).lastName,
      email: (user as LeanUser).email || "",
      ...(includeExactPrivateFields && (user as LeanUser).phone
        ? { phone: (user as LeanUser).phone }
        : {}),
      avatar: (user as LeanUser).avatar,
      gender: (user as LeanUser).gender,
      systemAuthorizationLevel:
        (user as LeanUser).role ||
        (user as LeanUser).systemAuthorizationLevel ||
        "Participant",
      roleInAtCloud: (user as LeanUser).roleInAtCloud || "",
      role:
        (user as LeanUser).role ||
        (user as LeanUser).systemAuthorizationLevel ||
        "",
    };
  }

  /**
   * Builds analytics event data
   * Used for analytics API responses
   */
  static async buildAnalyticsEventData(
    events: AnalyticsEventInput[],
  ): Promise<AnalyticsEventData[]> {
    if (!events || events.length === 0) {
      return [];
    }

    try {
      const analyticsData = await Promise.all(
        events.map(async (event) => {
          // Get registration counts for this event
          const eventSignupCounts =
            await RegistrationQueryService.getEventSignupCounts(
              event._id.toString(),
            );

          // Fetch registrations for this event to power engagement metrics
          const eventRegistrations = await Registration.find({
            eventId: event._id,
          })
            .populate({
              path: "userId",
              select:
                "username firstName lastName systemAuthorizationLevel roleInAtCloud role avatar gender",
            })
            .lean();

          // Group registrations by role for quick lookup
          const regsByRole = new Map<string, RegLean[]>();
          for (const reg of (eventRegistrations as unknown as RegLean[]) ||
            []) {
            const key = reg.roleId;
            if (!regsByRole.has(key)) regsByRole.set(key, []);
            regsByRole.get(key)!.push(reg);
          }

          const totalSlots = eventSignupCounts
            ? event.roles.reduce(
                (total: number, role: EventRole) =>
                  total + role.maxParticipants,
                0,
              )
            : 0;

          return {
            id: event._id.toString(),
            title: event.title,
            date: event.date,
            endDate: event.endDate || event.date,
            time: event.time,
            endTime: event.endTime || event.time, // fallback to time if endTime missing
            location: event.location || "",
            status: event.status || "upcoming",
            format: event.format || "",
            timeZone: event.timeZone,
            type: event.type || "",
            hostedBy: event.hostedBy || "@Cloud Marketplace Ministry", // default fallback
            createdBy: ResponseBuilderService.buildUserBasicInfo(
              event.createdBy,
            ),
            roles: event.roles.map((role: EventRole) => {
              const roleCount =
                eventSignupCounts?.roles.find((r) => r.roleId === role.id)
                  ?.currentCount || 0;

              const roleRegs = (regsByRole.get(role.id) || []).map((reg) => ({
                id: reg._id.toString(),
                userId:
                  reg.userId &&
                  typeof reg.userId === "object" &&
                  "_id" in reg.userId
                    ? (reg.userId as LeanUser)._id.toString()
                    : reg.userId
                      ? (reg.userId as Types.ObjectId).toString()
                      : "",
                eventId: reg.eventId.toString(),
                roleId: reg.roleId,
                status: (reg.status || "active") as
                  | "active"
                  | "waitlisted"
                  | "attended"
                  | "no_show",
                attendanceConfirmed: reg.attendanceConfirmed === true,
                user: ResponseBuilderService.buildUserBasicInfo(
                  (reg.userId && typeof reg.userId === "object"
                    ? (reg.userId as LeanUser)
                    : ({
                        id: reg.userId
                          ? (reg.userId as Types.ObjectId).toString()
                          : "",
                      } as { id: string })) as LeanUser | { id: string },
                ),
                registeredAt: reg.createdAt || new Date(),
                // Minimal snapshot for analytics; detailed snapshot not needed here
                eventSnapshot: {
                  eventTitle: event.title,
                  eventDate: event.date,
                  eventTime: event.time,
                  roleName: role.name,
                  roleDescription: role.description || "",
                },
              }));
              return {
                id: role.id,
                name: role.name,
                maxParticipants: role.maxParticipants,
                currentCount: roleCount,
                registrations: roleRegs, // Populated for engagement metrics
              };
            }),
            totalCapacity: totalSlots,
            totalRegistrations: eventSignupCounts?.totalSignups || 0,
            registrationRate:
              totalSlots > 0
                ? ((eventSignupCounts?.totalSignups || 0) / totalSlots) * 100
                : 0,
          };
        }),
      );

      return analyticsData;
    } catch (error) {
      this.logger.error("Error building analytics event data", error as Error);
      return [];
    }
  }

  /**
   * Builds user signup status for a specific event
   * Used for user signup API responses
   */
  static async buildUserSignupStatus(
    userId: string,
    eventId: string,
  ): Promise<{
    userId: string;
    eventId: string;
    isRegistered: boolean;
    canSignup: boolean;
    canSignupForMoreRoles: boolean;
    currentSignupCount: number;
    maxAllowedSignups: number;
    availableRoles: string[];
    restrictedRoles: string[];
    currentRole: string | null;
  } | null> {
    try {
      // Get event details
      const event = (await Event.findById(eventId).lean()) as
        | (Pick<EventLean, "_id" | "type" | "roles"> & { roles: EventRole[] })
        | null;
      if (!event) return null;

      // Get user details
      const user = (await User.findById(userId).lean()) as
        | (Pick<LeanUser, "systemAuthorizationLevel"> & { _id: Types.ObjectId })
        | null;
      if (!user) return null;

      // Get user signup info
      const userSignupInfo =
        await RegistrationQueryService.getUserSignupInfo(userId);
      if (!userSignupInfo) return null;

      // Get event signup counts
      const eventSignupCounts =
        await RegistrationQueryService.getEventSignupCounts(eventId);
      if (!eventSignupCounts) return null;

      // Check if user is already registered for this event
      const existingRegistration = (await Registration.findOne({
        userId,
        eventId,
      }).lean()) as unknown as { roleId?: string } | null;

      // Determine available and restricted roles based on user authorization level
      const availableRoles: string[] = [];
      const restrictedRoles: string[] = [];

      for (const role of event.roles) {
        const roleSignupData = eventSignupCounts.roles.find(
          (r) => r.roleId === role.id,
        );
        const isFull = roleSignupData?.isFull || false;

        // Role restrictions based on authorization level
        if (user.systemAuthorizationLevel === "Participant") {
          // Participants: allow some roles depending on event type
          const webinarAllowed = [
            "Attendee",
            "Breakout Room Leads for E Circle",
            "Breakout Room Leads for M Circle",
            "Breakout Room Leads for B Circle",
            "Breakout Room Leads for A Circle",
          ];
          if (
            (event.type === "Webinar" && webinarAllowed.includes(role.name)) ||
            role.name.includes("Common Participant")
          ) {
            if (!isFull) availableRoles.push(role.name);
          } else {
            restrictedRoles.push(role.name);
          }
        } else {
          if (!isFull) availableRoles.push(role.name);
        }
      }

      const canSignup =
        !existingRegistration &&
        userSignupInfo.canSignupForMore &&
        availableRoles.length > 0;

      return {
        userId,
        eventId,
        isRegistered: !!existingRegistration,
        canSignup,
        canSignupForMoreRoles: userSignupInfo.canSignupForMore,
        currentSignupCount: userSignupInfo.currentSignups,
        maxAllowedSignups: userSignupInfo.maxAllowedSignups,
        availableRoles,
        restrictedRoles,
        currentRole: existingRegistration?.roleId || null,
      };
    } catch (error) {
      this.logger.error("Error building user signup status", error as Error);
      return null;
    }
  }
}
