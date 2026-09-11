import { useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import { useNavigate, useLocation } from "react-router-dom";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import { signUpSchema, type SignUpFormData } from "../schemas/signUpSchema";
import {
  calculatePasswordStrength,
  type PasswordStrength,
} from "../utils/passwordUtils";
import { authService } from "../services/api";
import {
  inferPhoneCountry,
  prepareRegistrationProfileSubmission,
} from "../utils/registrationProfile";

export function useSignUpForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [migrationNoticeEmail, setMigrationNoticeEmail] = useState<
    string | null
  >(null);
  const navigate = useNavigate();
  const location = useLocation();
  const notification = useToastReplacement();

  // Pre-populate from navigation state (e.g. from public event registration)
  const prefill =
    (location.state as {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
    }) || {};

  const form = useForm<SignUpFormData>({
    resolver: yupResolver(signUpSchema) as Resolver<SignUpFormData>,
    defaultValues: {
      firstName: prefill.firstName || "",
      lastName: prefill.lastName || "",
      email: prefill.email || "",
      phone: prefill.phone || "",
      phoneCountryCode: inferPhoneCountry(prefill.phone) || "",
      birthYear: undefined,
      residenceCountryCode: "",
      residenceRegion: "",
      residenceCity: "",
      employmentStatus: "",
      company: "",
      occupation: "",
      // Ensure selects start on placeholder instead of defaulting to first option
      gender: "",
      isAtCloudLeader: "false",
    },
    mode: "onChange", // Enable real-time validation
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
    setError,
  } = form;

  // Watch form values
  const username = watch("username");
  const password = watch("password");
  const isAtCloudLeader = watch("isAtCloudLeader");
  const email = watch("email");

  // Calculate password strength
  const passwordStrength: PasswordStrength = calculatePasswordStrength(
    password || "",
  );

  const onSubmit = async (data: SignUpFormData) => {
    setIsSubmitting(true);

    try {
      const profile = prepareRegistrationProfileSubmission(data);
      if (!profile.success) {
        for (const issue of profile.issues) {
          setError(issue.field, { type: "validate", message: issue.message });
        }
        return;
      }

      // Use a local flag to orchestrate modal sequencing for this submit
      const showMigrationNotice = migrationNoticeEmail !== email;

      // Prepare user data for registration
      const userData = {
        username: data.username, // Use the actual username from form
        email: data.email,
        password: data.password,
        confirmPassword: data.confirmPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        gender: data.gender as "male" | "female",
        isAtCloudLeader: data.isAtCloudLeader === "true",
        roleInAtCloud: data.roleInAtCloud,
        ...profile.value,
        weeklyChurch: data.weeklyChurch,
        churchAddress: data.churchAddress,
        acceptTerms: true, // This is handled by validation in the form
      };

      // Informational: surface a soft notice that we will link past guest registrations
      // on email verification if the email matches previous guest signups.
      if (showMigrationNotice) {
        setMigrationNoticeEmail(email);
        // First modal: We’ll keep your history (no auto-close, no close X)
        notification.info(
          "If you've registered as a guest before with this email, we'll link those registrations once you verify your email.",
          {
            title: "We’ll keep your history",
            autoClose: false,
            showCloseButton: false,
            closeButtonText: "OK",
            lockUntilClose: true,
            // When this modal is closed by user, show the Welcome modal next (also requires OK)
            onClose: () => {
              notification.success(
                "Registration successful! Check your email for a verification link to activate your account.",
                {
                  title: "Welcome to @Cloud!",
                  autoClose: false,
                  showCloseButton: false,
                  closeButtonText: "OK",
                  lockUntilClose: true,
                  // After user closes Welcome modal, navigate to check-email
                  onClose: () => {
                    navigate("/check-email", { state: { email: data.email } });
                  },
                },
              );
            },
          },
        );
      }

      // Call the actual registration API
      await authService.register(userData);

      // If the migration notice already queued the Welcome modal (via onClose),
      // we don't enqueue another. Otherwise, show the Welcome modal now and navigate on close.
      if (!showMigrationNotice) {
        notification.success(
          "Registration successful! Check your email for a verification link to activate your account.",
          {
            title: "Welcome to @Cloud!",
            autoClose: false,
            showCloseButton: false,
            closeButtonText: "OK",
            lockUntilClose: true,
            onClose: () => {
              navigate("/check-email", { state: { email: data.email } });
            },
          },
        );
      }

      // Check if user signed up as @Cloud Co-worker with a role
      // To avoid replacing the first modal, only show these immediate notices
      // when we did NOT show the migration notice chain in this submit.
      if (!showMigrationNotice) {
        if (
          data.isAtCloudLeader === "true" &&
          data.roleInAtCloud &&
          data.roleInAtCloud.trim() !== ""
        ) {
          notification.success(
            "Your @Cloud Co-worker request has been submitted for review by administrators.",
            {
              title: "Co-worker Request Submitted",
              autoCloseDelay: 5000,
            },
          );
        } else if (data.isAtCloudLeader === "true") {
          notification.info(
            "Your @Cloud Co-worker request has been noted. Please update your profile with your role in @Cloud.",
            {
              title: "Co-worker Request Noted",
              autoCloseDelay: 5000,
            },
          );
        }
      }

      // Navigate to check email page after successful registration
      // Navigation now occurs only after user clicks OK on the Welcome modal.
    } catch (error: unknown) {
      console.error("Sign up error:", error);
      const message =
        (typeof (error as { message?: unknown })?.message === "string"
          ? (error as { message?: string }).message
          : undefined) ||
        "Registration failed. Please check your information and try again.";
      notification.error(message, {
        title: "Registration Failed",
        autoCloseDelay: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    // Form state
    form,
    register,
    errors,
    watch,
    setValue,
    isSubmitting,

    // Watched values
    username,
    password,
    isAtCloudLeader,
    email,
    passwordStrength,

    // Actions
    handleSubmit,
    onSubmit: handleSubmit(onSubmit), // Wrap with react-hook-form validation
  };
}
