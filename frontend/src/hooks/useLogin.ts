import { useState } from "react";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import type { LoginFormData } from "../schemas/loginSchema";
import { useAuth } from "./useAuth";
import { authService } from "../services/api";
import {
  canSendVerificationEmail,
  markVerificationEmailSent,
  getRemainingCooldown,
  formatCooldownTime,
} from "../utils/emailValidationUtils";

export function useLogin() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [userEmailForResend, setUserEmailForResend] = useState<string>("");
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const notification = useToastReplacement();
  const { login } = useAuth();

  const handleLogin = async (data: LoginFormData) => {
    const isEmailInput = data.emailOrUsername.includes("@");
    if (loginAttempts >= 5) {
      notification.error(
        "Too many failed attempts. Please try password recovery.",
        {
          title: "Account Temporarily Locked",
          autoCloseDelay: 6000,
        },
      );
      return;
    }

    setIsSubmitting(true);

    try {
      // Call the AuthContext login method
      const result = await login(data);

      if (result.success) {
        notification.success(
          "Welcome back! Redirecting you securely...",
          {
            title: "Login Successful",
            autoCloseDelay: 2000,
          },
        );
      } else {
        // Failed login
        const newAttempts = loginAttempts + 1;
        setLoginAttempts(newAttempts);

        if (newAttempts >= 5) {
          notification.error(
            "Maximum login attempts reached. Please use password recovery.",
            {
              title: "Account Locked",
              autoCloseDelay: 6000,
            },
          );
        } else {
          const baseMsg = buildLoginFailureBaseMessage(
            isEmailInput,
            result.error,
          );
          notification.error(
            `${baseMsg}. ${5 - newAttempts} attempts remaining.`,
            {
              title: "Login Failed",
              autoCloseDelay: 5000,
            },
          );
        }
      }
    } catch (error) {
      console.error("Login error:", error);
      notification.error(
        isEmailInput
          ? "Login failed. Check email format, password, or connection."
          : "Login failed. Check username, password, or connection.",
        {
          title: "Connection Error",
          autoCloseDelay: 5000,
        },
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResendVerification = async (email: string) => {
    try {
      // Check cooldown period to prevent spam
      if (!canSendVerificationEmail(email)) {
        const remainingTime = getRemainingCooldown(email, "verification");
        notification.warning(
          `Please wait ${formatCooldownTime(
            remainingTime,
          )} before requesting another verification email.`,
          {
            title: "Cooldown Period Active",
            autoCloseDelay: 5000,
          },
        );
        return;
      }

      await authService.resendVerification(email);

      // Mark email as sent for cooldown tracking
      markVerificationEmailSent(email);

      notification.success(
        "Verification email sent! Please check your inbox and spam folder.",
        {
          title: "Email Sent",
          autoCloseDelay: 4000,
        },
      );
    } catch (error) {
      console.error("Error resending verification email:", error);
      notification.error(
        "Failed to resend verification email. Please try again.",
        {
          title: "Send Failed",
          autoCloseDelay: 5000,
          actionButton: {
            text: "Retry",
            onClick: () => handleResendVerification(email),
            variant: "primary",
          },
        },
      );
    }
  };

  const handleResendVerificationFromLogin = async () => {
    if (!userEmailForResend) return;

    setIsResendingVerification(true);
    try {
      await handleResendVerification(userEmailForResend);
      // Clear the verification state after successful resend
      setNeedsVerification(false);
      setUserEmailForResend("");
    } catch (error) {
      console.error("Error resending verification from login:", error);
    } finally {
      setIsResendingVerification(false);
    }
  };

  const resetLoginAttempts = () => {
    setLoginAttempts(0);
    setNeedsVerification(false);
    setUserEmailForResend("");
  };

  return {
    isSubmitting,
    loginAttempts,
    needsVerification,
    userEmailForResend,
    isResendingVerification,
    handleLogin,
    handleResendVerification,
    handleResendVerificationFromLogin,
    resetLoginAttempts,
  };
}

// Pure helper exported for testing (single definition)
export function buildLoginFailureBaseMessage(
  isEmailInput: boolean,
  backendError?: string,
): string {
  let baseMsg = backendError || "Invalid credentials";
  if (backendError?.includes("Invalid") || !backendError) {
    baseMsg = isEmailInput
      ? "Invalid email or password"
      : "Invalid username or password";
  }
  return baseMsg;
}
