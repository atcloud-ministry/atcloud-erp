import type {
  UseFormRegister,
  FieldErrors,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import type { SignUpFormData } from "../../schemas/signUpSchema";
import { FORM_SECTIONS } from "../../config/signUpConstants";
import { FormSectionWrapper } from "../forms/common";
import {
  PhoneNumberFields,
  ResidenceFields,
} from "../forms/RegistrationProfileFields";

interface ContactSectionProps {
  register: UseFormRegister<SignUpFormData>;
  errors: FieldErrors<SignUpFormData>;
  watch: UseFormWatch<SignUpFormData>;
  setValue: UseFormSetValue<SignUpFormData>;
}

export default function ContactSection({
  register,
  errors,
  watch,
  setValue,
}: ContactSectionProps) {
  return (
    <FormSectionWrapper
      title={FORM_SECTIONS.contact.title}
      description={FORM_SECTIONS.contact.description}
    >
      <PhoneNumberFields register={register} errors={errors} />
      <ResidenceFields
        register={register}
        errors={errors}
        watch={watch}
        setValue={setValue}
      />
    </FormSectionWrapper>
  );
}
