import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";
import UserDropdown from "./UserDropdown";
import { NotificationDropdown } from "../../components/common";

interface User {
  firstName: string;
  lastName: string;
  username: string;
  systemAuthorizationLevel: string;
  gender: "male" | "female";
  avatar: string | null;
}

interface HeaderProps {
  user: User | null;
  isGuest?: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

export default function Header({
  user,
  isGuest = false,
  sidebarOpen,
  setSidebarOpen,
}: HeaderProps) {
  return (
    <header className="fixed left-0 right-0 top-0 z-50 border-b border-gray-200/80 bg-white/85 backdrop-blur-md backdrop-saturate-150">
      <div className="w-full max-w-none px-4 sm:px-6 lg:px-5">
        <div className="flex h-16 min-w-0 items-center justify-between">
          {/* Left section: Mobile menu button + Logo */}
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            {/* Mobile menu button */}
            <button
              aria-controls="dashboard-primary-navigation"
              aria-expanded={sidebarOpen}
              aria-label={
                sidebarOpen ? "Close navigation menu" : "Open navigation menu"
              }
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="hidden flex-shrink-0 rounded-full border-0 bg-transparent p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 md:inline-flex lg:hidden"
              id="dashboard-tablet-menu-button"
              type="button"
            >
              {sidebarOpen ? (
                <XMarkIcon aria-hidden="true" className="h-6 w-6" />
              ) : (
                <Bars3Icon aria-hidden="true" className="h-6 w-6" />
              )}
            </button>

            {/* Logo and Organization */}
            <Link
              className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-gray-900 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              to="/dashboard/welcome"
            >
              <img
                src="/@Cloud.jpg"
                alt="@Cloud Logo"
                className="h-8 w-8 flex-shrink-0 object-contain transition-transform duration-500 ease-out-expo group-hover:-translate-y-0.5 sm:h-9 sm:w-9"
              />
              <div className="min-w-0 truncate leading-tight">
                <span className="hidden font-display text-[1.0625rem] font-semibold tracking-tight sm:inline">
                  @Cloud{" "}
                  <span className="font-normal text-gray-500">
                    Marketplace Ministry
                  </span>
                </span>
                <span className="font-display text-base font-semibold sm:hidden">
                  @Cloud
                </span>
              </div>
            </Link>
          </div>

          {/* Right section: Notifications + User Avatar and Dropdown */}
          <div className="ml-2 flex flex-shrink-0 items-center gap-1.5 sm:gap-3">
            {!isGuest && <NotificationDropdown />}
            <UserDropdown user={user} isGuest={isGuest} />
          </div>
        </div>
      </div>
    </header>
  );
}
