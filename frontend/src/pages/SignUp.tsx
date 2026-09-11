import { useSignUpForm } from "../hooks/useSignUpForm";
import {
  SignUpHeader,
  SignUpFormWrapper,
  LeaderQuestionSection,
} from "../components/signup";
import AccountSection from "../components/signup/AccountSection";
import PersonalSection from "../components/signup/PersonalSection";
import ContactSection from "../components/signup/ContactSection";
import OptionalSection from "../components/signup/OptionalSection";

export default function SignUp() {
  const {
    // Form state
    register,
    errors,
    watch,
    setValue,
    isSubmitting,

    // Watched values
    username,
    password,
    isAtCloudLeader,

    // Actions
    onSubmit,
  } = useSignUpForm();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl w-full space-y-8">
        <SignUpHeader />

        <SignUpFormWrapper onSubmit={onSubmit} isSubmitting={isSubmitting}>
          {/* Account Information Section */}
          <AccountSection
            register={register}
            errors={errors}
            username={username}
            password={password}
          />

          {/* Personal Information Section */}
          <PersonalSection register={register} errors={errors} />

          {/* Contact Information Section */}
          <ContactSection
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
          />

          {/* @Cloud Co-worker Question */}
          <LeaderQuestionSection
            register={register}
            errors={errors}
            isAtCloudLeader={isAtCloudLeader}
          />

          {/* Optional Information Section */}
          <OptionalSection
            register={register}
            errors={errors}
            watch={watch}
            setValue={setValue}
          />
        </SignUpFormWrapper>
      </div>
    </div>
  );
}
