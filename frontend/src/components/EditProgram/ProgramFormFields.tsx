import type {
  UseFormRegister,
  UseFormWatch,
  UseFormSetValue,
  FieldErrors,
} from "react-hook-form";
import OrganizerSelection, {
  type Organizer,
} from "../events/OrganizerSelection";
import ValidationIndicator from "../events/ValidationIndicator";
import { fileService } from "../../services/api";
import { getProgramTypes } from "../../constants/programTypes";
import type { ProgramStudentRoleForm } from "../../types/program";
import { DEFAULT_TEACHER_ROLE_NAME } from "../../utils/programRoles";

type Mentor = Organizer;

interface User {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  roleInAtCloud?: string;
  gender: "male" | "female";
  avatar?: string | null;
  email: string;
  phone?: string;
}

interface ProgramFormData {
  programType: string;
  title: string;
  startYear: string;
  startMonth: string;
  endYear: string;
  endMonth: string;
  hostedBy: string;
  introduction: string;
  flyerUrl?: string;
  flyer?: FileList;
  zoomLink?: string;
  meetingId?: string;
  passcode?: string;
  teacherRoleName?: string;
  studentRoles?: ProgramStudentRoleForm[];
  isFree?: string;
  earlyBirdDeadline?: string;
  fullPriceTicket: number | undefined;
  classRepDiscount?: number | undefined;
  earlyBirdDiscount?: number | undefined;
  classRepLimit?: number | undefined;
}

interface Validation {
  isValid: boolean;
  message: string;
  color: string;
}

interface ProgramFormFieldsProps {
  register: UseFormRegister<ProgramFormData>;
  watch: UseFormWatch<ProgramFormData>;
  setValue: UseFormSetValue<ProgramFormData>;
  errors: FieldErrors<ProgramFormData>;
  validations: {
    programType: Validation;
    title: Validation;
    startYear: Validation;
    startMonth: Validation;
    endYear: Validation;
    endMonth: Validation;
    introduction: Validation;
  };
  currentUser: User | null;
  mentors: Mentor[];
  onMentorsChange: (mentors: Mentor[]) => void;
  originalFlyerUrl: string | null;
  YEARS: string[];
  MONTHS: string[];
  programId?: string;
}

const PROGRAM_TYPES = getProgramTypes();

export default function ProgramFormFields({
  register,
  watch,
  setValue,
  errors,
  validations,
  currentUser,
  mentors,
  onMentorsChange,
  originalFlyerUrl,
  YEARS,
  MONTHS,
  programId,
}: ProgramFormFieldsProps) {
  const teacherRoleName =
    watch("teacherRoleName")?.trim() || DEFAULT_TEACHER_ROLE_NAME;

  return (
    <>
      {/* Program Type */}
      <div>
        <label
          htmlFor="programType"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Program Type <span className="text-red-500">*</span>
        </label>
        <select
          id="programType"
          {...register("programType", {
            required: "Program type is required",
          })}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="" disabled>
            -- Select Program Type --
          </option>
          {PROGRAM_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        {errors.programType && (
          <p className="mt-1 text-sm text-red-600">
            {errors.programType.message}
          </p>
        )}
        <ValidationIndicator validation={validations.programType} />
      </div>

      {/* Title */}
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Program Title <span className="text-red-500">*</span>
        </label>
        <input
          id="title"
          {...register("title", { required: "Program title is required" })}
          type="text"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Enter program title"
        />
        {errors.title && (
          <p className="mt-1 text-sm text-red-600">{errors.title.message}</p>
        )}
        <ValidationIndicator validation={validations.title} />
      </div>

      {/* Start Year and Month */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-6">
        <div>
          <label
            htmlFor="startYear"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Start Year <span className="text-red-500">*</span>
          </label>
          <select
            id="startYear"
            {...register("startYear", {
              required: "Start year is required",
            })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select year</option>
            {YEARS.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
          {errors.startYear && (
            <p className="mt-1 text-sm text-red-600">
              {errors.startYear.message}
            </p>
          )}
          <ValidationIndicator validation={validations.startYear} />
        </div>

        <div>
          <label
            htmlFor="startMonth"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Start Month <span className="text-red-500">*</span>
          </label>
          <select
            id="startMonth"
            {...register("startMonth", {
              required: "Start month is required",
            })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select month</option>
            {MONTHS.map((month) => (
              <option key={month} value={month}>
                {month}
              </option>
            ))}
          </select>
          {errors.startMonth && (
            <p className="mt-1 text-sm text-red-600">
              {errors.startMonth.message}
            </p>
          )}
          <ValidationIndicator validation={validations.startMonth} />
        </div>

        <div>
          <label
            htmlFor="endYear"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            End Year <span className="text-red-500">*</span>
          </label>
          <select
            id="endYear"
            {...register("endYear", { required: "End year is required" })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select year</option>
            {YEARS.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
          {errors.endYear && (
            <p className="mt-1 text-sm text-red-600">
              {errors.endYear.message}
            </p>
          )}
          <ValidationIndicator validation={validations.endYear} />
        </div>

        <div>
          <label
            htmlFor="endMonth"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            End Month <span className="text-red-500">*</span>
          </label>
          <select
            id="endMonth"
            {...register("endMonth", { required: "End month is required" })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select month</option>
            {MONTHS.map((month) => (
              <option key={month} value={month}>
                {month}
              </option>
            ))}
          </select>
          {errors.endMonth && (
            <p className="mt-1 text-sm text-red-600">
              {errors.endMonth.message}
            </p>
          )}
          <ValidationIndicator validation={validations.endMonth} />
        </div>
      </div>

      {/* Hosted By */}
      <div>
        <label
          htmlFor="hostedBy"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Hosted By
        </label>
        <input
          id="hostedBy"
          {...register("hostedBy")}
          type="text"
          className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 cursor-not-allowed"
          readOnly
        />
        <p className="mt-1 text-sm text-gray-500">
          This field cannot be changed
        </p>
      </div>

      {/* Program Zoom Information */}
      <div className="space-y-4 border border-gray-200 rounded-lg p-4 bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-900">
          Zoom Information
        </h2>
        <div>
          <label
            htmlFor="zoomLink"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Link
          </label>
          <input
            id="zoomLink"
            {...register("zoomLink")}
            type="url"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter Zoom meeting link"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="meetingId"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Meeting ID
            </label>
            <input
              id="meetingId"
              {...register("meetingId")}
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter meeting ID"
            />
          </div>
          <div>
            <label
              htmlFor="passcode"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Passcode
            </label>
            <input
              id="passcode"
              {...register("passcode")}
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter passcode"
            />
          </div>
        </div>
      </div>

      {/* Program Role Names */}
      <div>
        <label
          htmlFor="teacherRoleName"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Teacher Role Name <span className="text-red-500">*</span>
        </label>
        <input
          id="teacherRoleName"
          {...register("teacherRoleName", {
            required: "Teacher role name is required",
          })}
          type="text"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Mentor"
        />
        {errors.teacherRoleName && (
          <p className="mt-1 text-sm text-red-600">
            {errors.teacherRoleName.message}
          </p>
        )}
      </div>

      {/* Mentors Field - Shown for ALL program types */}
      {currentUser && (
        <div className="space-y-4">
          <OrganizerSelection
            mainOrganizer={{
              id: currentUser.id,
              firstName: currentUser.firstName,
              lastName: currentUser.lastName,
              systemAuthorizationLevel: currentUser.role,
              roleInAtCloud: currentUser.roleInAtCloud,
              gender: currentUser.gender,
              avatar: currentUser.avatar || null,
            }}
            currentUserId={currentUser.id}
            selectedOrganizers={mentors}
            onOrganizersChange={onMentorsChange}
            hideMainOrganizer={true}
            excludeMainOrganizer={false}
            organizersLabel={`${teacherRoleName}s`}
            buttonText={`Add ${teacherRoleName}`}
            context="program-mentor"
            resourceId={programId}
          />
        </div>
      )}

      {/* Program Introduction */}
      <div>
        <label
          htmlFor="introduction"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Program Introduction <span className="text-red-500">*</span>
        </label>
        <textarea
          id="introduction"
          {...register("introduction", {
            required: "Program introduction is required",
          })}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Provide a detailed introduction to the program..."
        />
        {errors.introduction && (
          <p className="mt-1 text-sm text-red-600">
            {errors.introduction.message}
          </p>
        )}
        <ValidationIndicator validation={validations.introduction} />
      </div>

      {/* Program Flyer (optional) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Program Flyer
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
                  alert("Failed to upload image");
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
              alt="Program flyer preview"
              className="w-full max-w-2xl h-auto rounded border border-gray-200 object-contain"
            />
          </div>
        )}
      </div>
    </>
  );
}
