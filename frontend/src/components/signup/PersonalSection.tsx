import type { UseFormRegister, FieldErrors } from "react-hook-form";
import type { SignUpFormData } from "../../schemas/signUpSchema";
import { FORM_SECTIONS, GENDER_OPTIONS } from "../../config/signUpConstants";
import { FormField, SelectField } from "../ui";
import { FormSectionWrapper } from "../forms/common";
import { BirthYearField } from "../forms/RegistrationProfileFields";

interface PersonalSectionProps {
  register: UseFormRegister<SignUpFormData>;
  errors: FieldErrors<SignUpFormData>;
}

export default function PersonalSection({
  register,
  errors,
}: PersonalSectionProps) {
  return (
    <FormSectionWrapper
      title={FORM_SECTIONS.personal.title}
      description={FORM_SECTIONS.personal.description}
    >
      {/* Name Fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField
          label="First Name"
          name="firstName"
          register={register}
          errors={errors}
          placeholder="Enter your first name"
          required={true}
        />
        <FormField
          label="Last Name"
          name="lastName"
          register={register}
          errors={errors}
          placeholder="Enter your last name"
          required={true}
        />
      </div>

      {/* Gender */}
      <SelectField
        label="Gender"
        name="gender"
        register={register}
        errors={errors}
        options={GENDER_OPTIONS}
        placeholder="Select Gender"
        required={true}
      />

      <BirthYearField register={register} errors={errors} />
    </FormSectionWrapper>
  );
}
