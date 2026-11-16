import { Link, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import ConfirmLogoutModal from "../../components/common/ConfirmLogoutModal";
import {
  CalendarDaysIcon,
  ArrowRightOnRectangleIcon,
  UsersIcon,
  HomeIcon,
  SpeakerWaveIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  AcademicCapIcon,
  Cog6ToothIcon,
  HeartIcon,
  XMarkIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import { useAuth } from "../../hooks/useAuth";
import { useRuntimeConfig } from "../../contexts/RuntimeConfigContext";
import {
  buildLoginRedirectUrl,
  getPathWithSearch,
} from "../../utils/loginRedirect";
import { isMobileBottomNavigationHref } from "./MobileBottomNavigation";

type IconComponent = React.ComponentType<{ className?: string }>;

interface NavLink {
  kind: "link";
  name: string;
  href: string;
  icon?: IconComponent;
  activePathPrefixes?: readonly string[];
  /** Overrides prefix matching when a route needs custom rules. */
  isActive?: (pathname: string) => boolean;
  badgeCount?: number;
  badgeDescription?: string;
}

interface NavAction {
  kind: "action";
  name: string;
  icon: IconComponent;
  onClick: () => void;
}

interface NavGroup {
  kind: "group";
  id: string;
  name: string;
  icon: IconComponent;
  badgeDescription?: string;
  children: NavLink[];
}

type NavEntry = NavLink | NavAction | NavGroup;

interface SidebarProps {
  userRole: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  chatUnreadTotal?: number;
  helpNotificationCount?: number;
  systemMessageUnreadCount?: number;
}

const GROUP_STATE_STORAGE_KEY = "atcloud.sidebar.groups";

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

function readStoredGroupState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(GROUP_STATE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function writeStoredGroupState(state: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(GROUP_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or blocked storage: the menu still works, it just forgets.
  }
}

function isLinkActive(link: NavLink, pathname: string): boolean {
  if (link.isActive) return link.isActive(pathname);
  return (
    pathname === link.href ||
    Boolean(
      link.activePathPrefixes?.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      ),
    )
  );
}

function groupBadgeCount(group: NavGroup): number {
  return group.children.reduce(
    (total, child) => total + (child.badgeCount ?? 0),
    0,
  );
}

function formatBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

const DIRECTORY_BASE = "/dashboard/community/alumni";

export default function Sidebar({
  userRole,
  sidebarOpen,
  setSidebarOpen,
  chatUnreadTotal = 0,
  helpNotificationCount = 0,
  systemMessageUnreadCount = 0,
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { canManageUsers, logout } = useAuth();
  const { config: runtimeConfig, status: runtimeConfigStatus } =
    useRuntimeConfig();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [groupState, setGroupState] = useState(readStoredGroupState);
  const navigationRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const idPrefix = useId();
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
  const pathname = location.pathname.replace(/\/+$/, "") || "/";

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
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement.getAttribute("aria-controls") ===
        "dashboard-primary-navigation"
    ) {
      menuTriggerRef.current = activeElement;
    }
    const menuButton =
      menuTriggerRef.current ??
      document.getElementById("dashboard-mobile-menu-button") ??
      document.getElementById("dashboard-tablet-menu-button");
    const backgroundElements = [
      document.querySelector<HTMLElement>("header"),
      document.getElementById("dashboard-main-content"),
      document.getElementById("dashboard-mobile-bottom-navigation"),
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
      menuTriggerRef.current = null;
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

  const isAdmin = userRole === "Super Admin" || userRole === "Administrator";
  const isLeader = userRole === "Leader";
  const isMember =
    isAdmin || isLeader || userRole === "Participant" || userRole === "Guest Expert";

  const programsGroup: NavGroup = {
    kind: "group",
    id: "programs",
    name: "Programs",
    icon: AcademicCapIcon,
    children: [
      {
        kind: "link",
        name: "EMBA Program",
        href: "/dashboard/emba-program",
        isActive: (path) =>
          path === "/dashboard/emba-program" || path === "/dashboard",
      },
      {
        kind: "link",
        name: "Other Programs",
        href: "/dashboard/programs",
        activePathPrefixes: ["/dashboard/programs"],
      },
      {
        kind: "link",
        name: "Annual Membership",
        href: "/dashboard/annual-memberships",
        activePathPrefixes: ["/dashboard/annual-memberships"],
      },
    ],
  };

  const buildNavigation = (): { primary: NavEntry[]; secondary: NavEntry[] } => {
    const welcome: NavLink = {
      kind: "link",
      name: "Welcome",
      href: "/dashboard/welcome",
      icon: HomeIcon,
    };

    if (userRole === "guest") {
      return {
        primary: [
          welcome,
          programsGroup,
          {
            kind: "group",
            id: "events",
            name: "Events",
            icon: CalendarDaysIcon,
            children: [
              { kind: "link", name: "Event Calendar", href: "/dashboard/upcoming" },
              { kind: "link", name: "Past Events", href: "/dashboard/passed" },
            ],
          },
        ],
        secondary: [
          { kind: "link", name: "Donate", href: "/dashboard/donate", icon: HeartIcon },
          {
            kind: "link",
            name: "Log In",
            href: guestLoginHref,
            icon: ArrowRightOnRectangleIcon,
          },
        ],
      };
    }

    const eventLinks: NavLink[] = [
      { kind: "link", name: "Event Calendar", href: "/dashboard/upcoming" },
      { kind: "link", name: "Past Events", href: "/dashboard/passed" },
      { kind: "link", name: "My Events", href: "/dashboard/my-events" },
    ];
    if (isAdmin || isLeader) {
      eventLinks.push({
        kind: "link",
        name: "Published Events",
        href: "/dashboard/published-events",
      });
    }
    if (isMember) {
      eventLinks.push({
        kind: "link",
        name: "Create Event",
        href: "/dashboard/new-event",
      });
    }
    if (isAdmin || isLeader) {
      eventLinks.push({
        kind: "link",
        name: "Role Templates",
        href: "/dashboard/configure-roles-templates",
      });
    }

    const primary: NavEntry[] = [
      welcome,
      programsGroup,
      {
        kind: "group",
        id: "events",
        name: "Events",
        icon: CalendarDaysIcon,
        children: eventLinks,
      },
    ];

    if (communityNavigationEnabled) {
      primary.push({
        kind: "group",
        id: "community",
        name: "Alumni Community",
        icon: UsersIcon,
        badgeDescription: "help request updates and unread chat messages",
        children: [
          {
            kind: "link",
            name: "Alumni Directory",
            href: DIRECTORY_BASE,
            isActive: (path) =>
              path === "/dashboard/community" ||
              path === DIRECTORY_BASE ||
              (path.startsWith(`${DIRECTORY_BASE}/`) &&
                path !== `${DIRECTORY_BASE}/me`),
          },
          {
            kind: "link",
            name: "My Alumni Profile",
            href: `${DIRECTORY_BASE}/me`,
          },
          {
            kind: "link",
            name: "Help Requests",
            href: "/dashboard/community/help-requests",
            activePathPrefixes: ["/dashboard/community/help-requests"],
            badgeCount: helpNotificationCount,
            badgeDescription: "requests with updates or actions needed",
          },
          {
            kind: "link",
            name: "Chats",
            href: "/dashboard/chat-rooms",
            activePathPrefixes: ["/dashboard/chat-rooms"],
            badgeCount: chatUnreadTotal,
            badgeDescription:
              chatUnreadTotal === 1 ? "unread message" : "unread messages",
          },
          {
            kind: "link",
            name: "Members",
            href: "/dashboard/community/members",
          },
        ],
      });
    } else if (isLeader || (isMember && !isAdmin)) {
      primary.push({
        kind: "link",
        name: "Community",
        href: "/dashboard/management",
        icon: UsersIcon,
      });
    }

    if (isAdmin) {
      const adminLinks: NavLink[] = [];
      if (communityNavigationEnabled) {
        if (canManageUsers) {
          adminLinks.push({
            kind: "link",
            name: "User Management",
            href: "/dashboard/admin/users",
            activePathPrefixes: ["/dashboard/admin/users"],
          });
        }
      } else {
        adminLinks.push({
          kind: "link",
          name: "Management",
          href: "/dashboard/management",
        });
      }
      adminLinks.push(
        {
          kind: "link",
          name: "Promo Codes",
          href: "/dashboard/admin/promo-codes",
          activePathPrefixes: ["/dashboard/admin/promo-codes"],
        },
        { kind: "link", name: "Income History", href: "/dashboard/income-history" },
        { kind: "link", name: "Analytics", href: "/dashboard/analytics" },
        { kind: "link", name: "Audit Logs", href: "/dashboard/audit-logs" },
      );
      if (userRole === "Super Admin") {
        adminLinks.push({
          kind: "link",
          name: "System Monitor",
          href: "/dashboard/monitor",
        });
      }
      primary.push({
        kind: "group",
        id: "admin",
        name: "Administration",
        icon: Cog6ToothIcon,
        children: adminLinks,
      });
    } else if (isMember) {
      primary.push({
        kind: "link",
        name: "Analytics",
        href: "/dashboard/analytics",
        icon: ChartBarIcon,
      });
    }

    const secondary: NavEntry[] = [
      {
        kind: "link",
        name: "System Messages",
        href: "/dashboard/system-messages",
        icon: SpeakerWaveIcon,
        badgeCount: systemMessageUnreadCount,
      },
      {
        kind: "link",
        name: "Feedback",
        href: "/dashboard/feedback",
        icon: ChatBubbleLeftRightIcon,
      },
      { kind: "link", name: "Donate", href: "/dashboard/donate", icon: HeartIcon },
      {
        kind: "action",
        name: "Log Out",
        icon: ArrowRightOnRectangleIcon,
        onClick: () => setShowLogoutConfirm(true),
      },
    ];

    return { primary, secondary };
  };

  const { primary, secondary } = buildNavigation();
  const allGroups = primary.filter(
    (entry): entry is NavGroup => entry.kind === "group",
  );
  const activeGroupId = allGroups.find((group) =>
    group.children.some((child) => isLinkActive(child, pathname)),
  )?.id;

  // Opening a page inside a collapsed section reveals where you are.
  useEffect(() => {
    if (!activeGroupId) return;
    setGroupState((current) => {
      if (current[activeGroupId]) return current;
      const next = { ...current, [activeGroupId]: true };
      writeStoredGroupState(next);
      return next;
    });
  }, [activeGroupId]);

  const toggleGroup = (id: string) => {
    setGroupState((current) => {
      const next = { ...current, [id]: !current[id] };
      writeStoredGroupState(next);
      return next;
    });
  };

  const closeOnNavigate = () => setSidebarOpen(false);

  const renderBadge = (count: number | undefined) =>
    count !== undefined && count > 0 ? (
      <span
        aria-hidden="true"
        className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-px text-[11px] font-semibold leading-4 text-white tabular-nums"
      >
        {formatBadge(count)}
      </span>
    ) : null;

  const linkLabel = (link: NavLink) =>
    link.badgeCount && link.badgeCount > 0
      ? `${link.name}, ${link.badgeCount} ${link.badgeDescription ?? "unread messages"}`
      : undefined;

  const activePill = (
    <motion.span
      aria-hidden="true"
      className="absolute inset-0 -z-10 rounded-lg bg-white shadow-sm ring-1 ring-gray-200/80"
      layoutId="sidebar-active-pill"
      transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.8 }}
    />
  );

  const renderTopLink = (link: NavLink) => {
    const Icon = link.icon;
    const active = isLinkActive(link, pathname);
    return (
      <li
        className={
          isMobileBottomNavigationHref(link.href) ? "hidden md:list-item" : undefined
        }
        key={link.name}
      >
        <Link
          aria-current={active ? "page" : undefined}
          aria-label={linkLabel(link)}
          className={`group relative isolate flex items-center gap-3 rounded-lg px-3 py-2 text-[0.9375rem] font-medium transition-colors duration-150 ${
            active
              ? "text-brand-800"
              : "text-gray-600 hover:bg-gray-200/50 hover:text-gray-900"
          }`}
          onClick={closeOnNavigate}
          to={link.href}
        >
          {active && activePill}
          {Icon && (
            <Icon
              className={`h-[1.125rem] w-[1.125rem] shrink-0 transition-colors ${
                active ? "text-brand-600" : "text-gray-400 group-hover:text-gray-600"
              }`}
            />
          )}
          <span className="truncate">{link.name}</span>
          {renderBadge(link.badgeCount)}
        </Link>
      </li>
    );
  };

  const renderAction = (action: NavAction) => {
    const Icon = action.icon;
    return (
      <li key={action.name}>
        <button
          className="group flex w-full items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-[0.9375rem] font-medium text-gray-600 transition-colors hover:bg-gray-200/50 hover:text-gray-900"
          onClick={() => {
            setSidebarOpen(false);
            action.onClick();
          }}
          type="button"
        >
          <Icon className="h-[1.125rem] w-[1.125rem] shrink-0 text-gray-400 transition-colors group-hover:text-gray-600" />
          <span>{action.name}</span>
        </button>
      </li>
    );
  };

  const renderGroup = (group: NavGroup) => {
    const Icon = group.icon;
    const open = Boolean(groupState[group.id]);
    const containsActive = group.id === activeGroupId;
    const badge = groupBadgeCount(group);
    const panelId = `${idPrefix}-${group.id}`;
    const collapsedBadge = !open && badge > 0;

    return (
      <li key={group.id}>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={
            collapsedBadge
              ? `${group.name}, ${badge} ${group.badgeDescription ?? "updates"}`
              : undefined
          }
          className={`group flex w-full items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-[0.9375rem] font-medium transition-colors hover:bg-gray-200/50 ${
            containsActive ? "text-gray-900" : "text-gray-600 hover:text-gray-900"
          }`}
          onClick={() => toggleGroup(group.id)}
          type="button"
        >
          <Icon
            className={`h-[1.125rem] w-[1.125rem] shrink-0 transition-colors ${
              containsActive ? "text-brand-600" : "text-gray-400 group-hover:text-gray-600"
            }`}
          />
          <span className="truncate">{group.name}</span>
          {collapsedBadge ? renderBadge(badge) : <span className="ml-auto" />}
          <ChevronRightIcon
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 ease-out-expo ${
              open ? "rotate-90" : ""
            }`}
          />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              animate={{ height: "auto", opacity: 1 }}
              className="overflow-hidden"
              exit={{ height: 0, opacity: 0 }}
              id={panelId}
              initial={{ height: 0, opacity: 0 }}
              key="panel"
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            >
              <ul className="relative ml-[1.3rem] mt-0.5 space-y-px border-l border-gray-200 pb-1 pl-3">
                {group.children.map((child) => {
                  const active = isLinkActive(child, pathname);
                  return (
                    <li
                      className={
                        isMobileBottomNavigationHref(child.href)
                          ? "hidden md:list-item"
                          : undefined
                      }
                      key={child.name}
                    >
                      <Link
                        aria-current={active ? "page" : undefined}
                        aria-label={linkLabel(child)}
                        className={`relative isolate flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors duration-150 ${
                          active
                            ? "font-semibold text-brand-800"
                            : "font-medium text-gray-500 hover:bg-gray-200/50 hover:text-gray-900"
                        }`}
                        onClick={closeOnNavigate}
                        to={child.href}
                      >
                        {active && activePill}
                        {active && (
                          <span
                            aria-hidden="true"
                            className="absolute -left-[0.8125rem] top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand-500"
                          />
                        )}
                        <span className="truncate">{child.name}</span>
                        {renderBadge(child.badgeCount)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </li>
    );
  };

  const renderEntry = (entry: NavEntry) => {
    if (entry.kind === "group") return renderGroup(entry);
    if (entry.kind === "action") return renderAction(entry);
    return renderTopLink(entry);
  };

  return (
    <>
      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            animate={{ opacity: 1 }}
            aria-hidden="true"
            className="fixed inset-0 z-50 bg-gray-950/40 backdrop-blur-[2px] md:z-30 lg:hidden"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
            transition={{ duration: 0.2 }}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <nav
        aria-hidden={!navigationVisible}
        aria-label="Primary navigation"
        className={`
          fixed inset-x-0 bottom-0 z-[60] max-h-[85dvh]
          rounded-t-2xl border-t border-gray-200 bg-gray-50 shadow-xl
          transform transition-transform duration-300 ease-out-expo
          md:inset-y-0 md:left-0 md:right-auto md:bottom-auto md:h-full md:max-h-none md:w-64
          md:rounded-none md:border-r md:border-t-0 md:shadow-none lg:z-40 lg:translate-x-0
          ${
            sidebarOpen
              ? "translate-y-0 md:translate-x-0"
              : "translate-y-full md:translate-y-0 md:-translate-x-full"
          }
        `}
        id="dashboard-primary-navigation"
        inert={!navigationVisible ? true : undefined}
        ref={navigationRef}
        tabIndex={-1}
      >
        <div className="flex max-h-[inherit] flex-col overflow-y-auto px-3 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] pt-12 md:h-full md:max-h-none md:pb-4 md:pt-20">
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-gray-300 md:hidden"
          />
          <p className="absolute left-5 top-4 font-display text-lg font-semibold text-gray-900 md:hidden">
            Menu
          </p>
          <LayoutGroup id="sidebar">
            <ul className="space-y-0.5">{primary.map(renderEntry)}</ul>
            <div className="mt-auto pt-6">
              <div className="mx-3 mb-3 border-t border-gray-200" />
              <ul className="space-y-0.5">{secondary.map(renderEntry)}</ul>
            </div>
          </LayoutGroup>
          <button
            aria-label="Close navigation menu"
            className="absolute right-3 top-3 rounded-full border-0 bg-transparent p-2 text-gray-500 hover:bg-gray-200/60 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            type="button"
          >
            <XMarkIcon aria-hidden="true" className="h-5 w-5" />
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
