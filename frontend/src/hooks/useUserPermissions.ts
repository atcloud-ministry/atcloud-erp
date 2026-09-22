import { useMemo } from "react";
import type {
  User,
  SystemAuthorizationLevel,
  UserAction,
} from "../types/management";

interface UserPermissionsHook {
  getActionsForUser: (user: User) => UserAction[];
  canPromoteUser: (user: User) => boolean;
  canDemoteUser: (user: User) => boolean;
  canDeleteUser: (user: User) => boolean;
  canDeactivateUser: (user: User) => boolean;
}

export const useUserPermissions = (
  currentUserRole: SystemAuthorizationLevel,
  onPromoteUser: (userId: string, newRole: SystemAuthorizationLevel) => void,
  onDemoteUser: (userId: string, newRole: SystemAuthorizationLevel) => void,
  onDeleteUser: (userId: string) => void,
  onDeactivateUser: (userId: string) => void,
  onReactivateUser: (userId: string) => void
): UserPermissionsHook => {
  // Memoize permission check functions
  const permissionChecks = useMemo(
    () => ({
      canPromoteUser: (user: User): boolean => {
        if (currentUserRole === "Super Admin") {
          return user.role !== "Super Admin"; // Can promote anyone except Super Admin
        } else if (currentUserRole === "Administrator") {
          // Can promote Participants or Guest Experts (to Guest Expert/Leader)
          return user.role === "Participant" || user.role === "Guest Expert";
        }
        return false;
      },

      canDemoteUser: (user: User): boolean => {
        if (currentUserRole === "Super Admin") {
          return user.role !== "Super Admin" && user.role !== "Participant"; // Changed from "User"
        } else if (currentUserRole === "Administrator") {
          // Can demote Leaders to Guest Expert/Participant, or Guest Experts to Participant
          return user.role === "Leader" || user.role === "Guest Expert";
        }
        return false;
      },

      canDeleteUser: (user: User): boolean => {
        return currentUserRole === "Super Admin" && user.role !== "Super Admin";
      },

      canDeactivateUser: (user: User): boolean => {
        // Super Admin, Administrator, and Leader can deactivate users
        if (currentUserRole === "Super Admin") {
          return user.role !== "Super Admin"; // Cannot deactivate other Super Admins
        } else if (currentUserRole === "Administrator") {
          return user.role !== "Administrator" && user.role !== "Super Admin"; // Cannot deactivate other Administrators or Super Admins
        } else if (currentUserRole === "Leader") {
          return user.role === "Participant"; // Can only deactivate Participants
        }
        return false;
      },

      canModifyUser: (user: User): boolean => {
        if (currentUserRole === "Super Admin") {
          return user.role !== "Super Admin"; // Can modify anyone except Super Admin
        } else if (currentUserRole === "Administrator") {
          return user.role !== "Administrator"; // Cannot modify other Administrators
        } else if (currentUserRole === "Leader") {
          return user.role === "Participant"; // Can only modify Participants
        }
        return false; // Participants cannot modify anyone
      },
    }),
    [currentUserRole]
  );

  // Generate actions based on permissions
  const getActionsForUser = useMemo(
    () =>
      (user: User): UserAction[] => {
        const actions: UserAction[] = [];

        // If user cannot be modified at all, show "No Actions Available"
        if (!permissionChecks.canModifyUser(user)) {
          actions.push({
            label: "No Actions Available",
            onClick: () => {},
            className: "text-gray-400 cursor-not-allowed",
            disabled: true,
          });
          return actions;
        }

        // Super Admin permissions
        if (currentUserRole === "Super Admin") {
          if (user.role === "Participant") {
            actions.push(
              {
                label: "Promote to Guest Expert",
                onClick: () => onPromoteUser(user.id, "Guest Expert"),
                className:
                  "text-green-700 hover:text-green-900 hover:bg-green-50",
              },
              {
                label: "Promote to Leader",
                onClick: () => onPromoteUser(user.id, "Leader"),
                className:
                  "text-green-700 hover:text-green-900 hover:bg-green-50",
              },
              {
                label: "Promote to Administrator",
                onClick: () => onPromoteUser(user.id, "Administrator"),
                className: "text-blue-600 hover:text-blue-900 hover:bg-blue-50",
              }
            );
          } else if (user.role === "Guest Expert") {
            actions.push(
              {
                label: "Promote to Leader",
                onClick: () => onPromoteUser(user.id, "Leader"),
                className:
                  "text-green-700 hover:text-green-900 hover:bg-green-50",
              },
              {
                label: "Promote to Administrator",
                onClick: () => onPromoteUser(user.id, "Administrator"),
                className: "text-blue-600 hover:text-blue-900 hover:bg-blue-50",
              },
              {
                label: "Demote to Participant", // Changed from "Demote to User"
                onClick: () => onDemoteUser(user.id, "Participant"), // Changed from "User"
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              }
            );
          } else if (user.role === "Leader") {
            actions.push(
              {
                label: "Promote to Administrator",
                onClick: () => onPromoteUser(user.id, "Administrator"),
                className: "text-blue-600 hover:text-blue-900 hover:bg-blue-50",
              },
              {
                label: "Demote to Guest Expert",
                onClick: () => onDemoteUser(user.id, "Guest Expert"),
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              },
              {
                label: "Demote to Participant", // Changed from "Demote to User"
                onClick: () => onDemoteUser(user.id, "Participant"), // Changed from "User"
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              }
            );
          } else if (user.role === "Administrator") {
            actions.push(
              {
                label: "Demote to Leader",
                onClick: () => onDemoteUser(user.id, "Leader"),
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              },
              {
                label: "Demote to Guest Expert",
                onClick: () => onDemoteUser(user.id, "Guest Expert"),
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              },
              {
                label: "Demote to Participant", // Changed from "Demote to User"
                onClick: () => onDemoteUser(user.id, "Participant"), // Changed from "User"
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              }
            );
          }

          // Add deactivate/reactivate actions for Super Admin
          if (permissionChecks.canDeactivateUser(user)) {
            if (user.isActive) {
              actions.push({
                label: "Deactivate User",
                onClick: () => onDeactivateUser(user.id),
                className:
                  "text-yellow-700 hover:text-yellow-900 hover:bg-yellow-50",
              });
            } else {
              actions.push({
                label: "Reactivate User",
                onClick: () => onReactivateUser(user.id),
                className: "text-blue-600 hover:text-blue-900 hover:bg-blue-50",
              });
            }
          }

          // Super Admin can delete users
          if (permissionChecks.canDeleteUser(user)) {
            actions.push({
              label: "Delete User",
              onClick: () => onDeleteUser(user.id),
              className: "text-red-600 hover:text-red-900 hover:bg-red-50",
            });
          }
        }

        // Administrator permissions
        else if (currentUserRole === "Administrator") {
          if (user.role === "Participant") {
            actions.push(
              {
                label: "Promote to Guest Expert",
                onClick: () => onPromoteUser(user.id, "Guest Expert"),
                className:
                  "text-green-700 hover:text-green-900 hover:bg-green-50",
              },
              {
                label: "Promote to Leader",
                onClick: () => onPromoteUser(user.id, "Leader"),
                className:
                  "text-green-700 hover:text-green-900 hover:bg-green-50",
              }
            );
          } else if (user.role === "Guest Expert") {
            actions.push(
              {
                label: "Promote to Leader",
                onClick: () => onPromoteUser(user.id, "Leader"),
                className:
                  "text-green-700 hover:text-green-900 hover:bg-green-50",
              },
              {
                label: "Demote to Participant", // Changed from "Demote to User"
                onClick: () => onDemoteUser(user.id, "Participant"), // Changed from "User"
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              }
            );
          } else if (user.role === "Leader") {
            actions.push(
              {
                label: "Demote to Guest Expert",
                onClick: () => onDemoteUser(user.id, "Guest Expert"),
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              },
              {
                label: "Demote to Participant", // Changed from "Demote to User"
                onClick: () => onDemoteUser(user.id, "Participant"), // Changed from "User"
                className:
                  "text-orange-700 hover:text-orange-900 hover:bg-orange-50",
              }
            );
          }

          // Add deactivate/reactivate actions for Administrator
          if (permissionChecks.canDeactivateUser(user)) {
            if (user.isActive) {
              actions.push({
                label: "Deactivate User",
                onClick: () => onDeactivateUser(user.id),
                className:
                  "text-yellow-700 hover:text-yellow-900 hover:bg-yellow-50",
              });
            } else {
              actions.push({
                label: "Reactivate User",
                onClick: () => onReactivateUser(user.id),
                className: "text-blue-600 hover:text-blue-900 hover:bg-blue-50",
              });
            }
          }
        }

        // Leader permissions
        else if (currentUserRole === "Leader") {
          // Add deactivate/reactivate actions for Leader (only for Participants)
          if (permissionChecks.canDeactivateUser(user)) {
            if (user.isActive) {
              actions.push({
                label: "Deactivate User",
                onClick: () => onDeactivateUser(user.id),
                className:
                  "text-yellow-700 hover:text-yellow-900 hover:bg-yellow-50",
              });
            } else {
              actions.push({
                label: "Reactivate User",
                onClick: () => onReactivateUser(user.id),
                className: "text-blue-600 hover:text-blue-900 hover:bg-blue-50",
              });
            }
          }
        }

        // If no actions were added, show "No Actions Available"
        if (actions.length === 0) {
          actions.push({
            label: "No Actions Available",
            onClick: () => {},
            className: "text-gray-400 cursor-not-allowed",
            disabled: true,
          });
        }

        return actions;
      },
    [
      currentUserRole,
      permissionChecks,
      onPromoteUser,
      onDemoteUser,
      onDeleteUser,
      onDeactivateUser,
      onReactivateUser,
    ]
  );

  return {
    getActionsForUser,
    canPromoteUser: permissionChecks.canPromoteUser,
    canDemoteUser: permissionChecks.canDemoteUser,
    canDeleteUser: permissionChecks.canDeleteUser,
    canDeactivateUser: permissionChecks.canDeactivateUser,
  };
};
