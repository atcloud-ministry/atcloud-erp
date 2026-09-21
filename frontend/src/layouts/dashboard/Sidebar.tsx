import { Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import ConfirmLogoutModal from "../../components/common/ConfirmLogoutModal";
import {
  CalendarDaysIcon,
  CalendarIcon,
  ArrowRightOnRectangleIcon,
  PlusIcon,
  UsersIcon,
  HomeIcon,
  SpeakerWaveIcon,
  ChartBarIcon,
  ClipboardDocumentListIcon,
  ComputerDesktopIcon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  RectangleStackIcon,
  AcademicCapIcon,
  GlobeAltIcon,
  ShieldCheckIcon,
  DocumentDuplicateIcon,
  TicketIcon,
  CreditCardIcon,
  HeartIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../../hooks/useAuth";
import { useRuntimeConfig } from "../../contexts/RuntimeConfigContext";
import {
  buildLoginRedirectUrl,
  getPathWithSearch,
} from "../../utils/loginRedirect";

interface NavigationItem {
  name: string;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  activePathPrefix?: string;
  badgeCount?: number;
  badgeDescription?: string;
}

interface SidebarProps {
  userRole: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  chatUnreadTotal?: number;
  helpNotificationCount?: number;
  systemMessageUnreadCount?: number;
}

const MOBILE_NAVIGATION_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function mobileNavigationControls(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      MOBILE_NAVIGATION_FOCUSABLE_SELECTOR,
    ),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("hidden"),
  );
}

export default function Sidebar({
  userRole,
  sidebarOpen,
  setSidebarOpen,
  chatUnreadTotal = 0,
  helpNotificationCount = 0,
  systemMessageUnreadCount = 0,
}: SidebarProps) {
  const location = useLocation(); //获取当前路径
  const navigate = useNavigate();
  const { canManageUsers, logout } = useAuth();
  const { config: runtimeConfig, status: runtimeConfigStatus } =
    useRuntimeConfig();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const [isDesktopNavigation, setIsDesktopNavigation] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia("(min-width: 1024px)").matches,
  );
  const guestLoginHref = buildLoginRedirectUrl(getPathWithSearch(location));
  const communityNavigationEnabled =
    runtimeConfigStatus === "ready" &&
    runtimeConfig.alumniNetwork.readable;
  const navigationVisible = isDesktopNavigation || sidebarOpen;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktopNavigation(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!sidebarOpen || isDesktopNavigation) return;
    const menuButton = document.getElementById(
      "dashboard-mobile-menu-button",
    );
    const backgroundElements = [
      menuButton?.closest<HTMLElement>("header") ?? null,
      document.getElementById("dashboard-main-content"),
    ].filter((element): element is HTMLElement => element !== null);
    const previousInertValues = backgroundElements.map((element) => ({
      attribute: element.hasAttribute("inert"),
      property: element.inert,
    }));
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    backgroundElements.forEach((element) => {
      element.inert = true;
      element.setAttribute("inert", "");
    });

    const focusFrame = window.requestAnimationFrame(() => {
      const navigation = navigationRef.current;
      if (!navigation) return;
      (mobileNavigationControls(navigation)[0] ?? navigation).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const navigation = navigationRef.current;
      if (!navigation) return;

      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
        window.requestAnimationFrame(() => menuButton?.focus());
        return;
      }

      if (event.key !== "Tab") return;
      const controls = mobileNavigationControls(navigation);
      if (controls.length === 0) {
        event.preventDefault();
        navigation.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !navigation.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !navigation.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      backgroundElements.forEach((element, index) => {
        const previous = previousInertValues[index];
        element.inert = previous?.property ?? false;
        if (previous?.attribute) {
          element.setAttribute("inert", "");
        } else {
          element.removeAttribute("inert");
        }
      });
      if (menuButton?.isConnected) menuButton.focus();
    };
  }, [isDesktopNavigation, setSidebarOpen, sidebarOpen]);

  const handleLogout = async () => {
    try {
      setLogoutLoading(true);
      await logout();
      navigate("/");
    } finally {
      setLogoutLoading(false);
    }
  };

  // Navigation items based on user role
  const getNavigationItems = (): NavigationItem[] => {
    // Guest visitors: limited nav
    if (userRole === "guest") {
      return [
        { name: "Welcome", href: "/dashboard/welcome", icon: HomeIcon },
        {
          name: "EMBA Program",
          href: "/dashboard/emba-program",
          icon: AcademicCapIcon,
        },
        {
          name: "Other Programs",
          href: "/dashboard/programs",
          icon: RectangleStackIcon,
        },
        {
          name: "Annual Membership",
          href: "/dashboard/annual-memberships",
          icon: CreditCardIcon,
        },
        {
          name: "Event Calendar",
          href: "/dashboard/upcoming",
          icon: CalendarDaysIcon,
        },
        {
          name: "Past Events",
          href: "/dashboard/passed",
          icon: CalendarIcon,
        },
        { name: "Donate", href: "/dashboard/donate", icon: HeartIcon },
        {
          name: "Log In",
          href: guestLoginHref,
          icon: ArrowRightOnRectangleIcon,
        },
      ];
    }

    const baseItems: NavigationItem[] = [
      // Welcome as the first item
      {
        name: "Welcome",
        href: "/dashboard/welcome",
        icon: HomeIcon,
      },
      {
        name: "EMBA Program",
        href: "/dashboard/emba-program",
        icon: AcademicCapIcon,
      },
      {
        name: "Other Programs",
        href: "/dashboard/programs",
        icon: RectangleStackIcon,
      },
      {
        name: "Annual Membership",
        href: "/dashboard/annual-memberships",
        icon: CreditCardIcon,
      },
      {
        name: "Event Calendar",
        href: "/dashboard/upcoming",
        icon: CalendarDaysIcon,
      },
      { name: "Past Events", href: "/dashboard/passed", icon: CalendarIcon },
      {
        name: "My Events",
        href: "/dashboard/my-events",
        icon: ClipboardDocumentListIcon,
      },
    ];

    const addAlumniCommunityNavigation = () => {
      baseItems.push({
        name: "Alumni Community",
        href: "/dashboard/community",
        activePathPrefix: "/dashboard/community",
        icon: UsersIcon,
        badgeCount: helpNotificationCount,
        badgeDescription: "help requests with updates or actions needed",
      });
      baseItems.push({
        name: "Chat Rooms",
        href: "/dashboard/chat-rooms",
        activePathPrefix: "/dashboard/chat-rooms",
        icon: ChatBubbleOvalLeftEllipsisIcon,
        badgeCount: chatUnreadTotal,
      });
    };

    // Add Published Events for Super Admin, Administrator, and Leader
    if (
      userRole === "Super Admin" ||
      userRole === "Administrator" ||
      userRole === "Leader"
    ) {
      baseItems.push({
        name: "Published Events",
        href: "/dashboard/published-events",
        icon: GlobeAltIcon,
      });
    }

    // Add role-specific items according to requirements
    if (userRole === "Super Admin" || userRole === "Administrator") {
      baseItems.push(
        {
          name: "Create Event",
          href: "/dashboard/new-event",
          icon: PlusIcon,
        },
        {
          name: "Role Templates",
          href: "/dashboard/configure-roles-templates",
          icon: DocumentDuplicateIcon,
        },
      );
      if (communityNavigationEnabled) {
        addAlumniCommunityNavigation();
      }
      baseItems.push(
        {
          name: "Promo Codes",
          href: "/dashboard/admin/promo-codes",
          icon: TicketIcon,
        },
        {
          name: "Income History",
          href: "/dashboard/income-history",
          icon: CreditCardIcon,
        },
      );
      if (communityNavigationEnabled) {
        if (canManageUsers) {
          baseItems.push({
            name: "User Management",
            href: "/dashboard/admin/users",
            activePathPrefix: "/dashboard/admin/users",
            icon: UsersIcon,
          });
        }
      } else {
        baseItems.push({
          name: "Management",
          href: "/dashboard/management",
          icon: UsersIcon,
        });
      }
    } else if (userRole === "Leader") {
      baseItems.push(
        {
          name: "Create Event",
          href: "/dashboard/new-event",
          icon: PlusIcon,
        },
        {
          name: "Role Templates",
          href: "/dashboard/configure-roles-templates",
          icon: DocumentDuplicateIcon,
        },
      );
      if (communityNavigationEnabled) {
        addAlumniCommunityNavigation();
      } else {
        baseItems.push({
          name: "Community",
          href: "/dashboard/management",
          icon: UsersIcon,
        });
      }
    } else if (userRole === "Participant" || userRole === "Guest Expert") {
      // Participants can now see Create Event (with on-page access notice) and Community
      baseItems.push({
        name: "Create Event",
        href: "/dashboard/new-event",
        icon: PlusIcon,
      });
      if (communityNavigationEnabled) {
        addAlumniCommunityNavigation();
      } else {
        baseItems.push({
          name: "Community",
          href: "/dashboard/management",
          icon: UsersIcon,
        });
      }
    }

    // Add System Messages for all logged-in users
    baseItems.push({
      name: "System Messages",
      href: "/dashboard/system-messages",
      icon: SpeakerWaveIcon,
      badgeCount: systemMessageUnreadCount,
    });

    // Add Analytics for all roles (page handles access notice for Participants)
    if (
      userRole === "Super Admin" ||
      userRole === "Administrator" ||
      userRole === "Leader" ||
      userRole === "Participant" ||
      userRole === "Guest Expert"
    ) {
      baseItems.push({
        name: "Analytics",
        href: "/dashboard/analytics",
        icon: ChartBarIcon,
      });
    }

    // Add System Monitoring for Super Admin only
    if (userRole === "Super Admin") {
      baseItems.push({
        name: "System Monitor",
        href: "/dashboard/monitor",
        icon: ComputerDesktopIcon,
      });
    }

    // Add Audit Logs for Super Admin and Administrator
    if (userRole === "Super Admin" || userRole === "Administrator") {
      baseItems.push({
        name: "Audit Logs",
        href: "/dashboard/audit-logs",
        icon: ShieldCheckIcon,
      });
    }

    // Add Feedback for all users (above Log Out)
    baseItems.push({
      name: "Feedback",
      href: "/dashboard/feedback",
      icon: ChatBubbleLeftRightIcon,
    });

    // Add Donate for all users (between Feedback and Log Out)
    baseItems.push({
      name: "Donate",
      href: "/dashboard/donate",
      icon: HeartIcon,
    });

    baseItems.push({
      name: "Log Out",
      icon: ArrowRightOnRectangleIcon,
      onClick: () => setShowLogoutConfirm(true),
    });

    return baseItems;
  };

  const navigationItems = getNavigationItems();

  return (
    <>
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-0 bg-black bg-opacity-50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav
        aria-hidden={!navigationVisible}
        aria-label="Primary navigation"
        className={`
          fixed inset-y-0 left-0 z-[60] w-64 bg-white shadow-sm border-r lg:z-40
          transform transition-transform duration-300 ease-in-out lg:translate-x-0
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
        id="dashboard-primary-navigation"
        inert={!navigationVisible ? true : undefined}
        ref={navigationRef}
        tabIndex={-1}
      >
        <div className="p-4 pt-20 h-full overflow-y-auto">
          <ul className="space-y-2">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              // More robust active state detection
              const isActive = !!(
                item.href &&
                (location.pathname === item.href ||
                  (item.activePathPrefix &&
                    location.pathname.startsWith(
                      `${item.activePathPrefix}/`,
                    )) ||
                  (item.href === "/dashboard/emba-program" &&
                    location.pathname === "/dashboard"))
              );

              return (
                <li key={item.name}>
                    {item.href ? (
                      <Link
                        aria-current={isActive ? "page" : undefined}
                        to={item.href}
                        aria-label={
                          item.badgeCount && item.badgeCount > 0
                            ? `${item.name}, ${item.badgeCount} ${item.badgeDescription ?? "unread messages"}`
                            : undefined
                        }
                        className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
                          isActive
                            ? "bg-blue-50 text-blue-700 border-r-2 border-blue-700"
                            : "text-gray-700 hover:bg-gray-50"
                        }`}
                        onClick={() => setSidebarOpen(false)} // Close mobile menu on click
                      >
                        <Icon className="w-5 h-5 flex-shrink-0" />
                        <span className="font-medium">{item.name}</span>
                        {item.badgeCount !== undefined &&
                          item.badgeCount > 0 && (
                            <span
                              aria-hidden="true"
                              className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white"
                            >
                              {item.badgeCount > 99
                                ? "99+"
                                : item.badgeCount}
                            </span>
                          )}
                      </Link>
                    ) : (
                      <button
                        onClick={() => {
                          setSidebarOpen(false);
                          item.onClick?.();
                        }}
                        className="w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors text-gray-700 hover:bg-gray-50"
                        type="button"
                      >
                        <Icon className="w-5 h-5 flex-shrink-0" />
                        <span className="font-medium">{item.name}</span>
                      </button>
                    )}
                </li>
              );
            })}
          </ul>
          <button
            aria-label="Close navigation menu"
            className="absolute right-4 top-4 rounded-md p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            type="button"
          >
            <XMarkIcon aria-hidden="true" className="h-6 w-6" />
          </button>
          <span aria-atomic="true" aria-live="polite" className="sr-only">
            {helpNotificationCount > 0
              ? `${helpNotificationCount} Alumni Help requests have updates or need action. `
              : "No Alumni Help updates or actions needed. "}
            {chatUnreadTotal > 0
              ? `${chatUnreadTotal} unread Chat Room ${
                  chatUnreadTotal === 1 ? "message" : "messages"
                }.`
              : "No unread Chat Room messages."}{" "}
            {systemMessageUnreadCount > 0
              ? `${systemMessageUnreadCount} unread System ${
                  systemMessageUnreadCount === 1 ? "Message" : "Messages"
                }.`
              : "No unread System Messages."}
          </span>
        </div>
      </nav>
      <ConfirmLogoutModal
        open={showLogoutConfirm}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={() => {
          setShowLogoutConfirm(false);
          void handleLogout();
        }}
        loading={logoutLoading}
      />
    </>
  );
}
