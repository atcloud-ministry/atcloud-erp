/**
 * useRealtimeEventUpdates Hook
 *
 * Manages real-time WebSocket event updates for the EventDetail page.
 * Handles 15+ event update types, guest synchronization, notifications,
 * auto-unpublish detection, and backend-to-frontend data conversion.
 *
 * Extracted from EventDetail.tsx to improve modularity and testability.
 */

import { useEffect, useRef } from "react";
import type { EventData, EventRole } from "../types/event";
import { eventService } from "../services/api";
import GuestApi from "../services/guestApi";
import { socketService, type EventUpdate } from "../services/socketService";
import {
  getMissingNecessaryFieldsForPublishFrontend,
  PUBLISH_FIELD_LABELS,
} from "../types/event";

// Types for guest display
type GuestDisplay = {
  id?: string;
  fullName: string;
  email?: string;
  phone?: string;
  notes?: string;
};

type GuestApiGuest = {
  id?: string;
  _id?: string;
  fullName: string;
  email?: string;
  phone?: string;
  notes?: string;
  roleId: string;
};

// Backend event/role/user shapes for safe conversion
type BackendUser = {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  gender?: "male" | "female";
  systemAuthorizationLevel?: string;
  roleInAtCloud?: string;
};

type BackendRegistration = {
  id?: string;
  user: BackendUser;
  status?: EventRole["currentSignups"][0]["registrationStatus"];
  attendanceConfirmed?: boolean;
  notes?: string;
  registeredAt?: string;
};

type BackendRole = {
  id: string;
  name: string;
  description: string;
  maxParticipants: number;
  registrations?: BackendRegistration[];
  currentSignups?: EventRole["currentSignups"];
};

type BackendEventLike = {
  id?: string;
  _id?: string;
  title: string;
  type: string;
  date: string;
  endDate?: string;
  time: string;
  endTime: string;
  timeZone?: string;
  location: string;
  organizer: string;
  hostedBy?: string;
  organizerDetails?: EventData["organizerDetails"];
  purpose?: string;
  agenda?: string;
  format: string;
  disclaimer?: string;
  roles: BackendRole[];
  signedUp?: number;
  totalSlots?: number;
  createdBy: EventData["createdBy"];
  createdAt: string;
  isHybrid?: boolean;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  requirements?: string;
  materials?: string;
  status?: "completed" | "cancelled" | "upcoming" | string;
  attendees?: number;
  workshopGroupTopics?: EventData["workshopGroupTopics"];
  flyerUrl?: string;
  secondaryFlyerUrl?: string;
  // Paid events
  pricing?: { isFree: boolean; price?: number };
  // Programs integration
  programLabels?: string[];
  // Publishing fields
  publish?: boolean;
  publicSlug?: string;
  publishedAt?: string;
  // Auto-unpublish tracking
  autoUnpublishedAt?: string | null;
  autoUnpublishedReason?: string | null;
  unpublishScheduledAt?: string | null;
  unpublishWarningFields?: string[];
};

// Hook parameters
export interface UseRealtimeEventUpdatesParams {
  eventId: string | undefined;
  currentUserId: string;
  setEvent: React.Dispatch<React.SetStateAction<EventData | null>>;
  setGuestsByRole: React.Dispatch<
    React.SetStateAction<Record<string, GuestDisplay[]>>
  >;
  notification: {
    info: (message: string, options?: { title?: string }) => void;
    warning: (message: string, options?: { title?: string }) => void;
  };
  locationPathname: string;
}

/**
 * Custom hook for managing real-time event updates via WebSocket
 */
export function useRealtimeEventUpdates({
  eventId,
  setEvent,
  setGuestsByRole,
  notification,
}: UseRealtimeEventUpdatesParams): void {
  // Keep a stable reference for notifications inside effects
  const notificationRef = useRef(notification);
  const eventRefreshSequenceRef = useRef(0);
  const guestRefreshSequenceRef = useRef(0);
  useEffect(() => {
    notificationRef.current = notification;
  }, [notification]);

  // Set up real-time socket connection and event listeners
  useEffect(() => {
    const token = localStorage.getItem("authToken");
    if (!token || !eventId) return;

    let isComponentMounted = true; // Track component mount state
    socketService.connect(token);
    void Promise.resolve(socketService.joinEventRoom(eventId)).catch(
      (error: unknown) => {
        if (import.meta.env.DEV) {
          console.warn("Unable to subscribe to realtime event updates:", error);
        }
      },
    );

    // Handle event updates with current values
    const handleEventUpdate = async (updateData: EventUpdate) => {
      // Early return if component unmounted or wrong event
      if (
        !isComponentMounted ||
        !updateData ||
        updateData.eventId !== eventId ||
        typeof updateData.updateType !== "string"
      ) {
        return;
      }
      const eventRefreshSequence = ++eventRefreshSequenceRef.current;

      // Guest details are also refreshed through their viewer-authorized API.
      const guestRefresh = (async () => {
        if (!updateData.updateType.startsWith("guest_")) return;
        const guestRefreshSequence = ++guestRefreshSequenceRef.current;
        try {
          const data = await GuestApi.getEventGuests(eventId);
          const grouped: Record<string, GuestDisplay[]> = {};
          const guests = (data?.guests || []) as GuestApiGuest[];
          guests.forEach((guest) => {
            if (!grouped[guest.roleId]) grouped[guest.roleId] = [];
            grouped[guest.roleId].push({
              id: guest.id || guest._id!,
              fullName: guest.fullName,
              email: guest.email,
              phone: guest.phone,
              notes: guest.notes,
            });
          });
          if (
            isComponentMounted &&
            guestRefreshSequenceRef.current === guestRefreshSequence
          ) {
            setGuestsByRole(grouped);
          }
        } catch {
          // Event refetch below remains the source of truth for the main view.
        }
      })();

      notificationRef.current.info("Event information has changed.", {
        title: "Event Updated",
      });

      // Always refetch fresh event for viewer-specific privacy (ensures email/phone visibility is correct without page refresh)
      try {
        const fresh = (await eventService.getEvent(
          eventId
        )) as unknown as BackendEventLike;
        if (
          isComponentMounted &&
          eventRefreshSequenceRef.current === eventRefreshSequence
        ) {
          setEvent((prev) => {
            const viewerScopedEvent: EventData = {
              id: fresh.id || fresh._id!,
              title: fresh.title,
              type: fresh.type,
              date: fresh.date,
              endDate: fresh.endDate,
              time: fresh.time,
              endTime: fresh.endTime,
              timeZone: fresh.timeZone,
              location: fresh.location,
              organizer: fresh.organizer,
              hostedBy: fresh.hostedBy,
              organizerDetails: fresh.organizerDetails || [],
              purpose: fresh.purpose,
              agenda: fresh.agenda,
              format: fresh.format,
              disclaimer: fresh.disclaimer,
              flyerUrl: fresh.flyerUrl,
              secondaryFlyerUrl: fresh.secondaryFlyerUrl,
              roles: fresh.roles.map((role: BackendRole) => {
                interface RoleWithPublic extends BackendRole {
                  openToPublic?: boolean;
                  capacityRemaining?: number;
                }
                const r = role as RoleWithPublic;
                return {
                  id: role.id,
                  name: role.name,
                  description: role.description,
                  maxParticipants: role.maxParticipants,
                  openToPublic:
                    r.openToPublic ??
                    prev?.roles.find((pr) => pr.id === role.id)?.openToPublic,
                  capacityRemaining: r.capacityRemaining,
                  currentSignups: role.registrations
                    ? role.registrations.map((reg: BackendRegistration) => ({
                        registrationId: reg.id,
                        userId: reg.user.id,
                        username: reg.user.username,
                        firstName: reg.user.firstName,
                        lastName: reg.user.lastName,
                        email: reg.user.email,
                        phone: reg.user.phone,
                        avatar: reg.user.avatar,
                        gender: reg.user.gender,
                        systemAuthorizationLevel:
                          (reg.user as { role?: string }).role ||
                          reg.user.systemAuthorizationLevel,
                        roleInAtCloud: reg.user.roleInAtCloud,
                        notes: reg.notes,
                        registeredAt: reg.registeredAt,
                        registrationStatus: reg.status,
                        attendanceConfirmed: reg.attendanceConfirmed,
                      }))
                    : role.currentSignups || [],
                };
              }),
              signedUp:
                fresh.roles?.reduce(
                  (sum: number, role: BackendRole) =>
                    sum +
                    (role.registrations?.length ||
                      role.currentSignups?.length ||
                      0),
                  0
                ) || 0,
              totalSlots:
                fresh.roles?.reduce(
                  (sum: number, role: BackendRole) =>
                    sum + (role.maxParticipants || 0),
                  0
                ) || 0,
              createdBy: fresh.createdBy,
              createdAt: fresh.createdAt,
              isHybrid: fresh.isHybrid,
              zoomLink: fresh.zoomLink,
              meetingId: fresh.meetingId,
              passcode: fresh.passcode,
              requirements: fresh.requirements,
              materials: fresh.materials,
              status:
                fresh.status === "completed" || fresh.status === "cancelled"
                  ? fresh.status
                  : undefined,
              attendees: fresh.attendees,
              workshopGroupTopics: fresh.workshopGroupTopics || undefined,
              publish: fresh.publish ?? prev?.publish,
              publicSlug: fresh.publicSlug ?? prev?.publicSlug,
              publishedAt: fresh.publishedAt ?? prev?.publishedAt,
              // Preserve pricing and program data (critical for UI sections)
              pricing: fresh.pricing ?? prev?.pricing,
              programLabels: fresh.programLabels ?? prev?.programLabels,
              // Auto-unpublish tracking
              autoUnpublishedAt:
                fresh.autoUnpublishedAt ?? prev?.autoUnpublishedAt,
              autoUnpublishedReason:
                fresh.autoUnpublishedReason ?? prev?.autoUnpublishedReason,
              unpublishScheduledAt:
                fresh.unpublishScheduledAt ?? prev?.unpublishScheduledAt,
              unpublishWarningFields:
                fresh.unpublishWarningFields ?? prev?.unpublishWarningFields,
            };
            // Detect auto-unpublish (published -> unpublished) with reason
            try {
              const wasPublished = prev?.publish;
              const nowPublished = viewerScopedEvent.publish;
              const reason = viewerScopedEvent.autoUnpublishedReason;
              if (
                wasPublished &&
                wasPublished === true &&
                nowPublished === false &&
                reason === "MISSING_REQUIRED_FIELDS"
              ) {
                // Build human readable missing fields using the helper (defensive: rely on current viewerScopedEvent values)
                const missing =
                  getMissingNecessaryFieldsForPublishFrontend(
                    viewerScopedEvent
                  );
                const readable = missing.map(
                  (m) => PUBLISH_FIELD_LABELS[m] || m
                );
                notificationRef.current.warning(
                  readable.length
                    ? `Event automatically unpublished: missing ${readable.join(
                        ", "
                      )}`
                    : "Event automatically unpublished due to missing required fields",
                  { title: "Auto-unpublished" }
                );
              }
            } catch {
              // Swallow detection errors silently (non-critical UX enhancement)
            }
            return viewerScopedEvent;
          });
        }
      } catch {
        // A later invalidation or normal page reload will retry the HTTP fetch.
      }
      await guestRefresh;
    };

    socketService.on("event_update", handleEventUpdate);

    // Cleanup on unmount
    return () => {
      isComponentMounted = false; // Mark component as unmounted
      eventRefreshSequenceRef.current += 1;
      guestRefreshSequenceRef.current += 1;
      socketService.off("event_update", handleEventUpdate);
      socketService.leaveEventRoom(eventId);
    };
  }, [eventId, setEvent, setGuestsByRole]); // notification handled via ref to avoid unstable deps
}
