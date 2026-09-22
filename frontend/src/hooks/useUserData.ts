import { useState, useEffect, useCallback } from "react";
import type { User, SystemAuthorizationLevel } from "../types/management";
import { useUsers } from "../hooks/useUsersApi";
import {
  userService,
  type AdminUserDTO,
} from "../services/api";
import { useToastReplacement } from "../contexts/NotificationModalContext";

const toManagementUser = (user: AdminUserDTO): User => ({
  id: user.id,
  username: user.username,
  firstName: user.firstName ?? "",
  lastName: user.lastName ?? "",
  email: user.email,
  phone: user.phone ?? undefined,
  role: user.role,
  isAtCloudLeader: user.isAtCloudLeader ? "Yes" : "No",
  roleInAtCloud: user.roleInAtCloud ?? undefined,
  joinDate: user.createdAt
    ? new Date(user.createdAt).toISOString().split("T")[0]
    : "",
  gender: user.gender ?? "male",
  avatar: user.avatar,
  homeAddress: user.homeAddress ?? undefined,
  occupation: user.occupation ?? undefined,
  company: user.company ?? undefined,
  weeklyChurch: user.weeklyChurch ?? undefined,
  churchAddress: user.churchAddress ?? undefined,
  isActive: user.isActive,
});

export const useUserData = (options?: {
  suppressErrors?: boolean;
  enabled?: boolean;
}) => {
  const {
    users: apiUsers,
    loading,
    error,
    refreshUsers,
    pagination,
    loadPage,
  } = useUsers({
    suppressErrors: options?.suppressErrors,
    autoFetch: options?.enabled !== false,
  });
  const [users, setUsers] = useState<User[]>([]);
  const notification = useToastReplacement();

  // Convert the current administrative page to the management view model.
  useEffect(() => {
    setUsers(apiUsers.map(toManagementUser));
  }, [apiUsers]);

  // User management functions
  const promoteUser = useCallback(
    async (userId: string, newRole: SystemAuthorizationLevel) => {
      try {
        await userService.updateUserRole(userId, newRole);

        // Update local state
        setUsers((prevUsers) =>
          prevUsers.map((user) =>
            user.id === userId ? { ...user, role: newRole } : user
          )
        );

        notification.success(`User promoted to ${newRole}`, {
          title: "Promotion Successful",
        });
      } catch (error) {
        console.error("Error promoting user:", error);
        notification.error("Failed to promote user. Please try again.", {
          title: "Promotion Failed",
        });
      }
    },
    [notification]
  );

  const demoteUser = useCallback(
    async (userId: string, newRole: SystemAuthorizationLevel) => {
      try {
        await userService.updateUserRole(userId, newRole);

        // Update local state
        setUsers((prevUsers) =>
          prevUsers.map((user) =>
            user.id === userId ? { ...user, role: newRole } : user
          )
        );

        notification.success(
          `User System Authorization Level changed to ${newRole}`,
          {
            title: "Role Change Successful",
          }
        );
      } catch (error) {
        console.error("Error changing user role:", error);
        notification.error("Failed to change user role. Please try again.", {
          title: "Role Change Failed",
        });
      }
    },
    [notification]
  );

  const deleteUser = useCallback(
    async (userId: string) => {
      try {
        await userService.deleteUser(userId);

        // Update local state
        setUsers((prevUsers) => prevUsers.filter((user) => user.id !== userId));

        notification.success(
          "User has been permanently deleted from the system.",
          {
            title: "User Deleted Successfully",
            autoCloseDelay: 4000,
          }
        );
      } catch (error) {
        console.error("Error deleting user:", error);
        notification.error(
          "Failed to delete user. Please check your permissions and try again.",
          {
            title: "Deletion Failed",
            autoCloseDelay: 6000,
            actionButton: {
              text: "Retry",
              onClick: () => deleteUser(userId),
              variant: "primary",
            },
          }
        );
      }
    },
    [notification]
  );

  const deactivateUser = useCallback(
    async (userId: string) => {
      try {
        await userService.deactivateUser(userId);

        // Update local state
        setUsers((prevUsers) =>
          prevUsers.map((user) =>
            user.id === userId ? { ...user, isActive: false } : user
          )
        );

        notification.success("User has been deactivated successfully.", {
          title: "User Deactivated",
          autoCloseDelay: 4000,
        });
      } catch (error) {
        console.error("Error deactivating user:", error);
        notification.error(
          "Failed to deactivate user. Please check your permissions and try again.",
          {
            title: "Deactivation Failed",
            autoCloseDelay: 6000,
            actionButton: {
              text: "Retry",
              onClick: () => deactivateUser(userId),
              variant: "primary",
            },
          }
        );
      }
    },
    [notification]
  );

  const reactivateUser = useCallback(
    async (userId: string) => {
      try {
        await userService.reactivateUser(userId);

        // Update local state
        setUsers((prevUsers) =>
          prevUsers.map((user) =>
            user.id === userId ? { ...user, isActive: true } : user
          )
        );

        notification.success("User has been reactivated successfully.", {
          title: "User Reactivated",
          autoCloseDelay: 4000,
        });
      } catch (error) {
        console.error("Error reactivating user:", error);
        notification.error(
          "Failed to reactivate user. Please check your permissions and try again.",
          {
            title: "Reactivation Failed",
            autoCloseDelay: 6000,
            actionButton: {
              text: "Retry",
              onClick: () => reactivateUser(userId),
              variant: "primary",
            },
          }
        );
      }
    },
    [notification]
  );

  return {
    users,
    loading,
    error,
    refreshUsers,
    pagination,
    loadPage,
    promoteUser,
    demoteUser,
    deleteUser,
    deactivateUser,
    reactivateUser,
  };
};
