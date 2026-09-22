import { useEffect, useMemo, useRef } from "react";
import type {
  FieldErrors,
  FieldValues,
  Path,
  PathValue,
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { getCurrentUtcYear, MIN_BIRTH_YEAR } from "@atcloud/shared-time/registration-profile";
import {
  COUNTRY_SELECT_OPTIONS,
  EMPLOYMENT_STATUS_OPTIONS,
  PHONE_COUNTRY_SELECT_OPTIONS,
  employmentStatusRequiresCompany,
  getSubdivisionOptions,
} from "../../utils/registrationProfile";
import { FormField, SelectField } from "../ui";

interface FormProps<TFormValues extends FieldValues> {
  register: UseFormRegister<TFormValues>;
  errors: FieldErrors<TFormValues>;
  disabled?: boolean;
}

interface ConditionalFormProps<TFormValues extends FieldValues>
  extends FormProps<TFormValues> {
  watch: UseFormWatch<TFormValues>;
  setValue: UseFormSetValue<TFormValues>;
}

function setFormValue<TFormValues extends FieldValues>(
  setValue: UseFormSetValue<TFormValues>,
  name: string,
  value: string,
) {
  const path = name as Path<TFormValues>;
  setValue(path, value as PathValue<TFormValues, typeof path>, {
    shouldDirty: true,
    shouldValidate: true,
  });
}

function watchedString<TFormValues extends FieldValues>(
  watch: UseFormWatch<TFormValues>,
  name: string,
): string {
  const value = watch(name as Path<TFormValues>);
  return typeof value === "string" ? value : "";
}

export function BirthYearField<TFormValues extends FieldValues>({
  register,
  errors,
  disabled = false,
}: FormProps<TFormValues>) {
  return (
    <FormField
      label="Birth Year"
      name="birthYear"
      register={register}
      errors={errors}
      type="number"
      placeholder="YYYY"
      required
      disabled={disabled}
      helperText={`Private. Enter a year from ${MIN_BIRTH_YEAR} to ${getCurrentUtcYear()}.`}
    />
  );
}

export function PhoneNumberFields<TFormValues extends FieldValues>({
  register,
  errors,
  disabled = false,
}: FormProps<TFormValues>) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <SelectField
        label="Phone Country"
        name="phoneCountryCode"
        register={register}
        errors={errors}
        options={PHONE_COUNTRY_SELECT_OPTIONS}
        placeholder="Select phone country"
        required
        disabled={disabled}
        helperText="Select where your number is from. This does not set your residence."
      />
      <FormField
        label="Phone"
        name="phone"
        register={register}
        errors={errors}
        type="tel"
        placeholder="Enter your phone number (e.g. 510 258 1542)"
        required
        disabled={disabled}
        helperText="Private. Enter a national number for the selected country, or start with + for a full international number. Saved in international format."
      />
    </div>
  );
}

export function ResidenceFields<TFormValues extends FieldValues>({
  register,
  errors,
  watch,
  setValue,
  disabled = false,
}: ConditionalFormProps<TFormValues>) {
  const countryCode = watchedString(watch, "residenceCountryCode");
  const regionCode = watchedString(watch, "residenceRegion");
  const regionOptions = useMemo(
    () => getSubdivisionOptions(countryCode),
    [countryCode],
  );
  const previousCountryCode = useRef(countryCode);

  useEffect(() => {
    const countryChanged = previousCountryCode.current !== countryCode;
    previousCountryCode.current = countryCode;

    if (
      !disabled &&
      countryChanged &&
      regionCode &&
      !regionOptions.some((option) => option.value === regionCode)
    ) {
      setFormValue(setValue, "residenceRegion", "");
    }
  }, [countryCode, disabled, regionCode, regionOptions, setValue]);

  return (
    <div className="space-y-4">
      <SelectField
        label="Country of Residence"
        name="residenceCountryCode"
        register={register}
        errors={errors}
        options={COUNTRY_SELECT_OPTIONS}
        placeholder="Select country"
        required
        disabled={disabled}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {countryCode && regionOptions.length > 0 ? (
          <SelectField
            label={countryCode === "US" ? "State" : "State / Province / Region"}
            name="residenceRegion"
            register={register}
            errors={errors}
            options={regionOptions}
            placeholder="Select region"
            required={countryCode === "US"}
            disabled={disabled}
          />
        ) : (
          <input type="hidden" {...register("residenceRegion" as Path<TFormValues>)} />
        )}
        <FormField
          label="City"
          name="residenceCity"
          register={register}
          errors={errors}
          placeholder="Enter city"
          required
          disabled={disabled}
          className={countryCode && regionOptions.length > 0 ? "" : "md:col-span-2"}
        />
      </div>
    </div>
  );
}

export function EmploymentFields<TFormValues extends FieldValues>({
  register,
  errors,
  watch,
  setValue,
  disabled = false,
}: ConditionalFormProps<TFormValues>) {
  const employmentStatus = watchedString(watch, "employmentStatus");
  const company = watchedString(watch, "company");
  const requiresCompany = employmentStatusRequiresCompany(employmentStatus);
  const previousEmploymentStatus = useRef(employmentStatus);

  useEffect(() => {
    const employmentStatusChanged =
      previousEmploymentStatus.current !== employmentStatus;
    previousEmploymentStatus.current = employmentStatus;

    if (
      !disabled &&
      employmentStatusChanged &&
      employmentStatus &&
      !requiresCompany &&
      company
    ) {
      setFormValue(setValue, "company", "");
    }
  }, [company, disabled, employmentStatus, requiresCompany, setValue]);

  return (
    <div className="space-y-4">
      <SelectField
        label="Employment Status"
        name="employmentStatus"
        register={register}
        errors={errors}
        options={EMPLOYMENT_STATUS_OPTIONS}
        placeholder="Select employment status"
        required
        disabled={disabled}
      />

      {requiresCompany && (
        <FormField
          label="Company or Organization"
          name="company"
          register={register}
          errors={errors}
          placeholder="Enter company or organization"
          required
          disabled={disabled}
        />
      )}

      <FormField
        label="Occupation"
        name="occupation"
        register={register}
        errors={errors}
        placeholder="e.g. Product Manager, Engineer, Student"
        disabled={disabled}
      />
    </div>
  );
}
