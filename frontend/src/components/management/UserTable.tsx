import type { User, UserAction } from "../../types/management";
import {
  getAvatarUrlWithCacheBust,
  getAvatarAlt,
} from "../../utils/avatarUtils";
import ActionDropdown from "./ActionDropdown";
import { Link } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";

interface UserTableProps {
  users: User[];
  getActionsForUser: (user: User) => UserAction[];
  openDropdown: string | null;
  onToggleDropdown: (userId: string) => void;
  currentUserRole: string;
}

export default function UserTable({
  users,
  getActionsForUser,
  openDropdown,
  onToggleDropdown,
  currentUserRole,
}: UserTableProps) {
  const { currentUser } = useAuth();

  // Determine if user has limited visibility (like Participants and Guest Experts)
  const hasLimitedVisibility =
    currentUserRole === "Participant" || currentUserRole === "Guest Expert";

  // Smart routing: direct current user to their own profile page
  const getProfileLink = (user: User) => {
    return currentUser?.id === user.id
      ? "/dashboard/profile" // Own profile page (editable)
      : `/dashboard/profile/${user.id}`; // View-only profile page
  };
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-visible">
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            {hasLimitedVisibility ? "Community Members" : "All Users"}
          </h2>
          <div className="mt-3 sm:mt-0">
            <span className="text-sm text-gray-500">
              Showing {users.length}{" "}
              {hasLimitedVisibility ? "members" : "users"}
            </span>
          </div>
        </div>
      </div>

      {/* Desktop Table View */}
      <div className="hidden lg:block">
        <div className="overflow-x-auto overflow-y-visible">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  User
                </th>
                {hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                )}
                {!hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                )}
                {!hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    System Authorization Level
                  </th>
                )}
                {!hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role in @Cloud
                  </th>
                )}
                {!hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Join Date
                  </th>
                )}
                {!hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                )}
                {!hasLimitedVisibility && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.map((user, index) => {
                const actions = getActionsForUser(user);

                return (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      {hasLimitedVisibility ? (
                        // Participants and Guest Experts cannot click on user profiles
                        <div className="flex min-w-0 items-center">
                          <img
                            className="h-10 w-10 rounded-full object-cover aspect-square"
                            src={getAvatarUrlWithCacheBust(
                              user.avatar || null,
                              user.gender
                            )}
                            alt={getAvatarAlt(
                              user.firstName,
                              user.lastName,
                              !!user.avatar
                            )}
                          />
                          <div className="ml-4 min-w-0">
                            <div className="break-words text-sm font-medium text-gray-900">
                              {user.firstName} {user.lastName}
                            </div>
                            <div className="break-all text-sm text-gray-500">
                              @{user.username}
                            </div>
                          </div>
                        </div>
                      ) : (
                        // Other roles can click on user profiles
                        <Link
                          to={getProfileLink(user)}
                          className="-m-2 flex min-w-0 items-center rounded-lg p-2 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                        >
                          <img
                            className="h-10 w-10 rounded-full object-cover aspect-square"
                            src={getAvatarUrlWithCacheBust(
                              user.avatar || null,
                              user.gender
                            )}
                            alt={getAvatarAlt(
                              user.firstName,
                              user.lastName,
                              !!user.avatar
                            )}
                          />
                          <div className="ml-4 min-w-0">
                            <div className="break-words text-sm font-medium text-gray-900">
                              {user.firstName} {user.lastName}
                            </div>
                            <div className="break-all text-sm text-gray-500">
                              @{user.username}
                            </div>
                          </div>
                        </Link>
                      )}
                    </td>
                    {hasLimitedVisibility && (
                      <td className="px-6 py-4 whitespace-nowrap">
                        {user.roleInAtCloud ? (
                          <span className="text-sm text-gray-900">
                            {user.roleInAtCloud}
                          </span>
                        ) : (
                          <span className="text-sm text-gray-600">—</span>
                        )}
                      </td>
                    )}
                    {!hasLimitedVisibility && (
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {user.email}
                      </td>
                    )}
                    {!hasLimitedVisibility && (
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full text-center ${
                              user.role === "Super Admin"
                                ? "bg-purple-100 text-purple-800"
                                : user.role === "Administrator"
                                ? "bg-red-100 text-red-800"
                                : user.role === "Leader"
                                ? "bg-yellow-100 text-yellow-800"
                                : user.role === "Guest Expert"
                                ? "bg-cyan-50 text-cyan-700"
                                : "bg-green-100 text-green-800"
                            }`}
                          >
                            {user.role}
                          </span>
                          {/* Show "Need promotion" for Cloud Leaders who are still Participants, only visible to Super Admin and Administrator */}
                          {user.isAtCloudLeader === "Yes" &&
                            user.role === "Participant" &&
                            (currentUserRole === "Super Admin" ||
                              currentUserRole === "Administrator") && (
                              <span className="mt-1 text-xs font-medium text-orange-700">
                                Need promotion
                              </span>
                            )}
                          {/* Show "Demotion recommended" for Leaders/Administrators who are not @Cloud Co-workers, only visible to Super Admin and Administrator */}
                          {user.isAtCloudLeader === "No" &&
                            (user.role === "Leader" ||
                              user.role === "Administrator") &&
                            (currentUserRole === "Super Admin" ||
                              currentUserRole === "Administrator") && (
                              <span className="text-xs text-red-600 font-medium mt-1">
                                Demotion recommended
                              </span>
                            )}
                        </div>
                      </td>
                    )}
                    {!hasLimitedVisibility && (
                      <td className="px-6 py-4 text-xs text-gray-900">
                        <div className="break-words">
                          {user.roleInAtCloud ? (
                            <span>{user.roleInAtCloud}</span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </div>
                      </td>
                    )}
                    {!hasLimitedVisibility && (
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {user.joinDate}
                      </td>
                    )}
                    {!hasLimitedVisibility && (
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full text-center ${
                            user.isActive
                              ? "bg-green-100 text-green-800"
                              : "bg-red-100 text-red-800"
                          }`}
                        >
                          {user.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                    )}
                    {!hasLimitedVisibility && (
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <ActionDropdown
                          userId={user.id}
                          userName={`${user.firstName} ${user.lastName}`}
                          actions={actions}
                          isOpen={openDropdown === user.id}
                          onToggle={onToggleDropdown}
                          showUpward={index >= users.length - 2}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="lg:hidden divide-y divide-gray-200">
        {users.map((user) => {
          const actions = getActionsForUser(user);

          return (
            <div key={user.id} className="p-4 sm:p-6">
              <div className="mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                {hasLimitedVisibility ? (
                  // Participants and Guest Experts cannot click on user profiles
                  <div className="flex min-w-0 flex-1 items-center">
                    <img
                      className="h-12 w-12 rounded-full object-cover aspect-square"
                      src={getAvatarUrlWithCacheBust(
                        user.avatar || null,
                        user.gender
                      )}
                      alt={getAvatarAlt(
                        user.firstName,
                        user.lastName,
                        !!user.avatar
                      )}
                    />
                    <div className="ml-4 min-w-0">
                      <div className="break-words text-lg font-medium text-gray-900">
                        {user.firstName} {user.lastName}
                      </div>
                      <div className="break-all text-sm text-gray-500">
                        @{user.username}
                      </div>
                    </div>
                  </div>
                ) : (
                  // Other roles can click on user profiles
                  <Link
                    to={getProfileLink(user)}
                    className="-m-2 flex min-w-0 flex-1 items-center rounded-lg p-2 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                  >
                    <img
                      className="h-12 w-12 rounded-full object-cover aspect-square"
                      src={getAvatarUrlWithCacheBust(
                        user.avatar || null,
                        user.gender
                      )}
                      alt={getAvatarAlt(
                        user.firstName,
                        user.lastName,
                        !!user.avatar
                      )}
                    />
                    <div className="ml-4 min-w-0">
                      <div className="break-words text-lg font-medium text-gray-900">
                        {user.firstName} {user.lastName}
                      </div>
                      <div className="break-all text-sm text-gray-500">
                        @{user.username}
                      </div>
                    </div>
                  </Link>
                )}
                {hasLimitedVisibility && (
                  <div className="flex flex-col items-start sm:items-end">
                    {user.roleInAtCloud ? (
                      <span className="text-sm text-gray-900">
                        {user.roleInAtCloud}
                      </span>
                    ) : (
                      <span className="text-sm text-gray-600">—</span>
                    )}
                  </div>
                )}
                {!hasLimitedVisibility && (
                  <div className="flex flex-col items-start sm:items-end">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full text-center ${
                        user.role === "Super Admin"
                          ? "bg-purple-100 text-purple-800"
                          : user.role === "Administrator"
                          ? "bg-red-100 text-red-800"
                          : user.role === "Leader"
                          ? "bg-yellow-100 text-yellow-800"
                          : user.role === "Guest Expert"
                          ? "bg-cyan-50 text-cyan-700"
                          : "bg-green-100 text-green-800"
                      }`}
                    >
                      {user.role}
                    </span>
                    {/* Show "Need promotion" for Cloud Leaders who are still Participants, only visible to Super Admin and Administrator */}
                    {user.isAtCloudLeader === "Yes" &&
                      user.role === "Participant" &&
                      (currentUserRole === "Super Admin" ||
                        currentUserRole === "Administrator") && (
                        <span className="mt-1 text-xs font-medium text-orange-700">
                          Need promotion
                        </span>
                      )}
                    {/* Show "Demotion recommended" for Leaders/Administrators who are not @Cloud Co-workers, only visible to Super Admin and Administrator */}
                    {user.isAtCloudLeader === "No" &&
                      (user.role === "Leader" ||
                        user.role === "Administrator") &&
                      (currentUserRole === "Super Admin" ||
                        currentUserRole === "Administrator") && (
                        <span className="text-xs text-red-600 font-medium mt-1">
                          Demotion recommended
                        </span>
                      )}
                  </div>
                )}
              </div>

              <div className="space-y-2 text-sm">
                {!hasLimitedVisibility && (
                  <div>
                    <span className="font-medium text-gray-600">Email:</span>
                    <span className="ml-2 break-all text-gray-900">{user.email}</span>
                  </div>
                )}
                {!hasLimitedVisibility && (
                  <div>
                    <span className="font-medium text-gray-600 text-xs">
                      Role in @Cloud:
                    </span>
                    <span className="ml-2 text-gray-900 text-xs break-words">
                      {user.roleInAtCloud ? user.roleInAtCloud : "—"}
                    </span>
                  </div>
                )}
                {!hasLimitedVisibility && (
                  <div>
                    <span className="font-medium text-gray-600">Joined:</span>
                    <span className="ml-2 text-gray-900">{user.joinDate}</span>
                  </div>
                )}
                {!hasLimitedVisibility && (
                  <div>
                    <span className="font-medium text-gray-600">Status:</span>
                    <span
                      className={`ml-2 inline-block px-2 py-0.5 text-xs font-medium rounded-full text-center ${
                        user.isActive
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {user.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                )}
              </div>

              {!hasLimitedVisibility && (
                <div className="mt-4">
                  <ActionDropdown
                    userId={user.id}
                    userName={`${user.firstName} ${user.lastName}`}
                    actions={actions}
                    isOpen={openDropdown === user.id}
                    onToggle={onToggleDropdown}
                    isMobile={true}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
