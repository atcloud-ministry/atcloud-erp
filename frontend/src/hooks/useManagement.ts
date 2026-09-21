import { useState, useEffect, useMemo } from "react";
import { useToastReplacement } from "../contexts/NotificationModalContext";
import type { SystemAuthorizationLevel, User } from "../types/management";
import { useRoleStats } from "./useRoleStats";
import { useCommunityStats } from "./useUsersApi";
import { useUserPermissions } from "./useUserPermissions";
import { useAuth } from "./useAuth";
import { MANAGEMENT_CONFIG } from "../config/managementConstants";
import { useUserData } from "./useUserData";
import { userService } from "../services/api";

// Types for confirmation modal
interface DeletionImpact {
  user: {
    email: string;
    name: string;
    role: string;
    createdAt: Date;
  };
  impact: {
    registrations: number;
    eventsCreated: number;
    eventOrganizations: number;
    messageStates: number;
    messagesCreated: number;
    promoCodes: number;
    programMentorships: number;
    programClassReps: number;
    programMentees: number;
    shortLinks: number;
    avatarFile: boolean;
    eventFlyerFiles: number;
    affectedEvents: Array<{
      id: string;
      title: string;
      participantCount: number;
    }>;
  };
  risks: string[];
}

interface ConfirmationAction {
  type: "promote" | "demote" | "delete" | "deactivate" | "reactivate";
  user: User;
  newRole?: SystemAuthorizationLevel;
  title: string;
  message: string;
  confirmText: string;
  actionType: "danger" | "warning" | "info";
  deletionImpact?: DeletionImpact;
}

export function useManagement(providedUsers?: User[]) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [confirmationAction, setConfirmationAction] =
    useState<ConfirmationAction | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Get current user and notification context
  const { currentUser } = useAuth();
  const notification = useToastReplacement();

  // Get actual current user role from auth context
  const currentUserRole: SystemAuthorizationLevel =
    currentUser?.role || "Participant";

  // Use existing hooks for user data management
  const userData = useUserData({ enabled: providedUsers === undefined });
  const {
    users: internalUsers,
    promoteUser,
    demoteUser,
    deleteUser,
    deactivateUser,
    reactivateUser,
    pagination,
    loadPage,
  } = userData;

  // Use provided users if available, otherwise use internal users
  const users = providedUsers || internalUsers;

  // 1) Page-derived stats (fallback)
  const pageRoleStats = useRoleStats(users);

  // 2) Backend-wide stats for the whole collection (all authenticated users can fetch)
  const { stats: backendStats, loading: backendStatsLoading } =
    useCommunityStats(providedUsers === undefined);

  // Map backend stats shape to RoleStats for UI cards; fallback to page stats while loading
  const roleStats = useMemo(() => {
    // Backend stats normalized shape
    type BackendRoleDistribution = Record<
      | "Super Admin"
      | "Administrator"
      | "Leader"
      | "Guest Expert"
      | "Participant",
      number
    > &
      Record<string, number>;
    interface BackendUserStats {
      totalUsers: number;
      atCloudLeaders: number;
      roleDistribution: BackendRoleDistribution;
    }
    const fromPossibles = (obj: unknown): BackendUserStats | null => {
      const stats =
        (obj as { stats?: unknown })?.stats ||
        (obj as { data?: { stats?: unknown } })?.data?.stats ||
        null;
      if (!stats || typeof stats !== "object") return null;
      const s = stats as Partial<BackendUserStats>;
      if (!s.roleDistribution) return null;
      return {
        totalUsers: Number(s.totalUsers ?? 0),
        atCloudLeaders: Number(s.atCloudLeaders ?? 0),
        roleDistribution: s.roleDistribution as BackendRoleDistribution,
      };
    };

    const normalized = fromPossibles(backendStats);
    if (!normalized) return pageRoleStats;

    const roleDist = normalized.roleDistribution;
    return {
      total: normalized.totalUsers,
      superAdmin: roleDist["Super Admin"] || 0,
      administrators: roleDist["Administrator"] || 0,
      leaders: roleDist["Leader"] || 0,
      guestExperts: roleDist["Guest Expert"] || 0,
      participants: roleDist["Participant"] || 0,
      atCloudLeaders: normalized.atCloudLeaders,
    };
  }, [backendStats, pageRoleStats]);

  // Loading state for role statistics (page users or backend stats)
  const roleStatsLoading = userData.loading || backendStatsLoading;

  // Handle user actions with confirmation dialogs
  const showPromoteConfirmation = (
    user: User,
    newRole: SystemAuthorizationLevel,
  ) => {
    const roleHierarchy = {
      Participant: "Participant",
      "Guest Expert": "Guest Expert",
      Leader: "Leader",
      Administrator: "Administrator",
      "Super Admin": "Super Admin",
    } satisfies Record<SystemAuthorizationLevel, string>;

    setConfirmationAction({
      type: "promote",
      user,
      newRole,
      title: "Confirm Role Promotion",
      message: `Are you sure you want to promote ${user.firstName} ${
        user.lastName
      } from ${roleHierarchy[user.role]} to ${
        roleHierarchy[newRole]
      }?\n\nThis action will:\n• Grant ${
        user.firstName
      } additional permissions\n• Change their access level in the system\n• Notify them of their new role`,
      confirmText: `Promote to ${roleHierarchy[newRole]}`,
      actionType: "info",
    });
    setOpenDropdown(null);
  };

  const showDemoteConfirmation = (
    user: User,
    newRole: SystemAuthorizationLevel,
  ) => {
    const roleHierarchy = {
      Participant: "Participant",
      "Guest Expert": "Guest Expert",
      Leader: "Leader",
      Administrator: "Administrator",
      "Super Admin": "Super Admin",
    } satisfies Record<SystemAuthorizationLevel, string>;

    setConfirmationAction({
      type: "demote",
      user,
      newRole,
      title: "Confirm Role Demotion",
      message: `Are you sure you want to demote ${user.firstName} ${
        user.lastName
      } from ${roleHierarchy[user.role]} to ${
        roleHierarchy[newRole]
      }?\n\nThis action will:\n• Remove some of ${
        user.firstName
      }'s current permissions\n• Restrict their access level in the system\n• Notify them of their role change`,
      confirmText: `Demote to ${roleHierarchy[newRole]}`,
      actionType: "warning",
    });
    setOpenDropdown(null);
  };

  const showDeleteConfirmation = async (user: User) => {
    try {
      // Fetch deletion impact analysis
      const impactData = await userService.getUserDeletionImpact(user.id);

      // Build detailed impact message
      const impactDetails = `
Deletion Impact Analysis:
• Event Registrations: ${impactData.impact.registrations} will be deleted
• Events Created: ${
        impactData.impact.eventsCreated
      } will be permanently deleted${
        impactData.impact.eventFlyerFiles > 0
          ? ` (including ${impactData.impact.eventFlyerFiles} flyer files)`
          : ""
      }
• Event Organizer Roles: ${
        impactData.impact.eventOrganizations
      } organizations will be removed
• Messages: ${impactData.impact.messagesCreated} will be deleted
• Promo Codes: ${impactData.impact.promoCodes} owned codes will be deleted
• Program Mentorships: ${
        impactData.impact.programMentorships
      } programs will lose this mentor
• Program Class Rep: ${
        impactData.impact.programClassReps
      } enrollments will be removed
• Program Mentee: ${
        impactData.impact.programMentees
      } enrollments will be removed
• Published Event Links: ${
        impactData.impact.shortLinks
      } shortlinks will be deleted${
        impactData.impact.avatarFile ? "\n• Avatar File: Will be deleted" : ""
      }${
        impactData.impact.affectedEvents.length > 0
          ? `\n• Affected Events: ${impactData.impact.affectedEvents.length} events will have updated statistics`
          : ""
      }`;

      setConfirmationAction({
        type: "delete",
        user,
        title: "Confirm User Deletion",
        message: `Are you sure you want to permanently delete ${user.firstName} ${user.lastName}?\n\n${impactDetails}\n\nThis action will:\n• Permanently remove their account\n• Delete all their data and activity history\n• Remove them from all events and conversations\n• Cannot be undone\n\nPlease type the user's full name to confirm this irreversible action.`,
        confirmText: "Delete User",
        actionType: "danger",
        deletionImpact: impactData,
      });
    } catch (error) {
      console.error("Failed to fetch deletion impact:", error);

      // Fallback to generic confirmation if impact fetch fails
      setConfirmationAction({
        type: "delete",
        user,
        title: "Confirm User Deletion",
        message: `Are you sure you want to permanently delete ${user.firstName} ${user.lastName}?\n\nThis action will:\n• Permanently remove their account\n• Delete all their data and activity history\n• Remove them from all events and conversations\n• Cannot be undone\n\nPlease type the user's full name to confirm this irreversible action.`,
        confirmText: "Delete User",
        actionType: "danger",
      });
    }
    setOpenDropdown(null);
  };

  const showDeactivateConfirmation = (user: User) => {
    setConfirmationAction({
      type: "deactivate",
      user,
      title: "Confirm User Deactivation",
      message: `Are you sure you want to deactivate ${user.firstName} ${user.lastName}?\n\nThis action will:\n• Prevent them from logging in\n• Keep all their data and activity history intact\n• Maintain their role and permissions for when reactivated\n• Can be reversed by reactivating the user`,
      confirmText: "Deactivate User",
      actionType: "warning",
    });
    setOpenDropdown(null);
  };

  const showReactivateConfirmation = (user: User) => {
    setConfirmationAction({
      type: "reactivate",
      user,
      title: "Confirm User Reactivation",
      message: `Are you sure you want to reactivate ${user.firstName} ${user.lastName}?\n\nThis action will:\n• Allow them to log in again\n• Restore their access to all features\n• Maintain their existing role and permissions\n• Grant them full system access based on their role`,
      confirmText: "Reactivate User",
      actionType: "info",
    });
    setOpenDropdown(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmationAction) return;

    setIsProcessing(true);

    try {
      // Simulate processing delay for better UX
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const { user } = confirmationAction;
      const fullName = `${user.firstName} ${user.lastName}`;

      switch (confirmationAction.type) {
        case "promote":
          if (confirmationAction.newRole) {
            promoteUser(confirmationAction.user.id, confirmationAction.newRole);

            notification.success(
              `${fullName} has been successfully promoted to ${confirmationAction.newRole}!`,
              {
                title: "User Promoted",
                autoCloseDelay: 4000,
              },
            );
          }
          break;
        case "demote":
          if (confirmationAction.newRole) {
            demoteUser(confirmationAction.user.id, confirmationAction.newRole);

            notification.success(
              `${fullName} has been demoted to ${confirmationAction.newRole}.`,
              {
                title: "User Demoted",
                autoCloseDelay: 4000,
              },
            );
          }
          break;
        case "delete":
          deleteUser(confirmationAction.user.id);
          notification.success(
            `${fullName} has been permanently deleted from the system.`,
            {
              title: "User Deleted",
              autoCloseDelay: 5000,
            },
          );
          break;
        case "deactivate":
          deactivateUser(confirmationAction.user.id);
          notification.success(
            `${fullName} has been deactivated and can no longer log in.`,
            {
              title: "User Deactivated",
              autoCloseDelay: 4000,
            },
          );
          break;
        case "reactivate":
          reactivateUser(confirmationAction.user.id);
          notification.success(
            `${fullName} has been reactivated and can now log in.`,
            {
              title: "User Reactivated",
              autoCloseDelay: 4000,
            },
          );
          break;
      }
    } catch (error) {
      console.error("Management action failed:", error);
      notification.error(
        "The management action could not be completed. Please check your permissions and try again.",
        {
          title: "Action Failed",
          autoCloseDelay: 5000,
          actionButton: {
            text: "Retry",
            onClick: () => {
              if (confirmationAction) {
                handleConfirmAction();
              }
            },
            variant: "primary",
          },
        },
      );
    } finally {
      setIsProcessing(false);
      setConfirmationAction(null);
    }
  };

  const handleCancelConfirmation = () => {
    setConfirmationAction(null);
    setIsProcessing(false);
  };

  // Legacy handlers - replaced with confirmation dialogs
  const handlePromoteUser = (
    userId: string,
    newRole: SystemAuthorizationLevel,
  ) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      showPromoteConfirmation(user, newRole);
    }
  };

  const handleDemoteUser = (
    userId: string,
    newRole: SystemAuthorizationLevel,
  ) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      showDemoteConfirmation(user, newRole);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      await showDeleteConfirmation(user);
    }
  };

  const handleDeactivateUser = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      showDeactivateConfirmation(user);
    }
  };

  const handleReactivateUser = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      showReactivateConfirmation(user);
    }
  };

  // Get user permissions actions
  const { getActionsForUser } = useUserPermissions(
    currentUserRole,
    handlePromoteUser,
    handleDemoteUser,
    handleDeleteUser,
    handleDeactivateUser,
    handleReactivateUser,
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(`.${MANAGEMENT_CONFIG.dropdownContainerClass}`)) {
        setOpenDropdown(null);
      }
    };

    if (openDropdown !== null) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [openDropdown]);

  const toggleDropdown = (userId: string) => {
    setOpenDropdown(openDropdown === userId ? null : userId);
  };

  return {
    // User data
    users,
    currentUserRole,
    roleStats,
    roleStatsLoading,
    pagination,
    loadPage,

    // Dropdown state
    openDropdown,
    toggleDropdown,

    // User actions
    getActionsForUser,

    // Direct actions (if needed)
    handlePromoteUser,
    handleDemoteUser,
    handleDeleteUser,
    handleDeactivateUser,
    handleReactivateUser,

    // Confirmation modal state
    confirmationAction,
    isProcessing,
    handleConfirmAction,
    handleCancelConfirmation,
  };
}
