import { Link } from "react-router-dom";
import type { CommunityMemberDTO } from "../../services/api";
import type { SystemAuthorizationLevel } from "../../types/management";
import { useAuth } from "../../hooks/useAuth";
import {
  getAvatarAlt,
  getAvatarUrlWithCacheBust,
} from "../../utils/avatarUtils";

interface CommunityMemberTableProps {
  members: CommunityMemberDTO[];
  currentUserRole: SystemAuthorizationLevel;
}

export default function CommunityMemberTable({
  members,
  currentUserRole,
}: CommunityMemberTableProps) {
  const { currentUser } = useAuth();
  const canOpenMemberProfile = currentUserRole === "Leader";

  const identity = (member: CommunityMemberDTO, size: "sm" | "lg") => {
    const content = (
      <>
        <img
          className={`${size === "sm" ? "h-10 w-10" : "h-12 w-12"} rounded-full object-cover aspect-square`}
          src={getAvatarUrlWithCacheBust(
            member.avatar,
            member.gender ?? "male",
          )}
          alt={getAvatarAlt(
            member.firstName ?? "",
            member.lastName ?? "",
            Boolean(member.avatar),
          )}
        />
        <div className="ml-4">
          <div className="text-sm font-medium text-gray-900">
            {member.firstName} {member.lastName}
          </div>
          <div className="text-sm text-gray-500">@{member.username}</div>
        </div>
      </>
    );

    if (!canOpenMemberProfile && currentUser?.id !== member.id) {
      return <div className="flex items-center">{content}</div>;
    }

    const href =
      currentUser?.id === member.id
        ? "/dashboard/profile"
        : `/dashboard/profile/${member.id}`;
    return (
      <Link
        to={href}
        className="flex items-center hover:bg-gray-100 -m-2 p-2 rounded-lg transition-colors"
      >
        {content}
      </Link>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            Community Members
          </h2>
          <span className="text-sm text-gray-500">
            Showing {members.length} members
          </span>
        </div>
      </div>

      <div className="hidden lg:block overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Member
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Role in @Cloud
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {members.map((member) => (
              <tr key={member.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  {identity(member, "sm")}
                </td>
                <td className="px-6 py-4 text-sm text-gray-900">
                  {member.roleInAtCloud || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="lg:hidden divide-y divide-gray-200">
        {members.map((member) => (
          <div key={member.id} className="p-6">
            {identity(member, "lg")}
            <div className="mt-3 text-sm text-gray-600">
              Role in @Cloud: {member.roleInAtCloud || "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
