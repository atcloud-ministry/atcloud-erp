import type {
  UseFormRegister,
  UseFormWatch,
  UseFormSetValue,
  FieldErrors,
} from "react-hook-form";
import { COMMON_TIMEZONES } from "../../data/timeZones";
import { EVENT_TYPES } from "../../config/eventConstants";
import OrganizerSelection, {
  type Organizer,
} from "../events/OrganizerSelection";
import ProgramSelection from "../events/ProgramSelection";
import ValidationIndicator from "../events/ValidationIndicator";
import type { EventFormData } from "../../schemas/eventSchema";
import type { EventData } from "../../types/event";
import type { FieldValidation } from "../../utils/eventValidationUtils";
import {
  handleDateInputChange,
  getTodayDateString,
} from "../../utils/eventStatsUtils";
import { fileService } from "../../services/api";
import { useToastReplacement } from "../../contexts/NotificationModalContext";

interface User {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  roleInAtCloud?: string;
  gender?: "male" | "female";
  avatar?: string | null;
  email: string;
  phone?: string;
}

interface ValidationStates {
  title: FieldValidation;
  type: FieldValidation;
  date: FieldValidation;
  time: FieldValidation;
  endDate: FieldValidation;
  endTime: FieldValidation;
  agenda: FieldValidation;
  format: FieldValidation;
  location: FieldValidation;
  zoomLink: FieldValidation;
  startOverlap?: FieldValidation;
  endOverlap?: FieldValidation;
  occurrenceCount?: FieldValidation;
}

interface BasicEventFieldsProps {
  register: UseFormRegister<EventFormData>;
  errors: FieldErrors<EventFormData>;
  watch: UseFormWatch<EventFormData>;
  setValue: UseFormSetValue<EventFormData>;
  validations: ValidationStates;
  eventData?: EventData; // Optional for CreateEvent mode
  currentUser: User | null;
  programs: Array<{ id: string; title: string; programType: string }>;
  programLoading: boolean;
  selectedOrganizers: Organizer[];
  onOrganizersChange: (organizers: Organizer[]) => void;
  originalFlyerUrl: string | null;
  originalSecondaryFlyerUrl: string | null;
  id?: string; // For time conflict check
  allowedEventTypes?: string[]; // Optional: filtered event types for CreateEvent
  allowPastDates?: boolean;
  // Recurrence props
  isEditMode?: boolean; // When true, Repeat is locked to "Never"
  repeatFrequency?: string;
  onRepeatFrequencyChange?: (value: string) => void;
  occurrenceCount?: string;
  onOccurrenceCountChange?: (value: string) => void;
  recurrenceMode?: string;
  onRecurrenceModeChange?: (value: string) => void;
  weekdayOrdinal?: string;
  onWeekdayOrdinalChange?: (value: string) => void;
  weekday?: string;
  onWeekdayChange?: (value: string) => void;
}

/**
 * BasicEventFields Component
 *
 * Renders the basic event form fields for EditEvent:
 * - Title, Type, TimeZone
 * - Program Selection
 * - Date/Time grid (4 fields with time conflict validation)
 * - Hosted By (disabled)
 * - Organizer Selection
 * - Purpose (optional)
 * - Event Flyers (primary + secondary with upload/remove)
 * - Agenda
 */
export default function BasicEventFields({
  register,
  errors,
  watch,
  setValue,
  validations,
  eventData,
  currentUser,
  programs,
  programLoading,
  selectedOrganizers,
  onOrganizersChange,
  originalFlyerUrl,
  originalSecondaryFlyerUrl,
  id,
  allowedEventTypes, // Filtered event types for CreateEvent
  allowPastDates = false,
  isEditMode,
  repeatFrequency,
  onRepeatFrequencyChange,
  occurrenceCount,
  onOccurrenceCountChange,
  recurrenceMode,
  onRecurrenceModeChange,
  weekdayOrdinal,
  onWeekdayOrdinalChange,
  weekday,
  onWeekdayChange,
}: BasicEventFieldsProps) {
  const notification = useToastReplacement();

  return (
    <>
      {/* Title */}
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Event Title <span className="text-red-500">*</span>
        </label>
        <input
          id="title"
          {...register("title")}
          type="text"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Enter event title"
        />
        <ValidationIndicator validation={validations.title} />
        {errors.title && (
          <p className="mt-1 text-sm text-red-600">{errors.title.message}</p>
        )}
      </div>

      {/* Program Labels (optional) - Modal-based selection */}
      <ProgramSelection
        programs={programs}
        selectedProgramIds={
          (watch("programLabels") as string[] | undefined) || []
        }
        onProgramsChange={(programIds) => {
          setValue("programLabels", programIds, {
            shouldDirty: true,
            shouldValidate: true,
          });
        }}
        loading={programLoading}
      />

      {/* Event Type - Dropdown selection */}
      <div>
        <label
          htmlFor="type"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Event Type <span className="text-red-500">*</span>
        </label>
        <select
          id="type"
          {...register("type")}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select event type</option>
          {allowedEventTypes
            ? allowedEventTypes.map((typeName) => (
                <option key={typeName} value={typeName}>
                  {typeName}
                </option>
              ))
            : EVENT_TYPES.map((eventType) => (
                <option key={eventType.id} value={eventType.name}>
                  {eventType.name}
                </option>
              ))}
        </select>
        <ValidationIndicator validation={validations.type} />
        {errors.type && (
          <p className="mt-1 text-sm text-red-600">{errors.type.message}</p>
        )}
      </div>

      {/* Time Zone (full-width row) */}
      <div>
        <label
          htmlFor="timeZone"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Time Zone <span className="text-red-500">*</span>
        </label>
        <select
          id="timeZone"
          {...register("timeZone")}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 max-h-48 overflow-y-auto"
        >
          {COMMON_TIMEZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          Times are stored in this time zone and displayed in viewers' local
          time.
        </p>
      </div>

      {/* Dates and Times (responsive grid) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Start Date */}
        <div>
          <label
            htmlFor="date"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Start Date <span className="text-red-500">*</span>
          </label>
          <input
            id="date"
            {...register("date", {
              onChange: (e) => {
                const normalizedDate = handleDateInputChange(e.target.value);
                setValue("date", normalizedDate, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              },
            })}
            type="date"
            min={allowPastDates ? undefined : getTodayDateString()}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <ValidationIndicator validation={validations.date} />
          {errors.date && (
            <p className="mt-1 text-sm text-red-600">{errors.date.message}</p>
          )}
        </div>

        {/* Start Time */}
        <div>
          <label
            htmlFor="time"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Start Time <span className="text-red-500">*</span>
          </label>
          <input
            id="time"
            {...register("time")}
            type="time"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <ValidationIndicator validation={validations.time} />
          <ValidationIndicator validation={validations.startOverlap!} />
          {errors.time && (
            <p className="mt-1 text-sm text-red-600">{errors.time.message}</p>
          )}
        </div>

        {/* End Date */}
        <div>
          <label
            htmlFor="endDate"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            End Date <span className="text-red-500">*</span>
          </label>
          <input
            id="endDate"
            {...register("endDate", {
              onChange: (e) => {
                const normalizedDate = handleDateInputChange(e.target.value);
                setValue("endDate", normalizedDate, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              },
            })}
            type="date"
            min={allowPastDates ? undefined : getTodayDateString()}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <ValidationIndicator validation={validations.endDate} />
          {errors.endDate && (
            <p className="mt-1 text-sm text-red-600">
              {errors.endDate.message}
            </p>
          )}
        </div>

        {/* End Time */}
        <div>
          <label
            htmlFor="endTime"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            End Time <span className="text-red-500">*</span>
          </label>
          <input
            id="endTime"
            {...register("endTime")}
            type="time"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <ValidationIndicator validation={validations.endTime} />
          <ValidationIndicator validation={validations.endOverlap!} />
          {errors.endTime && (
            <p className="mt-1 text-sm text-red-600">
              {errors.endTime.message}
            </p>
          )}
        </div>
      </div>

      {/* Repeat / Recurrence */}
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Repeat Frequency */}
          <div>
            <label
              htmlFor="repeatFrequency"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Repeat
            </label>
            <select
              id="repeatFrequency"
              value={isEditMode ? "never" : repeatFrequency || "never"}
              onChange={(e) => onRepeatFrequencyChange?.(e.target.value)}
              disabled={isEditMode}
              className={`w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                isEditMode ? "bg-gray-100 text-gray-400 cursor-not-allowed" : ""
              }`}
            >
              <option value="never">Never</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
              <option value="every-two-months">Every 2 Months</option>
              <option value="every-three-months">Every 3 Months</option>
            </select>
          </div>
        </div>

        {/* Occurrence Count — for weekly/biweekly */}
        {!isEditMode &&
          (repeatFrequency === "weekly" || repeatFrequency === "biweekly") && (
            <div>
              <label
                htmlFor="occurrenceCount"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                How many times should this event recur, including the first
                occurrence? <span className="text-red-500">*</span>
              </label>
              <select
                id="occurrenceCount"
                value={occurrenceCount || ""}
                onChange={(e) => onOccurrenceCountChange?.(e.target.value)}
                className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  !occurrenceCount ? "border-red-300" : "border-gray-300"
                }`}
              >
                <option value="" disabled>
                  Select count
                </option>
                {Array.from({ length: 23 }, (_, i) => i + 2).map((num) => (
                  <option key={num} value={num}>
                    {num}
                  </option>
                ))}
              </select>
              {validations.occurrenceCount && (
                <ValidationIndicator validation={validations.occurrenceCount} />
              )}
            </div>
          )}

        {/* Monthly-type sub-fields */}
        {!isEditMode &&
          (repeatFrequency === "monthly" ||
            repeatFrequency === "every-two-months" ||
            repeatFrequency === "every-three-months") && (
            <div className="space-y-4">
              {/* Occurrence Count — for monthly-type (own row) */}
              <div>
                <label
                  htmlFor="occurrenceCountMonthly"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  How many times should this event recur, including the first
                  occurrence? <span className="text-red-500">*</span>
                </label>
                <select
                  id="occurrenceCountMonthly"
                  value={occurrenceCount || ""}
                  onChange={(e) => onOccurrenceCountChange?.(e.target.value)}
                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    !occurrenceCount ? "border-red-300" : "border-gray-300"
                  }`}
                >
                  <option value="" disabled>
                    Select count
                  </option>
                  {Array.from({ length: 23 }, (_, i) => i + 2).map((num) => (
                    <option key={num} value={num}>
                      {num}
                    </option>
                  ))}
                </select>
                {validations.occurrenceCount && (
                  <ValidationIndicator
                    validation={validations.occurrenceCount}
                  />
                )}
              </div>

              {/* Recurrence Mode */}
              <div>
                <label
                  htmlFor="recurrenceMode"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  How will this event recur?
                </label>
                <select
                  id="recurrenceMode"
                  value={recurrenceMode || "same-date"}
                  onChange={(e) => onRecurrenceModeChange?.(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="same-date">On the same date</option>
                  <option value="same-weekday">On the same weekday</option>
                </select>
              </div>

              {/* Same-weekday sub-options */}
              {recurrenceMode === "same-weekday" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label
                      htmlFor="weekdayOrdinal"
                      className="block text-sm font-medium text-gray-700 mb-2"
                    >
                      On every
                    </label>
                    <select
                      id="weekdayOrdinal"
                      value={weekdayOrdinal || ""}
                      onChange={(e) => onWeekdayOrdinalChange?.(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="" disabled>
                        Select ordinal
                      </option>
                      <option value="1">1st</option>
                      <option value="2">2nd</option>
                      <option value="3">3rd</option>
                      <option value="4">4th</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="weekday"
                      className="block text-sm font-medium text-gray-700 mb-2"
                    >
                      Day of the week
                    </label>
                    <select
                      id="weekday"
                      value={weekday || ""}
                      onChange={(e) => onWeekdayChange?.(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="" disabled>
                        Select day
                      </option>
                      <option value="1">Monday</option>
                      <option value="2">Tuesday</option>
                      <option value="3">Wednesday</option>
                      <option value="4">Thursday</option>
                      <option value="5">Friday</option>
                      <option value="6">Saturday</option>
                      <option value="0">Sunday</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}
      </div>

      {/* Hosted by */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Hosted by
        </label>
        <input
          {...register("hostedBy")}
          type="text"
          value="@Cloud Marketplace Ministry"
          disabled
          className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-600 cursor-not-allowed"
        />
        <p className="mt-1 text-sm text-gray-500">
          This field cannot be changed
        </p>
      </div>

      {/* Organizers */}
      {currentUser && (
        <OrganizerSelection
          mainOrganizer={{
            id:
              (eventData && typeof eventData.createdBy === "object"
                ? eventData.createdBy?.id
                : undefined) || currentUser.id,
            firstName:
              (eventData && typeof eventData.createdBy === "object"
                ? eventData.createdBy?.firstName
                : undefined) || currentUser.firstName,
            lastName:
              (eventData && typeof eventData.createdBy === "object"
                ? eventData.createdBy?.lastName
                : undefined) || currentUser.lastName,
            systemAuthorizationLevel:
              (eventData && typeof eventData.createdBy === "object"
                ? eventData.createdBy?.role
                : undefined) || currentUser.role,
            roleInAtCloud:
              (eventData && typeof eventData.createdBy === "object"
                ? eventData.createdBy?.roleInAtCloud
                : undefined) || currentUser.roleInAtCloud,
            gender: ((eventData && typeof eventData.createdBy === "object"
              ? eventData.createdBy?.gender
              : undefined) ||
              currentUser.gender ||
              "male") as "male" | "female",
            avatar:
              (eventData && typeof eventData.createdBy === "object"
                ? (eventData.createdBy?.avatar as string | null | undefined)
                : undefined) ||
              currentUser.avatar ||
              null,
          }}
          currentUserId={currentUser.id}
          selectedOrganizers={selectedOrganizers}
          onOrganizersChange={onOrganizersChange}
          context="event-organizer"
          resourceId={id}
        />
      )}

      {/* Purpose (optional) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Purpose
        </label>
        <p className="text-xs text-blue-600 mb-2">
          Suggested: Appears as a bold tagline / intro paragraph on the public
          event page once published. Keep it concise and compelling.
        </p>
        <textarea
          {...register("purpose")}
          rows={3}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Describe the purpose of this event (optional)"
        />
        {/* Purpose is optional; no validation error UI needed */}
      </div>

      {/* Event Flyer (optional) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Event Flyer
        </label>
        <div className="flex items-center gap-3">
          <input
            type="url"
            {...register("flyerUrl")}
            placeholder="Click 📎 to upload an image flyer"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <label
            className="px-3 py-2 border rounded-md cursor-pointer hover:bg-gray-50"
            title="Upload image"
          >
            📎
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const inputEl = e.currentTarget;
                const file = inputEl.files?.[0];
                if (!file) return;
                try {
                  const { url } = await fileService.uploadGenericImage(file);
                  setValue("flyerUrl", url, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                } catch (err) {
                  console.error("Flyer upload failed", err);
                  notification.error("Failed to upload image", {
                    title: "Upload Error",
                  });
                } finally {
                  inputEl.value = "";
                }
              }}
            />
          </label>
          {(watch("flyerUrl") || originalFlyerUrl) && (
            <button
              type="button"
              className="px-3 py-2 border rounded-md text-red-600 hover:bg-red-50"
              title="Remove current flyer"
              onClick={() => {
                // Clear the field value; if original had a flyer this will trigger sending '' on submit.
                setValue("flyerUrl", "", {
                  shouldDirty: true,
                  shouldValidate: false,
                });
              }}
            >
              Remove
            </button>
          )}
        </div>
        {watch("flyerUrl") && (
          <div className="mt-3">
            <img
              src={watch("flyerUrl")}
              alt="Event flyer preview"
              className="w-full max-w-2xl h-auto rounded border border-gray-200 object-contain"
            />
          </div>
        )}
      </div>

      {/* Secondary Event Flyer (optional) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Secondary Event Flyer (Optional)
        </label>
        <div className="flex items-center gap-3">
          <input
            type="url"
            {...register("secondaryFlyerUrl")}
            placeholder="Click 📎 to upload an image flyer"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <label
            className="px-3 py-2 border rounded-md cursor-pointer hover:bg-gray-50"
            title="Upload image"
          >
            📎
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const inputEl = e.currentTarget;
                const file = inputEl.files?.[0];
                if (!file) return;
                try {
                  const { url } = await fileService.uploadGenericImage(file);
                  setValue("secondaryFlyerUrl", url, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                } catch (err) {
                  console.error("Secondary flyer upload failed", err);
                  notification.error("Failed to upload image", {
                    title: "Upload Error",
                  });
                } finally {
                  inputEl.value = "";
                }
              }}
            />
          </label>
          {(watch("secondaryFlyerUrl") || originalSecondaryFlyerUrl) && (
            <button
              type="button"
              className="px-3 py-2 border rounded-md text-red-600 hover:bg-red-50"
              title="Remove current secondary flyer"
              onClick={() => {
                // Clear the field value; if original had a flyer this will trigger sending '' on submit.
                setValue("secondaryFlyerUrl", "", {
                  shouldDirty: true,
                  shouldValidate: false,
                });
              }}
            >
              Remove
            </button>
          )}
        </div>
        {watch("secondaryFlyerUrl") && (
          <div className="mt-3">
            <img
              src={watch("secondaryFlyerUrl")}
              alt="Secondary event flyer preview"
              className="w-full max-w-2xl h-auto rounded border border-gray-200 object-contain"
            />
          </div>
        )}
      </div>

      {/* Event Agenda and Schedule */}
      <div>
        <label
          htmlFor="agenda"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Event Agenda and Schedule <span className="text-red-500">*</span>
        </label>
        <textarea
          id="agenda"
          {...register("agenda")}
          rows={5}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Provide a detailed agenda and schedule for the event (e.g., 9:00 AM - Registration, 9:30 AM - Opening Session, etc.)"
        />
        <ValidationIndicator validation={validations.agenda} />
        {errors.agenda && (
          <p className="mt-1 text-sm text-red-600">{errors.agenda.message}</p>
        )}
      </div>
    </>
  );
}
