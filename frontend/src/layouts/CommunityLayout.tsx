import { Link, Outlet, useLocation } from "react-router-dom";

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
    id: "members",
    label: "Members",
    to: "/dashboard/community/members",
  },
] as const;

export default function CommunityLayout() {
  const { pathname } = useLocation();
  const directoryBase = "/dashboard/community/alumni";

  const isActive = (id: (typeof communityLinks)[number]["id"]): boolean => {
    if (id === "my-profile") return pathname === `${directoryBase}/me`;
    if (id === "members") {
      return pathname === "/dashboard/community/members";
    }
    return (
      pathname === directoryBase ||
      (pathname.startsWith(`${directoryBase}/`) &&
        pathname !== `${directoryBase}/me`)
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
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-current={active ? "page" : undefined}
                className={`-mb-px rounded-t-lg border px-6 py-3 text-base font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                  active
                    ? "relative z-10 border-gray-200 border-b-white bg-white text-blue-700"
                    : "border-transparent bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
