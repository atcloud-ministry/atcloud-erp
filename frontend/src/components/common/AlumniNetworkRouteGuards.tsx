import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useRuntimeConfig } from "../../contexts/RuntimeConfigContext";
import { useAuth } from "../../hooks/useAuth";
import LoadingSpinner from "./LoadingSpinner";

interface RouteContentProps {
  children: ReactNode;
}

export function AlumniNetworkReadableRoute({ children }: RouteContentProps) {
  const { config, status } = useRuntimeConfig();

  if (status === "loading") {
    return <LoadingSpinner />;
  }

  if (status !== "ready" || !config.alumniNetwork.readable) {
    return <Navigate to="/dashboard/management" replace />;
  }

  return <>{children}</>;
}

export function UserManagementAccessRoute({ children }: RouteContentProps) {
  const { canManageUsers } = useAuth();

  if (!canManageUsers) {
    return <Navigate to="/dashboard/community/members" replace />;
  }

  return <>{children}</>;
}

export function LegacyManagementEntry({ children }: RouteContentProps) {
  const { config, status } = useRuntimeConfig();
  const { canManageUsers } = useAuth();

  if (status !== "ready" || !config.alumniNetwork.readable) {
    return <>{children}</>;
  }

  return (
    <Navigate
      to={
        canManageUsers
          ? "/dashboard/admin/users"
          : "/dashboard/community/members"
      }
      replace
    />
  );
}
