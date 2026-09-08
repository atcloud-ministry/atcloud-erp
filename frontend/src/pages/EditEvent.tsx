import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { deriveFlyerUrlForUpdate } from "../utils/flyerUrl";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useForm, type Resolver } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import BasicEventFields from "../components/EditEvent/BasicEventFields";
import type { Organizer } from "../components/events/OrganizerSelection";
import FormatSettings from "../components/EditEvent/FormatSettings";
import RoleManagement from "../components/EditEvent/RoleManagement";
import PricingSection from "../components/EditEvent/PricingSection";
import NotificationPreference from "../components/EditEvent/NotificationPreference";
import EditEventModals from "../components/EditEvent/EditEventModals";
import ConfirmationModal from "../components/common/ConfirmationModal";
import { useAuth } from "../hooks/useAuth";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import LoadingSpinner from "../components/common/LoadingSpinner";
import { useEventValidation } from "../hooks/useEventValidation";
import { eventSchema, type EventFormData } from "../schemas/eventSchema";
import { eventService } from "../services/api";
import type { EventData, OrganizerDetail } from "../types/event";
import { getMissingNecessaryFieldsForPublishFrontend } from "../types/event";
import type { FieldValidation } from "../utils/eventValidationUtils";
import { normalizeEventDate } from "../utils/eventStatsUtils";
import {
  buildTimeOverlapConfirmationMessage,
  type TimeOverlapConflict,
} from "../utils/timeOverlapConflicts";
// Roles utilities
import { useRoleValidation } from "../hooks/useRoleValidation";
import { useEventDataLoader } from "../hooks/useEventDataLoader";

interface FormRole {
  id: string;
  name: string;
  description: string;
  agenda?: string;
  maxParticipants: number;
  openToPublic?: boolean;
  currentSignups: Array<{
    userId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    avatar?: string | null;
    gender?: string;
    systemAuthorizationLevel?: string;
    roleInAtCloud?: string;
    notes?: string;
  }>;
}

// Payload shape for updating a role when submitting the form
interface RoleUpdatePayload {
  id?: string; // optional because newly added roles might not yet have backend IDs
  name: string;
  description: string;
  agenda?: string;
  maxParticipants: number;
  startTime?: string;
  endTime?: string;
  openToPublic?: boolean;
}

// Payload shape for updating an event (subset / superset of EventData with optional fields)
interface EventUpdatePayload {
  title: string;
  type: string;
  format: string;
  date: string;
  endDate?: string;
  time: string;
  endTime?: string;
  timeZone?: string;
  organizer: string;
  purpose?: string;
  agenda?: string;
  location?: string;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  disclaimer?: string;
  hostedBy?: string;
  flyerUrl?: string | null; // null used to explicitly remove
  programLabels?: string[];
  roles: RoleUpdatePayload[];
  organizerDetails: OrganizerDetail[]; // always send array (can be empty)
  suppressNotifications?: boolean; // when user opts out of notifications
  // Allow additional properties if backend accepts flexible fields
  [key: string]: unknown;
}

export default function EditEvent() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser } = useAuth();
  const notification = useToastReplacement();
  const [selectedOrganizers, setSelectedOrganizers] = useState<Organizer[]>([]);
  // Track original flyer so we can decide if a blank means removal
  const [originalFlyerUrl, setOriginalFlyerUrl] = useState<string | null>(null);
  const [originalSecondaryFlyerUrl, setOriginalSecondaryFlyerUrl] = useState<
    string | null
  >(null);
  const [eventData, setEventData] = useState<EventData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sendNotificationsPref, setSendNotificationsPref] = useState<
    boolean | null
  >(null);
  // track if user interacted with notification radios (not needed for error visibility)
  const [, setNotificationPrefTouched] = useState(false);

  // Load event data, programs, and templates using custom hook
  const { loading, programs, programLoading, templates, dbTemplates } =
    useEventDataLoader({
      eventId: id,
      currentUser,
      onEventLoad: ({
        event,
        formData,
        selectedOrganizers: loadedOrganizers,
        originalFlyerUrl: loadedFlyerUrl,
        originalSecondaryFlyerUrl: loadedSecondaryFlyerUrl,
        mentorIds,
      }) => {
        setEventData(event);
        setOriginalFlyerUrl(loadedFlyerUrl);
        setOriginalSecondaryFlyerUrl(loadedSecondaryFlyerUrl);
        setSelectedOrganizers(loadedOrganizers);
        reset(formData);
        // Set mentor IDs if present
        if (mentorIds && mentorIds.length) {
          (setValue as unknown as (name: string, value: string[]) => void)(
            "mentorIds",
            mentorIds,
          );
        }
        // Reset templateApplied flag when loading event
        setTemplateApplied(false);
      },
      onError: (message) => notification.error(message),
      onNavigate: (path) => navigate(path),
    });

  const form = useForm<EventFormData>({
    resolver: yupResolver(eventSchema) as unknown as Resolver<EventFormData>,
    defaultValues: {
      title: "",
      type: "",
      format: "",
      date: "",
      endDate: "",
      time: "",
      endTime: "",
      timeZone:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone ||
            "America/Los_Angeles"
          : "America/Los_Angeles",
      organizer: "",
      purpose: "",
      agenda: "",
      location: "",
      zoomLink: "",
      meetingId: "",
      passcode: "",
      disclaimer: "",
      hostedBy: "",
      programLabels: [],
      roles: [],
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    reset,
    watch,
    getValues,
  } = form;

  // Register hidden validation fields so updates trigger re-render
  useEffect(() => {
    type HiddenValidationField =
      | "__startOverlapValidation"
      | "__endOverlapValidation";
    const registerHidden = (name: HiddenValidationField) =>
      (register as unknown as (name: string) => void)(name);
    const setHidden = (name: HiddenValidationField, value: FieldValidation) =>
      (
        setValue as unknown as (
          name: string,
          value: FieldValidation,
          options?: { shouldDirty?: boolean; shouldValidate?: boolean },
        ) => void
      )(name, value, { shouldDirty: false, shouldValidate: false });

    registerHidden("__startOverlapValidation");
    registerHidden("__endOverlapValidation");
    setHidden("__startOverlapValidation", {
      isValid: true,
      message: "",
      color: "text-gray-500",
    });
    setHidden("__endOverlapValidation", {
      isValid: true,
      message: "",
      color: "text-gray-500",
    });
  }, [register, setValue]);

  // Add validation hook and watch functionality
  const allowPastDates = eventData?.status === "completed";
  const { validations } = useEventValidation(watch, { allowPastDates });

  // Watch the format field to show/hide conditional fields
  const selectedFormat = watch("format");
  const currentLocation = watch("location");
  const currentZoomLink = watch("zoomLink");
  const currentMeetingId = watch("meetingId");
  const currentPasscode = watch("passcode");
  const selectedEventType = watch("type");
  const formRoles =
    (watch("roles") as Array<{
      id: string;
      name: string;
      description: string;
      agenda?: string;
      maxParticipants: number;
      openToPublic?: boolean;
      currentSignups?: Array<unknown>;
    }>) || [];

  // Note: templates and dbTemplates now loaded from useEventDataLoader hook
  const [customizeRoles, setCustomizeRoles] = useState(false);

  // Template selector states (for "Use Template" feature)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [highlightTemplateSelector, setHighlightTemplateSelector] =
    useState(false);
  const [highlightRoleSection, setHighlightRoleSection] = useState(false);

  // Track if a template was applied (for registration deletion confirmation)
  const [templateApplied, setTemplateApplied] = useState(false);

  // Modal states for template confirmation and selection
  const [confirmResetModal, setConfirmResetModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ isOpen: false, title: "", message: "", onConfirm: () => {} });
  const [timeOverlapConfirmation, setTimeOverlapConfirmation] = useState<{
    isOpen: boolean;
    conflicts: TimeOverlapConflict[];
    resolve?: (confirmed: boolean) => void;
  }>({ isOpen: false, conflicts: [] });

  // Registration deletion confirmation modal state
  const [registrationDeletionModal, setRegistrationDeletionModal] = useState<{
    isOpen: boolean;
    registrationCount: number;
    userCount: number;
    guestCount: number;
    pendingFormData: EventFormData | null;
  }>({
    isOpen: false,
    registrationCount: 0,
    userCount: 0,
    guestCount: 0,
    pendingFormData: null,
  });

  const requestTimeOverlapConfirmation = useCallback(
    (conflicts: TimeOverlapConflict[]) =>
      new Promise<boolean>((resolve) => {
        setTimeOverlapConfirmation({
          isOpen: true,
          conflicts,
          resolve,
        });
      }),
    [],
  );

  const closeTimeOverlapConfirmation = (confirmed: boolean) => {
    timeOverlapConfirmation.resolve?.(confirmed);
    setTimeOverlapConfirmation({ isOpen: false, conflicts: [] });
  };

  // Track original published state & original format for predictive warning
  const originalPublishedRef = useRef<boolean | undefined>(undefined);
  const originalFormatRef = useRef<string | undefined>(undefined);
  const [formatWarningMissing, setFormatWarningMissing] = useState<string[]>(
    [],
  );

  // Derive predictive missing fields if format changed on a published event
  useEffect(() => {
    if (!eventData) return;
    if (originalPublishedRef.current === undefined) {
      originalPublishedRef.current = !!eventData.publish;
    }
    if (originalFormatRef.current === undefined) {
      originalFormatRef.current = eventData.format;
    }
    const published = !!eventData.publish;
    const formatChanged =
      selectedFormat && selectedFormat !== originalFormatRef.current;
    // Build a synthetic event snapshot with the prospective format
    if (published && formatChanged) {
      const synthetic: Partial<EventData> = {
        format: selectedFormat,
        location: currentLocation,
        zoomLink: currentZoomLink,
        meetingId: currentMeetingId,
        passcode: currentPasscode,
        roles: eventData.roles, // Preserve roles for accurate validation
      } as Partial<EventData>;
      const missing = getMissingNecessaryFieldsForPublishFrontend(synthetic);
      // Only count as new missing those required by new format regardless of whether they were required previously
      setFormatWarningMissing(missing);
    } else if (formatChanged) {
      setFormatWarningMissing([]);
    } else {
      setFormatWarningMissing([]);
    }
  }, [
    eventData,
    selectedFormat,
    currentLocation,
    currentZoomLink,
    currentMeetingId,
    currentPasscode,
  ]);

  const roleValidation = useRoleValidation(
    formRoles.map((role) => ({
      ...role,
      currentSignups: role.currentSignups || [],
    })),
    templates,
    selectedEventType,
  );

  // Convert selectedOrganizers to organizerDetails format (co-organizers only)
  const organizerDetails = useMemo(() => {
    return selectedOrganizers
      .filter((organizer) => organizer.id && organizer.id.trim() !== "") // Filter out empty/invalid IDs
      .map((organizer) => ({
        name: `${organizer.firstName} ${organizer.lastName}`,
        role: organizer.roleInAtCloud || organizer.systemAuthorizationLevel,
        avatar: organizer.avatar,
        gender: organizer.gender,
        userId: organizer.id,
      }));
  }, [selectedOrganizers]);

  // Use refs to stabilize setValue/getValues access and prevent infinite re-renders
  const setValueRef = useRef(setValue);
  const getValuesRef = useRef(getValues);
  useEffect(() => {
    setValueRef.current = setValue;
    getValuesRef.current = getValues;
  }, [setValue, getValues]);

  // Note: templateApplied flag is set when a template is applied and persists
  // until the user saves. This ensures the registration deletion modal appears
  // even if the user makes manual edits after applying a template.

  // Update form's organizer field whenever organizers change
  const handleOrganizersChange = (newOrganizers: Organizer[]) => {
    setSelectedOrganizers(newOrganizers);

    // Build organizer string as: Main Organizer + co-organizers
    const createdBy =
      typeof eventData?.createdBy === "object" && eventData?.createdBy
        ? eventData.createdBy
        : undefined;
    const mainFirst = createdBy?.firstName || currentUser?.firstName || "";
    const mainLast = createdBy?.lastName || currentUser?.lastName || "";
    const mainRole =
      createdBy?.roleInAtCloud ||
      createdBy?.role ||
      currentUser?.roleInAtCloud ||
      currentUser?.role ||
      "";
    const mainLabel = `${mainFirst} ${mainLast} (${mainRole})`;

    const formattedOrganizers = [
      mainLabel,
      ...newOrganizers.map((org) => {
        const role = org.roleInAtCloud || org.systemAuthorizationLevel;
        return `${org.firstName} ${org.lastName} (${role})`;
      }),
    ]
      .filter(Boolean)
      .join(", ");

    setValue("organizer", formattedOrganizers, {
      shouldDirty: true,
      shouldValidate: false,
    });
  };

  // Submit handler for editing
  const onSubmit = async (data: EventFormData) => {
    // Require explicit choice of notification preference before submitting
    if (sendNotificationsPref === null) {
      setNotificationPrefTouched(true);
      notification.error("Please choose a notification option before saving.", {
        title: "Selection Required",
      });
      return;
    }

    try {
      const normalizedDate = normalizeEventDate(data.date);
      const checkEventTimeConflict = (
        eventService as {
          checkEventTimeConflict?: typeof eventService.checkEventTimeConflict;
        }
      ).checkEventTimeConflict;
      const conflictResult = await checkEventTimeConflict?.({
        startDate: normalizedDate,
        startTime: data.time,
        endDate: data.endDate || normalizedDate,
        endTime: data.endTime,
        excludeId: id,
        timeZone: data.timeZone,
        programLabels:
          (data as { programLabels?: string[] }).programLabels || [],
      });

      if (conflictResult?.conflict && conflictResult.conflicts.length > 0) {
        const shouldContinue = await requestTimeOverlapConfirmation(
          conflictResult.conflicts,
        );
        if (!shouldContinue) {
          return;
        }
      }
    } catch (error) {
      console.error("Unable to check event time overlaps:", error);
    }

    // Check if a template was applied (which replaces the entire role structure)
    // If so, check for registrations and show confirmation modal if needed
    // Manual edits (add/remove/reorder) are safe because:
    // - Adding roles: new roles have no registrations
    // - Removing roles: protected by disabled remove button if registrations exist
    // - Reordering: registrations stay with their roles (by role ID)
    if (templateApplied && id) {
      try {
        const response = await eventService.hasRegistrations(id);
        if (response.hasRegistrations) {
          // Show confirmation modal instead of proceeding
          setRegistrationDeletionModal({
            isOpen: true,
            registrationCount: response.totalCount,
            userCount: response.userCount,
            guestCount: response.guestCount,
            pendingFormData: data,
          });
          setIsSubmitting(false); // Reset submitting state
          return; // Stop here - modal will handle the actual submission
        }
        // No registrations - proceed normally
      } catch (error) {
        console.error("Error checking registrations:", error);
        notification.error(
          "Failed to check event registrations. Please try again.",
          { title: "Error" },
        );
        setIsSubmitting(false);
        return;
      }
    }

    try {
      setIsSubmitting(true);

      // Ensure date is properly formatted to avoid timezone issues
      const normalizedDate = normalizeEventDate(data.date);

      // Build the strongly typed update payload
      const payload: EventUpdatePayload = {
        title: data.title,
        type: data.type,
        format: data.format,
        date: normalizedDate,
        endDate: data.endDate || normalizedDate,
        time: data.time,
        endTime: data.endTime,
        timeZone: data.timeZone,
        organizer: data.organizer,
        purpose: data.purpose,
        agenda: data.agenda,
        location: data.location,
        disclaimer: data.disclaimer,
        hostedBy: data.hostedBy,
        flyerUrl: deriveFlyerUrlForUpdate(originalFlyerUrl, data.flyerUrl),
        secondaryFlyerUrl: deriveFlyerUrlForUpdate(
          originalSecondaryFlyerUrl,
          data.secondaryFlyerUrl,
        ),
        programLabels:
          (data as { programLabels?: string[] }).programLabels || [],
        roles: (data.roles || []).map(
          (r: FormRole & { startTime?: string; endTime?: string }) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            agenda: r.agenda,
            maxParticipants: Number(r.maxParticipants || 0),
            startTime: r.startTime,
            endTime: r.endTime,
            openToPublic: r.openToPublic === true,
          }),
        ),
        organizerDetails: organizerDetails || [],
      };

      // Pricing (Paid Events Feature)
      if (data.pricing) {
        payload.pricing = {
          isFree: data.pricing.isFree,
          price: data.pricing.price,
        };
      }

      // Zoom field normalization based on format
      if (
        payload.format === "Online" ||
        payload.format === "Hybrid Participation"
      ) {
        payload.zoomLink = data.zoomLink || "";
        payload.meetingId = data.meetingId || "";
        payload.passcode = data.passcode || "";
        if (payload.format === "Online") {
          payload.location = "Online"; // enforce canonical online label
        }
      } else if (payload.format === "In-person") {
        // Remove virtual fields entirely so backend can clear them
        delete (payload as { zoomLink?: string }).zoomLink;
        delete (payload as { meetingId?: string }).meetingId;
        delete (payload as { passcode?: string }).passcode;
      }

      if (sendNotificationsPref === false) {
        payload.suppressNotifications = true;
      }

      await eventService.updateEvent(id!, payload);
      notification.success("Event updated successfully!", {
        title: "Success",
        autoCloseDelay: 3000,
      });

      const state = (location.state as { returnTo?: string } | null) || null;
      const returnTo = state?.returnTo || "/dashboard/upcoming";
      navigate(returnTo);
    } catch (error) {
      console.error("Error updating event:", error);
      // Extract error message from the error object
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to update event. Please try again.";
      notification.error(errorMessage, {
        title: "Update Failed",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <LoadingSpinner size="lg" />;
  }

  if (!eventData) {
    return (
      <div className="text-center text-red-600">
        Event not found or failed to load.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Edit Event</h1>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Basic Event Fields */}
          <BasicEventFields
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
            validations={validations}
            eventData={eventData}
            currentUser={currentUser}
            programs={programs}
            programLoading={programLoading}
            selectedOrganizers={selectedOrganizers}
            onOrganizersChange={handleOrganizersChange}
            originalFlyerUrl={originalFlyerUrl}
            originalSecondaryFlyerUrl={originalSecondaryFlyerUrl}
            id={id}
            isEditMode={true}
            allowPastDates={allowPastDates}
          />

          {/* Format Settings */}
          <FormatSettings
            register={register}
            errors={errors}
            watch={watch}
            validations={validations}
            eventData={eventData}
            formatWarningMissing={formatWarningMissing}
          />

          {/* Pricing Section - Free vs Paid event selection (Phase 5) */}
          <PricingSection
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
            isEditMode={true}
          />

          {/* Role Management */}
          <RoleManagement
            selectedEventType={selectedEventType}
            formRoles={formRoles}
            setValue={setValue}
            showTemplateSelector={showTemplateSelector}
            setShowTemplateSelector={setShowTemplateSelector}
            selectedTemplateId={selectedTemplateId}
            setSelectedTemplateId={setSelectedTemplateId}
            dbTemplates={dbTemplates}
            highlightTemplateSelector={highlightTemplateSelector}
            setHighlightTemplateSelector={setHighlightTemplateSelector}
            setTemplateApplied={setTemplateApplied}
            customizeRoles={customizeRoles}
            setCustomizeRoles={setCustomizeRoles}
            highlightRoleSection={highlightRoleSection}
            setHighlightRoleSection={setHighlightRoleSection}
            roleValidation={roleValidation}
            setConfirmResetModal={setConfirmResetModal}
            notification={notification}
          />

          {/* Notification Preference */}
          <NotificationPreference
            sendNotificationsPref={sendNotificationsPref}
            setSendNotificationsPref={setSendNotificationsPref}
            setNotificationPrefTouched={setNotificationPrefTouched}
          />

          {/* Form Actions */}
          <div className="flex items-center justify-between pt-6">
            <button
              type="button"
              onClick={() => {
                const state =
                  (location.state as { returnTo?: string } | null) || null;
                const returnTo = state?.returnTo || "/dashboard/upcoming";
                navigate(returnTo);
              }}
              className="px-6 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting || sendNotificationsPref === null}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:bg-blue-400"
              aria-disabled={isSubmitting || sendNotificationsPref === null}
            >
              {isSubmitting ? "Updating..." : "Update Event"}
            </button>
          </div>
        </form>
      </div>

      <ConfirmationModal
        isOpen={timeOverlapConfirmation.isOpen}
        onClose={() => closeTimeOverlapConfirmation(false)}
        onConfirm={() => closeTimeOverlapConfirmation(true)}
        title="Confirm Time Overlap"
        message={buildTimeOverlapConfirmationMessage(
          timeOverlapConfirmation.conflicts,
        )}
        confirmText="Yes, Save Event"
        cancelText="Cancel"
        type="warning"
      />

      <EditEventModals
        eventId={id!}
        confirmResetModal={confirmResetModal}
        setConfirmResetModal={setConfirmResetModal}
        registrationDeletionModal={registrationDeletionModal}
        setRegistrationDeletionModal={setRegistrationDeletionModal}
        setIsSubmitting={setIsSubmitting}
        sendNotificationsPref={sendNotificationsPref}
        organizerDetails={organizerDetails}
        originalFlyerUrl={originalFlyerUrl}
        originalSecondaryFlyerUrl={originalSecondaryFlyerUrl}
        notification={notification}
      />
    </div>
  );
}
