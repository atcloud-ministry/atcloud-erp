import {
  Bars3Icon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  HeartIcon,
} from "@heroicons/react/24/outline";
import { Link, useLocation } from "react-router-dom";

export const MOBILE_BOTTOM_NAVIGATION_HREFS = [
  "/dashboard/upcoming",
  "/dashboard/chat-rooms",
  "/dashboard/donate",
  "/dashboard/feedback",
] as const;

export function isMobileBottomNavigationHref(
  href: string | undefined,
): boolean {
  return Boolean(
    href &&
      MOBILE_BOTTOM_NAVIGATION_HREFS.includes(
        href as (typeof MOBILE_BOTTOM_NAVIGATION_HREFS)[number],
      ),
  );
}

interface MobileBottomNavigationProps {
  chatUnreadTotal?: number;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

interface Destination {
  activePathPrefix?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

const destinations: Destination[] = [
  {
    href: "/dashboard/upcoming",
    icon: CalendarDaysIcon,
    label: "Event Calendar",
  },
  {
    href: "/dashboard/chat-rooms",
    activePathPrefix: "/dashboard/chat-rooms",
    icon: ChatBubbleOvalLeftEllipsisIcon,
    label: "Chat Rooms",
  },
  {
    href: "/dashboard/donate",
    icon: HeartIcon,
    label: "Donate",
  },
  {
    href: "/dashboard/feedback",
    icon: ChatBubbleLeftRightIcon,
    label: "Feedback",
  },
];

export default function MobileBottomNavigation({
  chatUnreadTotal = 0,
  menuOpen,
  setMenuOpen,
}: MobileBottomNavigationProps) {
  const location = useLocation();
  const hasActiveDestination = destinations.some(
    ({ activePathPrefix, href }) =>
      location.pathname === href ||
      Boolean(
        activePathPrefix &&
          location.pathname.startsWith(`${activePathPrefix}/`),
      ),
  );
  const menuHighlighted = menuOpen || !hasActiveDestination;

  const commonItemClass =
    "relative flex min-h-16 min-w-0 flex-col items-center justify-center gap-0.5 px-1 py-1 text-center text-[10px] font-medium leading-3 transition-colors focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 sm:text-xs";

  return (
    <nav
      aria-label="Mobile primary navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur md:hidden"
      data-testid="mobile-bottom-navigation"
      id="dashboard-mobile-bottom-navigation"
    >
      <div className="grid grid-cols-5">
        <button
          aria-controls="dashboard-primary-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-pressed={menuOpen}
          className={`${commonItemClass} ${
            menuHighlighted
              ? "bg-blue-50 text-blue-700"
              : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
          }`}
          id="dashboard-mobile-menu-button"
          onClick={() => setMenuOpen(!menuOpen)}
          type="button"
        >
          <Bars3Icon aria-hidden="true" className="h-6 w-6 shrink-0" />
          <span>Menu</span>
        </button>

        {destinations.map(({ activePathPrefix, href, icon: Icon, label }) => {
          const isActive =
            location.pathname === href ||
            Boolean(
              activePathPrefix &&
                location.pathname.startsWith(`${activePathPrefix}/`),
            );
          const unreadLabel =
            label === "Chat Rooms" && chatUnreadTotal > 0
              ? `${label}, ${chatUnreadTotal} unread ${
                  chatUnreadTotal === 1 ? "message" : "messages"
                }`
              : label;

          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              aria-label={unreadLabel}
              className={`${commonItemClass} ${
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
              key={href}
              onClick={() => setMenuOpen(false)}
              to={href}
            >
              <span className="relative">
                <Icon aria-hidden="true" className="h-6 w-6 shrink-0" />
                {label === "Chat Rooms" && chatUnreadTotal > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-3 -top-2 inline-flex min-h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white"
                  >
                    {chatUnreadTotal > 99 ? "99+" : chatUnreadTotal}
                  </span>
                )}
              </span>
              <span className="max-w-full text-balance">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
