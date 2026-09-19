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

function RequiredIndicator() {
  return (
    <>
      <span aria-hidden="true" className="text-red-600"> *</span>
      <span className="sr-only"> (required)</span>
    </>
  );
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
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="username">
          Username{isEditing && <RequiredIndicator />}
        </label>
        <input
          {...register("username")}
          aria-describedby={errors.username ? "username-error" : undefined}
          aria-invalid={Boolean(errors.username)}
          id="username"
          type="text"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.username ? "border-red-500" : ""}`}
        />
        {errors.username && (
          <p className="mt-1 text-sm text-red-700" id="username-error" role="alert">{errors.username.message}</p>
        )}
      </div>

      {/* First Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="firstName">
          First Name{isEditing && <RequiredIndicator />}
        </label>
        <input
          {...register("firstName")}
          aria-describedby={errors.firstName ? "firstName-error" : undefined}
          aria-invalid={Boolean(errors.firstName)}
          id="firstName"
          type="text"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.firstName ? "border-red-500" : ""}`}
        />
        {errors.firstName && (
          <p className="mt-1 text-sm text-red-700" id="firstName-error" role="alert">
            {errors.firstName.message}
          </p>
        )}
      </div>

      {/* Last Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="lastName">
          Last Name{isEditing && <RequiredIndicator />}
        </label>
        <input
          {...register("lastName")}
          aria-describedby={errors.lastName ? "lastName-error" : undefined}
          aria-invalid={Boolean(errors.lastName)}
          id="lastName"
          type="text"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.lastName ? "border-red-500" : ""}`}
        />
        {errors.lastName && (
          <p className="mt-1 text-sm text-red-700" id="lastName-error" role="alert">{errors.lastName.message}</p>
        )}
      </div>

      {/* Gender */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="gender">
          Gender{isEditing && <RequiredIndicator />}
        </label>
        <select
          {...register("gender")}
          aria-describedby={errors.gender ? "gender-error" : undefined}
          aria-invalid={Boolean(errors.gender)}
          disabled={!isEditing}
          id="gender"
          required={isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 invalid:text-gray-600 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.gender ? "border-red-500" : ""}`}
        >
          <option value="" disabled className="text-gray-600">
            Select Gender
          </option>
          {GENDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {errors.gender && (
          <p className="mt-1 text-sm text-red-700" id="gender-error" role="alert">{errors.gender.message}</p>
        )}
      </div>

      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="email">
          Email{isEditing && <RequiredIndicator />}
        </label>
        <input
          {...register("email")}
          aria-describedby={errors.email ? "email-error" : undefined}
          aria-invalid={Boolean(errors.email)}
          id="email"
          type="email"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.email ? "border-red-500" : ""}`}
        />
        {errors.email && (
          <p className="mt-1 text-sm text-red-700" id="email-error" role="alert">{errors.email.message}</p>
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
          {isEditing && <RequiredIndicator />}
        </label>
        <select
          id="isAtCloudLeader"
          {...register("isAtCloudLeader")}
          aria-describedby={errors.isAtCloudLeader ? "isAtCloudLeader-error" : undefined}
          aria-invalid={Boolean(errors.isAtCloudLeader)}
          disabled={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.isAtCloudLeader ? "border-red-500" : ""}`}
        >
          {AT_CLOUD_LEADER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {errors.isAtCloudLeader && (
          <p className="mt-1 text-sm text-red-700" id="isAtCloudLeader-error" role="alert">
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
            {isEditing && <RequiredIndicator />}
          </label>
          <input
            id="roleInAtCloud"
            {...register("roleInAtCloud")}
            aria-describedby={errors.roleInAtCloud ? "roleInAtCloud-error" : undefined}
            aria-invalid={Boolean(errors.roleInAtCloud)}
            type="text"
            readOnly={!isEditing}
            className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
            } ${errors.roleInAtCloud ? "border-red-500" : ""}`}
            placeholder="e.g., Founder, CFO, Event Director, IT Director, etc."
          />
          {errors.roleInAtCloud && (
            <p className="mt-1 text-sm text-red-700" id="roleInAtCloud-error" role="alert">
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
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="weeklyChurch">
          Weekly Church
        </label>
        <input
          {...register("weeklyChurch")}
          aria-describedby={errors.weeklyChurch ? "weeklyChurch-error" : undefined}
          aria-invalid={Boolean(errors.weeklyChurch)}
          id="weeklyChurch"
          type="text"
          placeholder="Which church do you attend weekly?"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.weeklyChurch ? "border-red-500" : ""}`}
        />
        {errors.weeklyChurch && (
          <p className="mt-1 text-sm text-red-700" id="weeklyChurch-error" role="alert">
            {errors.weeklyChurch.message}
          </p>
        )}
      </div>

      {/* Church Address */}
      <div className="md:col-span-2">
        <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="churchAddress">
          Church Address
        </label>
        <textarea
          {...register("churchAddress")}
          aria-describedby={errors.churchAddress ? "churchAddress-error" : undefined}
          aria-invalid={Boolean(errors.churchAddress)}
          id="churchAddress"
          rows={3}
          placeholder="Please enter the church's full address"
          readOnly={!isEditing}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            !isEditing ? "border-gray-500 bg-gray-50 text-gray-600" : "border-gray-500"
          } ${errors.churchAddress ? "border-red-500" : ""}`}
        />
        {errors.churchAddress && (
          <p className="mt-1 text-sm text-red-700" id="churchAddress-error" role="alert">
            {errors.churchAddress.message}
          </p>
        )}
      </div>
    </div>
  );
}
