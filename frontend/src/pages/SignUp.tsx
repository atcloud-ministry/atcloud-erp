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
import { Link } from "react-router-dom";

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
    registrationNotice,
    registrationNoticeError,

    // Actions
    onSubmit,
    reloadRegistrationNotice,
  } = useSignUpForm();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl w-full space-y-8">
        <SignUpHeader />

        <SignUpFormWrapper
          isSubmitting={isSubmitting}
          onSubmit={onSubmit}
          submitDisabled={!registrationNotice}
        >
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

          <section
            aria-labelledby="registration-privacy-heading"
            className="rounded-lg border border-gray-200 bg-gray-50 p-4"
          >
            <h2
              className="text-base font-semibold text-gray-900"
              id="registration-privacy-heading"
            >
              Registration privacy notice
            </h2>
            {registrationNoticeError ? (
              <div className="mt-2" role="alert">
                <p className="text-sm text-red-700">
                  {registrationNoticeError}
                </p>
                <button
                  className="mt-2 min-h-11 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  onClick={reloadRegistrationNotice}
                  type="button"
                >
                  Try Again
                </button>
              </div>
            ) : registrationNotice ? (
              <>
                <input
                  type="hidden"
                  {...register("registrationNoticeVersion")}
                />
                <p className="mt-2 text-sm leading-6 text-gray-700">
                  {registrationNotice.text}
                </p>
                <label className="mt-3 flex items-start gap-3 text-sm text-gray-800">
                  <input
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    type="checkbox"
                    {...register("acceptTerms")}
                  />
                  <span>
                    I have read and accept this notice. Read the full{" "}
                    <Link
                      className="font-medium text-blue-700 underline hover:text-blue-900"
                      to="/privacy"
                    >
                      Privacy &amp; Data Use
                    </Link>
                    .
                  </span>
                </label>
                {errors.acceptTerms?.message && (
                  <p className="mt-2 text-sm text-red-700" role="alert">
                    {errors.acceptTerms.message}
                  </p>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  Notice version: {registrationNotice.version}
                </p>
              </>
            ) : (
              <p aria-live="polite" className="mt-2 text-sm text-gray-600">
                Loading registration privacy notice…
              </p>
            )}
          </section>
        </SignUpFormWrapper>
      </div>
    </div>
  );
}
