import { useEffect, useRef, useState } from "react";
import { useLocation, Outlet, Navigate } from "react-router-dom";
import { Header, MobileBottomNavigation, Sidebar } from "./dashboard";
import { Footer } from "../components/common";
import ProfileCompletionNotice from "../components/profile/ProfileCompletionNotice";
import AlumniProfileOnboardingNotice from "../components/profile/AlumniProfileOnboardingNotice";
import { useAuth } from "../hooks/useAuth";
import LoadingSpinner from "../components/common/LoadingSpinner";
import { useOptionalChatRooms } from "../contexts/ChatRoomsContext";
import AuthInitializationError from "../components/common/AuthInitializationError";
import { useOptionalNotifications } from "../contexts/NotificationContext";
import { useOptionalAlumniHelp } from "../contexts/AlumniHelpContext";

/**
 * Routes that unauthenticated "guest" visitors may access.
 * Any other /dashboard/* path redirects to /login.
 */
const GUEST_ALLOWED_PATTERNS: RegExp[] = [
  /^\/dashboard\/?$/i, // index (EMBA Program)
  /^\/dashboard\/welcome\/?$/i,
  /^\/dashboard\/programs\/?$/i,
  /^\/dashboard\/programs\/[^/]+\/?$/i, // program detail
  /^\/dashboard\/emba-program\/?$/i,
  /^\/dashboard\/upcoming\/?$/i,
  /^\/dashboard\/passed\/?$/i,
  /^\/dashboard\/donate\/?$/i,
];

function isGuestAllowedRoute(pathname: string): boolean {
  return GUEST_ALLOWED_PATTERNS.some((p) => p.test(pathname));
}

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const previousPathRef = useRef<string | null>(null);
  const {
    currentUser,
    isLoading,
    initializationError,
    retryInitialization,
  } = useAuth();
  const chatUnreadTotal = useOptionalChatRooms()?.chatUnreadTotal ?? 0;
  const helpNotificationCount =
    useOptionalAlumniHelp()?.helpNotificationCount ?? 0;
  const systemMessageUnreadCount =
    useOptionalNotifications()?.systemMessageUnreadCount ?? 0;
  const location = useLocation();

  useEffect(() => {
    if (
      previousPathRef.current !== null &&
      previousPathRef.current !== location.pathname
    ) {
      setSidebarOpen(false);
      mainRef.current?.focus();
    }
    previousPathRef.current = location.pathname;
  }, [location.pathname]);

  // Show loading spinner while checking authentication
  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (initializationError) {
    return (
      <AuthInitializationError
        message={initializationError}
        onRetry={retryInitialization}
      />
    );
  }

  const isGuest = !currentUser;
  const isOwnProfileRoute = /^\/dashboard\/profile\/?$/i.test(
    location.pathname,
  );
  const isChatRoomRoute = /^\/dashboard\/chat-rooms\/[^/]+\/?$/i.test(
    location.pathname,
  );

  // Redirect to login if guest tries to access a non-allowed route
  if (isGuest && !isGuestAllowedRoute(location.pathname)) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <a
        className="sr-only fixed left-4 top-2 z-[100] rounded-md bg-white px-4 py-2 font-semibold text-blue-800 shadow focus:not-sr-only focus:outline-none focus:ring-2 focus:ring-blue-600"
        href="#dashboard-main-content"
      >
        Skip to main content
      </a>
      {/* Fixed Header */}
      <Header
        user={
          isGuest
            ? null
            : {
                firstName: currentUser.firstName,
                lastName: currentUser.lastName,
                username: currentUser.username,
                systemAuthorizationLevel: currentUser.role,
                gender: currentUser.gender,
                avatar: currentUser.avatar || null,
              }
        }
        isGuest={isGuest}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
      />

      <div className="flex flex-1">
        {/* Fixed Sidebar */}
        <Sidebar
          userRole={isGuest ? "guest" : currentUser.role}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          chatUnreadTotal={chatUnreadTotal}
          helpNotificationCount={helpNotificationCount}
          systemMessageUnreadCount={systemMessageUnreadCount}
        />

        {/* Scrollable Main Content */}
        <main
          className={`flex flex-1 flex-col pt-16 lg:ml-64 ${
            isChatRoomRoute
              ? "h-[100dvh] overflow-hidden lg:h-auto lg:overflow-y-auto"
              : "overflow-y-auto pb-[calc(4rem_+_env(safe-area-inset-bottom))] md:pb-0"
          }`}
          id="dashboard-main-content"
          key={`main-${location.pathname}`}
          ref={mainRef}
          tabIndex={-1}
        >
          {/** Allow wider content specifically on Management page to fit all table columns */}
          <div
            className={`flex-1 ${
              isChatRoomRoute
                ? "flex min-h-0 flex-col overflow-hidden p-0 lg:block lg:overflow-visible lg:p-6 lg:pb-0"
                : "p-4 pb-0 sm:p-6"
            } ${
              location.pathname.startsWith("/dashboard/management") ||
              location.pathname.startsWith("/dashboard/admin/users")
                ? "max-w-[1280px] xl:max-w-[1360px] 2xl:max-w-[1440px]"
                : "max-w-7xl"
            } mx-auto w-full`}
          >
            {!isGuest && !isOwnProfileRoute && (
              <ProfileCompletionNotice
                profile={currentUser}
                className="mb-4"
              />
            )}
            {!isGuest && !isChatRoomRoute && (
              <AlumniProfileOnboardingNotice
                user={currentUser}
                pathname={location.pathname}
              />
            )}
            <Outlet key={location.pathname} />
          </div>
          <div
            className={isChatRoomRoute ? "mt-8 hidden lg:block" : "mt-8"}
            data-testid="dashboard-footer"
          >
            <Footer />
          </div>
        </main>
      </div>
      {!isChatRoomRoute && (
        <MobileBottomNavigation
          chatUnreadTotal={chatUnreadTotal}
          menuOpen={sidebarOpen}
          setMenuOpen={setSidebarOpen}
        />
      )}
    </div>
  );
}
