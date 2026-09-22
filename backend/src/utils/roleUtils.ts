// Role constants that match frontend role definitions
export const ROLES = {
  SUPER_ADMIN: "Super Admin",
  ADMINISTRATOR: "Administrator",
  LEADER: "Leader",
  GUEST_EXPERT: "Guest Expert",
  PARTICIPANT: "Participant",
} as const;

export type UserRole = (typeof ROLES)[keyof typeof ROLES];

// Role hierarchy (higher index = more permissions)
export const ROLE_HIERARCHY: UserRole[] = [
  ROLES.PARTICIPANT,
  ROLES.GUEST_EXPERT,
  ROLES.LEADER,
  ROLES.ADMINISTRATOR,
  ROLES.SUPER_ADMIN,
];

// Helper functions for role checks
export class RoleUtils {
  // Check if user has a specific role
  static hasRole(userRole: string, requiredRole: UserRole): boolean {
    return userRole === requiredRole;
  }

  // Check if user has any of the specified roles
  static hasAnyRole(userRole: string, requiredRoles: UserRole[]): boolean {
    return requiredRoles.includes(userRole as UserRole);
  }

  // Check if user has role with equal or higher permissions
  static hasMinimumRole(userRole: string, minimumRole: UserRole): boolean {
    const userRoleIndex = ROLE_HIERARCHY.indexOf(userRole as UserRole);
    const minimumRoleIndex = ROLE_HIERARCHY.indexOf(minimumRole);

    if (userRoleIndex === -1 || minimumRoleIndex === -1) {
      return false;
    }

    return userRoleIndex >= minimumRoleIndex;
  }

  // Check if user is admin level (Administrator or Super Admin)
  static isAdmin(userRole: string): boolean {
    return this.hasAnyRole(userRole, [ROLES.ADMINISTRATOR, ROLES.SUPER_ADMIN]);
  }

  // Check if user is Super Admin
  static isSuperAdmin(userRole: string): boolean {
    return this.hasRole(userRole, ROLES.SUPER_ADMIN);
  }

  // Check if user is Leader or higher
  static isLeaderOrHigher(userRole: string): boolean {
    return this.hasMinimumRole(userRole, ROLES.LEADER);
  }

  // Check if user can manage events (Leader or higher)
  static canManageEvents(userRole: string): boolean {
    return this.hasMinimumRole(userRole, ROLES.LEADER);
  }

  // Check if user can manage users (Administrator or higher)
  static canManageUsers(userRole: string): boolean {
    return this.hasMinimumRole(userRole, ROLES.ADMINISTRATOR);
  }

  // Check if user can manage system settings (Super Admin only)
  static canManageSystem(userRole: string): boolean {
    return this.isSuperAdmin(userRole);
  }

  // Get all roles that are equal or lower than the given role
  static getRolesAtOrBelow(userRole: string): UserRole[] {
    const userRoleIndex = ROLE_HIERARCHY.indexOf(userRole as UserRole);
    if (userRoleIndex === -1) return [];

    return ROLE_HIERARCHY.slice(0, userRoleIndex + 1);
  }

  // Get all roles that are higher than the given role
  static getRolesAbove(userRole: string): UserRole[] {
    const userRoleIndex = ROLE_HIERARCHY.indexOf(userRole as UserRole);
    if (userRoleIndex === -1) return [];

    return ROLE_HIERARCHY.slice(userRoleIndex + 1);
  }

  // Get role display name for frontend
  static getRoleDisplayName(role: string): string {
    const roleMap: Record<string, string> = {
      [ROLES.SUPER_ADMIN]: "Super Admin",
      [ROLES.ADMINISTRATOR]: "Administrator",
      [ROLES.LEADER]: "Leader",
      [ROLES.GUEST_EXPERT]: "Guest Expert",
      [ROLES.PARTICIPANT]: "Participant",
    };

    return roleMap[role] || "Unknown Role";
  }

  // Check if a role change is a promotion (new role is higher than old role)
  static isPromotion(oldRole: string, newRole: string): boolean {
    const oldRoleIndex = ROLE_HIERARCHY.indexOf(oldRole as UserRole);
    const newRoleIndex = ROLE_HIERARCHY.indexOf(newRole as UserRole);

    if (oldRoleIndex === -1 || newRoleIndex === -1) {
      return false;
    }

    return newRoleIndex > oldRoleIndex;
  }

  // Check if a role change is a demotion (new role is lower than old role)
  static isDemotion(oldRole: string, newRole: string): boolean {
    const oldRoleIndex = ROLE_HIERARCHY.indexOf(oldRole as UserRole);
    const newRoleIndex = ROLE_HIERARCHY.indexOf(newRole as UserRole);

    if (oldRoleIndex === -1 || newRoleIndex === -1) {
      return false;
    }

    return newRoleIndex < oldRoleIndex;
  }

  // Get role permissions description
  static getRolePermissions(role: string): string[] {
    const permissions: Record<string, string[]> = {
      [ROLES.SUPER_ADMIN]: [
        "Full system access",
        "Manage all users and roles",
        "Manage system settings",
        "Create and manage all events",
        "Access all analytics and reports",
        "Manage @Cloud organization settings",
      ],
      [ROLES.ADMINISTRATOR]: [
        "Manage users (except Super Admins)",
        "Create and manage all events",
        "Access analytics and reports",
        "Moderate event participants",
        "Manage organizational communications",
      ],
      [ROLES.LEADER]: [
        "Create and manage own events",
        "View event analytics for own events",
        "Moderate participants in own events",
        "Access leadership resources",
      ],
      [ROLES.GUEST_EXPERT]: [
        "Register for events",
        "View event details",
        "Manage own profile",
        "Participate in events",
      ],
      [ROLES.PARTICIPANT]: [
        "Register for events",
        "View event details",
        "Manage own profile",
        "Participate in events",
      ],
    };

    return permissions[role] || ["No permissions defined"];
  }

  // Validate if role transition is allowed
  static canPromoteUser(
    promoterRole: string,
    currentRole: string,
    targetRole: string
  ): boolean {
    // Super Admin can promote anyone to any role
    if (this.isSuperAdmin(promoterRole)) {
      return true;
    }

    // Administrator can promote to Leader or Participant, but not to Administrator or Super Admin
    if (this.hasRole(promoterRole, ROLES.ADMINISTRATOR)) {
      return this.hasAnyRole(targetRole, [
        ROLES.LEADER,
        ROLES.GUEST_EXPERT,
        ROLES.PARTICIPANT,
      ]);
    }

    // Leaders cannot promote users
    return false;
  }

  // Check if user can view/edit another user's profile
  static canAccessUserProfile(
    accessorRole: string,
    accessorId: string,
    targetUserId: string,
    _targetUserRole: string
  ): boolean {
    // Users can always access their own profile
    if (accessorId === targetUserId) {
      return true;
    }

    // Super Admin can access any profile
    if (this.isSuperAdmin(accessorRole)) {
      return true;
    }

    // New rule: Any role higher than Participant (Leader, Administrator, Super Admin)
    // can view anyone's profile (regardless of target user's role).
    // Participants cannot view others' profiles.
    if (this.hasAnyRole(accessorRole, [ROLES.LEADER, ROLES.ADMINISTRATOR])) {
      return true;
    }

    return false;
  }

  // Get default role for new users
  static getDefaultRole(): UserRole {
    return ROLES.PARTICIPANT;
  }

  // Validate role string
  static isValidRole(role: string): role is UserRole {
    return Object.values(ROLES).includes(role as UserRole);
  }

  // Get role hierarchy index for sorting (higher index = higher authority)
  static getRoleHierarchyIndex(role: string): number {
    const index = ROLE_HIERARCHY.indexOf(role as UserRole);
    return index === -1 ? 0 : index;
  }
}

// Permission constants for specific actions
export const PERMISSIONS = {
  // Event permissions
  CREATE_EVENT: "create_event",
  EDIT_ANY_EVENT: "edit_any_event",
  EDIT_OWN_EVENT: "edit_own_event",
  DELETE_ANY_EVENT: "delete_any_event",
  DELETE_OWN_EVENT: "delete_own_event",
  VIEW_EVENT_ANALYTICS: "view_event_analytics",
  MODERATE_EVENT_PARTICIPANTS: "moderate_event_participants",

  // User permissions
  MANAGE_USERS: "manage_users",
  VIEW_USER_PROFILES: "view_user_profiles",
  EDIT_USER_ROLES: "edit_user_roles",
  DEACTIVATE_USERS: "deactivate_users",

  // System permissions
  MANAGE_SYSTEM_SETTINGS: "manage_system_settings",
  VIEW_SYSTEM_ANALYTICS: "view_system_analytics",
  MANAGE_NOTIFICATIONS: "manage_notifications",
  ACCESS_AUDIT_LOGS: "access_audit_logs",

  // Organization permissions
  MANAGE_ATCLOUD_SETTINGS: "manage_atcloud_settings",
  VIEW_ORGANIZATION_REPORTS: "view_organization_reports",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Role-based permission mapping
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [ROLES.SUPER_ADMIN]: [
    PERMISSIONS.CREATE_EVENT,
    PERMISSIONS.EDIT_ANY_EVENT,
    PERMISSIONS.EDIT_OWN_EVENT,
    PERMISSIONS.DELETE_ANY_EVENT,
    PERMISSIONS.DELETE_OWN_EVENT,
    PERMISSIONS.VIEW_EVENT_ANALYTICS,
    PERMISSIONS.MODERATE_EVENT_PARTICIPANTS,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.VIEW_USER_PROFILES,
    PERMISSIONS.EDIT_USER_ROLES,
    PERMISSIONS.DEACTIVATE_USERS,
    PERMISSIONS.MANAGE_SYSTEM_SETTINGS,
    PERMISSIONS.VIEW_SYSTEM_ANALYTICS,
    PERMISSIONS.MANAGE_NOTIFICATIONS,
    PERMISSIONS.ACCESS_AUDIT_LOGS,
    PERMISSIONS.MANAGE_ATCLOUD_SETTINGS,
    PERMISSIONS.VIEW_ORGANIZATION_REPORTS,
  ],

  [ROLES.ADMINISTRATOR]: [
    PERMISSIONS.CREATE_EVENT,
    PERMISSIONS.EDIT_ANY_EVENT,
    PERMISSIONS.EDIT_OWN_EVENT,
    PERMISSIONS.DELETE_ANY_EVENT,
    PERMISSIONS.DELETE_OWN_EVENT,
    PERMISSIONS.VIEW_EVENT_ANALYTICS,
    PERMISSIONS.MODERATE_EVENT_PARTICIPANTS,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.VIEW_USER_PROFILES,
    PERMISSIONS.EDIT_USER_ROLES,
    PERMISSIONS.DEACTIVATE_USERS, // Add deactivate permission for Administrator
    PERMISSIONS.VIEW_SYSTEM_ANALYTICS,
    PERMISSIONS.MANAGE_NOTIFICATIONS,
    PERMISSIONS.ACCESS_AUDIT_LOGS,
    PERMISSIONS.VIEW_ORGANIZATION_REPORTS,
  ],

  [ROLES.LEADER]: [
    PERMISSIONS.CREATE_EVENT,
    PERMISSIONS.EDIT_OWN_EVENT,
    PERMISSIONS.DELETE_OWN_EVENT,
    PERMISSIONS.VIEW_EVENT_ANALYTICS,
    PERMISSIONS.MODERATE_EVENT_PARTICIPANTS,
    PERMISSIONS.VIEW_USER_PROFILES,
    PERMISSIONS.VIEW_SYSTEM_ANALYTICS, // Added for Analytics page access
    PERMISSIONS.DEACTIVATE_USERS, // Add deactivate permission for Leader (Participants only)
  ],

  [ROLES.GUEST_EXPERT]: [
    PERMISSIONS.VIEW_USER_PROFILES, // Same permissions as Participant
  ],

  [ROLES.PARTICIPANT]: [
    PERMISSIONS.VIEW_USER_PROFILES, // Allow viewing Community page
  ],
};

// Helper function to check if user has specific permission
export function hasPermission(
  userRole: string,
  permission: Permission
): boolean {
  if (!RoleUtils.isValidRole(userRole)) {
    return false;
  }

  const rolePermissions = ROLE_PERMISSIONS[userRole as UserRole];
  return rolePermissions.includes(permission);
}

// Helper function to get all permissions for a role
export function getRolePermissions(userRole: string): Permission[] {
  if (!RoleUtils.isValidRole(userRole)) {
    return [];
  }

  return ROLE_PERMISSIONS[userRole as UserRole];
}
