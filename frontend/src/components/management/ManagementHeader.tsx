import type {
  SystemAuthorizationLevel,
  RoleStats,
} from "../../types/management";
import StatisticsCards from "./StatisticsCards";
import { PageHeader } from "../ui";
import type { ManagementDirectoryScope } from "../../hooks/useManagementFilters";

interface ManagementHeaderProps {
  currentUserRole: SystemAuthorizationLevel;
  roleStats: RoleStats;
  loadingStats?: boolean;
  scope?: ManagementDirectoryScope;
}

export default function ManagementHeader({
  currentUserRole,
  roleStats,
  loadingStats = false,
  scope,
}: ManagementHeaderProps) {
  // Dynamic title and subtitle based on user role
  const getTitleForRole = (role: SystemAuthorizationLevel): string => {
    switch (role) {
      case "Participant":
        return "Community";
      case "Guest Expert":
        return "Community";
      case "Leader":
        return "Community";
      default:
        return "User Management";
    }
  };

  const getSubtitleForRole = (role: SystemAuthorizationLevel): string => {
    switch (role) {
      case "Super Admin":
        return "Manage user roles and permissions for @Cloud Marketplace Ministry. As a Super Admin, you have full access to view all users and manage their access levels across the entire system.";
      case "Administrator":
        return "Manage user roles and permissions for @Cloud Marketplace Ministry. As an Administrator, you can view all users and manage their access levels within your scope of authority.";
      case "Leader":
        return "View community members and their information for @Cloud Marketplace Ministry. As a Leader, you can browse member profiles and see community statistics.";
      case "Guest Expert":
        return "Browse and connect with other community members in @Cloud Marketplace Ministry. As a Guest Expert, you can view members and discover who's part of our community.";
      case "Participant":
        return "Browse and connect with other community members in @Cloud Marketplace Ministry. As a Participant, you can view fellow members and discover who's part of our community.";
      default:
        return "View user information for @Cloud Marketplace Ministry.";
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          scope === "community"
            ? "Community"
            : scope === "admin"
              ? "User Management"
              : getTitleForRole(currentUserRole)
        }
        subtitle={
          scope === "community"
            ? "Browse and connect with active, verified members of @Cloud Marketplace Ministry."
            : getSubtitleForRole(currentUserRole)
        }
      />

      {/* Statistics Cards */}
      <StatisticsCards stats={roleStats} loading={loadingStats} />
    </div>
  );
}
