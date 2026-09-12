import { useState } from "react";
import { useLocation, Outlet, Navigate } from "react-router-dom";
import { Header, Sidebar } from "./dashboard";
import { Footer } from "../components/common";
import ProfileCompletionNotice from "../components/profile/ProfileCompletionNotice";
import { useAuth } from "../hooks/useAuth";
import LoadingSpinner from "../components/common/LoadingSpinner";
import { useOptionalChatRooms } from "../contexts/ChatRoomsContext";
import AuthInitializationError from "../components/common/AuthInitializationError";
import { useOptionalNotifications } from "../contexts/NotificationContext";

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
  const {
    currentUser,
    isLoading,
    initializationError,
    retryInitialization,
  } = useAuth();
  const chatUnreadTotal = useOptionalChatRooms()?.chatUnreadTotal ?? 0;
  const systemMessageUnreadCount =
    useOptionalNotifications()?.systemMessageUnreadCount ?? 0;
  const location = useLocation();

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

  // Redirect to login if guest tries to access a non-allowed route
  if (isGuest && !isGuestAllowedRoute(location.pathname)) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
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
          systemMessageUnreadCount={systemMessageUnreadCount}
        />

        {/* Scrollable Main Content */}
        <main
          className="flex-1 overflow-y-auto lg:ml-64 flex flex-col pt-16"
          key={`main-${location.pathname}`}
        >
          {/** Allow wider content specifically on Management page to fit all table columns */}
          <div
            className={`flex-1 p-4 sm:p-6 pb-0 ${
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
            <Outlet key={location.pathname} />
          </div>
          <div className="mt-8">
            <Footer />
          </div>
        </main>
      </div>
    </div>
  );
}
