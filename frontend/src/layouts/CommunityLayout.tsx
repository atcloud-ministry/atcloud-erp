import { Link, Outlet, useLocation } from "react-router-dom";
import { useAlumniHelp } from "../contexts/AlumniHelpContext";
import { useOptionalChatRooms } from "../contexts/ChatRoomsContext";

const communityLinks = [
  {
    id: "directory",
    label: "Alumni Directory",
    to: "/dashboard/community/alumni",
  },
  {
    id: "my-profile",
    label: "My Alumni Profile",
    to: "/dashboard/community/alumni/me",
  },
  {
    id: "help-requests",
    label: "Help Requests",
    to: "/dashboard/community/help-requests",
  },
  {
    id: "chats",
    label: "Chats",
    to: "/dashboard/chat-rooms",
  },
  {
    id: "members",
    label: "Members",
    to: "/dashboard/community/members",
  },
] as const;

export default function CommunityLayout() {
  const { pathname } = useLocation();
  const { helpNotificationCount } = useAlumniHelp();
  const chatUnreadTotal = useOptionalChatRooms()?.chatUnreadTotal ?? 0;
  const directoryBase = "/dashboard/community/alumni";
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";

  const isActive = (id: (typeof communityLinks)[number]["id"]): boolean => {
    if (id === "my-profile") {
      return normalizedPathname === `${directoryBase}/me`;
    }
    if (id === "help-requests") {
      return (
        normalizedPathname === "/dashboard/community/help-requests" ||
        normalizedPathname.startsWith("/dashboard/community/help-requests/")
      );
    }
    if (id === "chats") {
      return normalizedPathname === "/dashboard/chat-rooms";
    }
    if (id === "members") {
      return normalizedPathname === "/dashboard/community/members";
    }
    return (
      normalizedPathname === directoryBase ||
      (normalizedPathname.startsWith(`${directoryBase}/`) &&
        normalizedPathname !== `${directoryBase}/me`)
    );
  };

  return (
    <div className="space-y-6">
      <nav
        aria-label="Community sections"
        className="overflow-x-auto rounded-lg bg-white shadow-sm"
      >
        <div className="flex min-w-max border-b border-gray-200 px-4 pt-4">
          {communityLinks.map((link) => {
            const active = isActive(link.id);
            const badge =
              link.id === "help-requests"
                ? {
                    count: helpNotificationCount,
                    description: "requests with updates or actions needed",
                  }
                : link.id === "chats"
                  ? {
                      count: chatUnreadTotal,
                      description:
                        chatUnreadTotal === 1
                          ? "unread message"
                          : "unread messages",
                    }
                  : null;
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-label={
                  badge && badge.count > 0
                    ? `${link.label}, ${badge.count} ${badge.description}`
                    : undefined
                }
                aria-current={active ? "page" : undefined}
                className={`-mb-px rounded-t-lg border px-6 py-3 text-base font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                  active
                    ? "relative z-10 border-gray-200 border-b-white bg-white text-blue-700"
                    : "border-transparent bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                }`}
              >
                <span>{link.label}</span>
                {badge && badge.count > 0 && (
                  <span
                    aria-hidden="true"
                    className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white"
                  >
                    {badge.count > 99 ? "99+" : badge.count}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>
      <span aria-live="polite" className="sr-only">
        {helpNotificationCount > 0
          ? `${helpNotificationCount} Alumni Help requests have updates or need action.`
          : "No Alumni Help updates or actions needed."}
      </span>
      <Outlet />
    </div>
  );
}
