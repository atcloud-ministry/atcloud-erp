import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import { useLocation, useNavigate } from "react-router-dom";
import { loginSchema } from "../schemas/loginSchema";
import type {
  LoginFormData,
  ForgotPasswordFormData,
} from "../schemas/loginSchema";
import { FormField } from "../components/ui";
import LoginPasswordField from "../components/forms/LoginPasswordField";
import {
  LoginHeader,
  LoginFormWrapper,
  LoginAttemptsWarning,
  ForgotPasswordForm,
} from "../components/login";
import { useLogin } from "../hooks/useLogin";
import { useForgotPassword } from "../hooks/useForgotPassword";
import { useAuthForm } from "../hooks/useAuthForm";
import { useAuth } from "../hooks/useAuth";
import {
  consumeStoredLoginRedirect,
  resolvePostLoginRedirect,
} from "../utils/loginRedirect";

export default function Login() {
  const { currentUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const redirectStartedRef = useRef(false);

  const {
    isSubmitting,
    loginAttempts,
    needsVerification,
    userEmailForResend,
    isResendingVerification,
    handleLogin,
    handleResendVerificationFromLogin,
    resetLoginAttempts,
  } = useLogin();
  const { isSubmitting: isRecoverySubmitting, handleForgotPassword } =
    useForgotPassword();
  const { showForgotPassword, showForgotPasswordForm, showLoginForm } =
    useAuthForm();

  useEffect(() => {
    if (!currentUser) {
      redirectStartedRef.current = false;
      return;
    }
    if (redirectStartedRef.current) return;
    redirectStartedRef.current = true;

    const stateUnknown: unknown = location.state;
    const state =
      typeof stateUnknown === "object" && stateUnknown !== null
        ? (stateUnknown as {
            from?: { pathname?: string; search?: string; hash?: string };
          })
        : null;
    const target = resolvePostLoginRedirect({
      search: location.search,
      from: state?.from,
      storedReturnUrl: consumeStoredLoginRedirect(),
    });
    navigate(target, { replace: true });
  }, [currentUser, location.search, location.state, navigate]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: yupResolver(loginSchema),
    defaultValues: { emailOrUsername: "", password: "", rememberMe: false },
  });

  if (currentUser) {
    return (
      <main className="min-h-screen bg-gray-50" aria-busy="true">
        <p className="sr-only">Redirecting after login…</p>
      </main>
    );
  }

  const onSubmit = async (data: LoginFormData) => {
    await handleLogin(data);
  };

  const onForgotPasswordSubmit = async (data: ForgotPasswordFormData) => {
    const success = await handleForgotPassword(data);
    if (success) {
      showLoginForm();
      resetLoginAttempts();
    }
  };

  if (showForgotPassword) {
    return (
      <ForgotPasswordForm
        onSubmit={onForgotPasswordSubmit}
        isSubmitting={isRecoverySubmitting}
        onBackToLogin={showLoginForm}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <LoginHeader />

        <LoginFormWrapper
          onSubmit={handleSubmit(onSubmit)}
          isSubmitting={isSubmitting}
          loginAttempts={loginAttempts}
          onForgotPassword={showForgotPasswordForm}
          needsVerification={needsVerification}
          userEmailForResend={userEmailForResend}
          isResendingVerification={isResendingVerification}
          onResendVerification={handleResendVerificationFromLogin}
        >
          <LoginAttemptsWarning loginAttempts={loginAttempts} />

          <FormField
            label="Username or Email"
            name="emailOrUsername"
            register={register}
            errors={errors}
            placeholder="Enter your username or email"
            required={true}
            className={loginAttempts >= 5 ? "opacity-50" : ""}
          />

          <LoginPasswordField
            register={register}
            errors={errors}
            disabled={loginAttempts >= 5}
            required={true}
          />

          {loginAttempts > 0 && loginAttempts < 5 && (
            <LoginAttemptsWarning loginAttempts={loginAttempts} />
          )}
        </LoginFormWrapper>
      </div>
    </div>
  );
}
