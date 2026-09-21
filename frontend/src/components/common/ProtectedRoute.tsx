import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import type { SystemAuthorizationLevel } from "../../types";
import LoadingSpinner from "./LoadingSpinner";
import AuthInitializationError from "./AuthInitializationError";

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: SystemAuthorizationLevel;
  allowedRoles?: SystemAuthorizationLevel[];
}

export function ProtectedRoute({
  children,
  requiredRole,
  allowedRoles,
}: ProtectedRouteProps) {
  const {
    currentUser,
    isLoading,
    initializationError,
    retryInitialization,
  } = useAuth();
  const location = useLocation();

  // Show loading spinner while checking authentication
  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (initializationError) {
    return (
      <AuthInitializationError
        message={initializationError}
        onRetry={retryInitialization}
      />
    );
  }

  // Redirect to login if user is not authenticated
  if (!currentUser) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check role-based access if specified
  if (requiredRole && currentUser.role !== requiredRole) {
    return <Navigate to="/dashboard" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(currentUser.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

export default ProtectedRoute;
