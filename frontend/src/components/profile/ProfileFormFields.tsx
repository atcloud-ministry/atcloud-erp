import type { UseFormReturn } from "react-hook-form";
import type { ProfileFormData } from "../../schemas/profileSchema";
import {
  GENDER_OPTIONS,
  AT_CLOUD_LEADER_OPTIONS,
} from "../../config/profileConstants";
import {
  BirthYearField,
  EmploymentFields,
  PhoneNumberFields,
  ResidenceFields,
} from "../forms/RegistrationProfileFields";

interface ProfileFormFieldsProps {
  form: UseFormReturn<ProfileFormData>;
  isEditing: boolean;
  originalIsAtCloudLeader?: string;
}

export default function ProfileFormFields({
  form,
  isEditing,
  originalIsAtCloudLeader,
}: ProfileFormFieldsProps) {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = form;

  // Watch the "Are you an @Cloud Co-worker?" field to conditionally show "Role in @Cloud"
  const isAtCloudLeader = watch("isAtCloudLeader");

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Username */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Username{isEditing && <span className="text-red-500"> *</span>}
        </label>
        <input
          {...register("username")}
          type="text"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.username ? "border-red-500" : ""}`}
        />
        {errors.username && (
          <p className="mt-1 text-sm text-red-600">{errors.username.message}</p>
        )}
      </div>

      {/* First Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          First Name{isEditing && <span className="text-red-500"> *</span>}
        </label>
        <input
          {...register("firstName")}
          type="text"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.firstName ? "border-red-500" : ""}`}
        />
        {errors.firstName && (
          <p className="mt-1 text-sm text-red-600">
            {errors.firstName.message}
          </p>
        )}
      </div>

      {/* Last Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Last Name{isEditing && <span className="text-red-500"> *</span>}
        </label>
        <input
          {...register("lastName")}
          type="text"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.lastName ? "border-red-500" : ""}`}
        />
        {errors.lastName && (
          <p className="mt-1 text-sm text-red-600">{errors.lastName.message}</p>
        )}
      </div>

      {/* Gender */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Gender{isEditing && <span className="text-red-500"> *</span>}
        </label>
        <select
          {...register("gender")}
          disabled={!isEditing}
          required={isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 invalid:text-gray-400 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.gender ? "border-red-500" : ""}`}
        >
          <option value="" disabled className="text-gray-400">
            Select Gender
          </option>
          {GENDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {errors.gender && (
          <p className="mt-1 text-sm text-red-600">{errors.gender.message}</p>
        )}
      </div>

      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Email{isEditing && <span className="text-red-500"> *</span>}
        </label>
        <input
          {...register("email")}
          type="email"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.email ? "border-red-500" : ""}`}
        />
        {errors.email && (
          <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
        )}
      </div>

      <div className="md:col-span-2 border-t pt-6">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">
          Contact and Personal Details
        </h3>
        <div className="space-y-4">
          <PhoneNumberFields
            register={register}
            errors={errors}
            disabled={!isEditing}
          />
          <BirthYearField
            register={register}
            errors={errors}
            disabled={!isEditing}
          />
        </div>
      </div>

      {/* Are you an @Cloud Co-worker? */}
      <div>
        <label
          htmlFor="isAtCloudLeader"
          className="block text-sm font-medium text-gray-700 mb-2"
        >
          Are you an @Cloud Co-worker?
          {isEditing && <span className="text-red-500"> *</span>}
        </label>
        <select
          id="isAtCloudLeader"
          {...register("isAtCloudLeader")}
          disabled={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.isAtCloudLeader ? "border-red-500" : ""}`}
        >
          {AT_CLOUD_LEADER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {errors.isAtCloudLeader && (
          <p className="mt-1 text-sm text-red-600">
            {errors.isAtCloudLeader.message}
          </p>
        )}
      </div>

      {/* Role in @Cloud (conditional - only show if user is an @Cloud Co-worker) */}
      {isAtCloudLeader === "Yes" && (
        <div className="md:col-span-2">
          <label
            htmlFor="roleInAtCloud"
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Role in @Cloud
            {isEditing && <span className="text-red-500"> *</span>}
          </label>
          <input
            id="roleInAtCloud"
            {...register("roleInAtCloud")}
            type="text"
            readOnly={!isEditing}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
            } ${errors.roleInAtCloud ? "border-red-500" : ""}`}
            placeholder="e.g., Founder, CFO, Event Director, IT Director, etc."
          />
          {errors.roleInAtCloud && (
            <p className="mt-1 text-sm text-red-600">
              {errors.roleInAtCloud.message}
            </p>
          )}
          {/* Show notification if user is changing from "No" to "Yes" */}
          {isEditing &&
            originalIsAtCloudLeader === "No" &&
            isAtCloudLeader === "Yes" && (
              <p className="mt-2 text-sm text-blue-600">
                Note: The Admin will receive an email notification about your
                @Cloud Co-worker request.
              </p>
            )}
        </div>
      )}

      <div className="md:col-span-2 border-t pt-6">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">
          Residence
        </h3>
        <ResidenceFields
          register={register}
          errors={errors}
          watch={watch}
          setValue={setValue}
          disabled={!isEditing}
        />
      </div>

      <div className="md:col-span-2 border-t pt-6">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">
          Employment
        </h3>
        <EmploymentFields
          register={register}
          errors={errors}
          watch={watch}
          setValue={setValue}
          disabled={!isEditing}
        />
      </div>

      {/* Weekly Church */}
      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Weekly Church
        </label>
        <input
          {...register("weeklyChurch")}
          type="text"
          placeholder="Which church do you attend weekly?"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.weeklyChurch ? "border-red-500" : ""}`}
        />
        {errors.weeklyChurch && (
          <p className="mt-1 text-sm text-red-600">
            {errors.weeklyChurch.message}
          </p>
        )}
      </div>

      {/* Church Address */}
      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Church Address
        </label>
        <textarea
          {...register("churchAddress")}
          rows={3}
          placeholder="Please enter the church's full address"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "bg-gray-50 text-gray-500" : "border-gray-300"
          } ${errors.churchAddress ? "border-red-500" : ""}`}
        />
        {errors.churchAddress && (
          <p className="mt-1 text-sm text-red-600">
            {errors.churchAddress.message}
          </p>
        )}
      </div>
    </div>
  );
}
