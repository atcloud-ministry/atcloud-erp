import { useState, useEffect, useId, useRef } from "react";
import ConfirmLogoutModal from "../../components/common/ConfirmLogoutModal";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronDownIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import {
  getAvatarUrlWithCacheBust,
  getAvatarAlt,
} from "../../utils/avatarUtils";
import { useAuth } from "../../hooks/useAuth";
import {
  buildLoginRedirectUrl,
  getPathWithSearch,
} from "../../utils/loginRedirect";

interface User {
  firstName: string;
  lastName: string;
  username: string;
  systemAuthorizationLevel: string;
  gender: "male" | "female";
  avatar: string | null;
}

interface UserDropdownProps {
  user: User | null;
  isGuest?: boolean;
}

export default function UserDropdown({
  user,
  isGuest = false,
}: UserDropdownProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusLastOnOpenRef = useRef(false);
  const menuId = useId();
  const { logout } = useAuth();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const guestLoginHref = buildLoginRedirectUrl(getPathWithSearch(location));

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!dropdownOpen) return;

    const focusFrame = window.requestAnimationFrame(() => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
      );
      const target = focusLastOnOpenRef.current
        ? items[items.length - 1]
        : items[0];
      focusLastOnOpenRef.current = false;
      target?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDropdownOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [dropdownOpen]);

  const openFromKeyboard = (focusLast: boolean) => {
    focusLastOnOpenRef.current = focusLast;
    setDropdownOpen(true);
  };

  const handleTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openFromKeyboard(event.key === "ArrowUp");
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Home") {
      items[0].focus();
      return;
    }
    if (event.key === "End") {
      items[items.length - 1].focus();
      return;
    }
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + offset + items.length) % items.length;
    items[nextIndex].focus();
  };

  const closeWhenFocusLeaves = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropdownOpen(false);
    }
  };

  const handleLogout = async () => {
    try {
      setLogoutLoading(true);
      await logout();
      navigate("/");
    } finally {
      setLogoutLoading(false);
    }
  };

  // Guest dropdown
  if (isGuest) {
    return (
      <div
        className="relative flex-shrink-0"
        onBlur={closeWhenFocusLeaves}
        ref={dropdownRef}
      >
        <button
          aria-controls={menuId}
          aria-expanded={dropdownOpen}
          aria-haspopup="menu"
          aria-label="Guest account menu"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          onKeyDown={handleTriggerKeyDown}
          className="flex min-h-11 min-w-11 items-center space-x-2 rounded-lg p-2 text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:space-x-3"
          ref={triggerRef}
          type="button"
        >
          <UserCircleIcon aria-hidden="true" className="h-8 w-8 text-gray-600" />
          <div className="text-left hidden sm:block">
            <div className="text-sm font-medium text-gray-900">Guest</div>
          </div>
          <ChevronDownIcon aria-hidden="true" className="w-4 h-4 flex-shrink-0" />
        </button>

        {dropdownOpen && (
          <div
            aria-label="Guest account"
            className="absolute right-0 z-50 mt-2 w-48 rounded-md border border-gray-200 bg-white shadow-lg"
            id={menuId}
            onKeyDown={handleMenuKeyDown}
            ref={menuRef}
            role="menu"
          >
            <div className="py-1">
              <Link
                to={guestLoginHref}
                className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
                onClick={() => setDropdownOpen(false)}
                role="menuitem"
                tabIndex={-1}
              >
                Login
              </Link>
              <Link
                to="/signup"
                className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
                onClick={() => setDropdownOpen(false)}
                role="menuitem"
                tabIndex={-1}
              >
                Sign Up
              </Link>
              <Link
                to="/dashboard/donate"
                className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
                onClick={() => setDropdownOpen(false)}
                role="menuitem"
                tabIndex={-1}
              >
                Donate
              </Link>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Authenticated user dropdown
  return (
    <div
      className="relative flex-shrink-0"
      onBlur={closeWhenFocusLeaves}
      ref={dropdownRef}
    >
      <button
        aria-controls={menuId}
        aria-expanded={dropdownOpen}
        aria-haspopup="menu"
        aria-label={`Account menu for ${user!.firstName} ${user!.lastName}`}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        onKeyDown={handleTriggerKeyDown}
        className="flex min-h-11 min-w-11 items-center space-x-2 rounded-lg p-2 text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:space-x-3"
        ref={triggerRef}
        type="button"
      >
        <img
          className="h-8 w-8 rounded-full object-cover"
          src={getAvatarUrlWithCacheBust(user!.avatar, user!.gender)}
          alt={getAvatarAlt(user!.firstName, user!.lastName, !!user!.avatar)}
        />
        <div className="text-left hidden sm:block">
          <div className="text-sm font-medium text-gray-900 truncate max-w-24 lg:max-w-none">
            {user!.firstName} {user!.lastName}
          </div>
          <div className="text-xs text-gray-500">
            {user!.systemAuthorizationLevel}
          </div>
        </div>
        <ChevronDownIcon aria-hidden="true" className="w-4 h-4 flex-shrink-0" />
      </button>

      {/* Dropdown Menu */}
      {dropdownOpen && (
        <div
          aria-label="Account actions"
          className="absolute right-0 z-50 mt-2 w-48 rounded-md border border-gray-200 bg-white shadow-lg"
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
          <div className="py-1">
            <Link
              to="/dashboard/profile"
              className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => setDropdownOpen(false)}
              role="menuitem"
              tabIndex={-1}
            >
              Profile
            </Link>
            <Link
              to="/dashboard/change-password"
              className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => setDropdownOpen(false)}
              role="menuitem"
              tabIndex={-1}
            >
              Change Password
            </Link>
            <Link
              to="/dashboard/notification-settings"
              className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => setDropdownOpen(false)}
              role="menuitem"
              tabIndex={-1}
            >
              Notification Settings
            </Link>
            <Link
              to="/dashboard/promo-codes"
              className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => setDropdownOpen(false)}
              role="menuitem"
              tabIndex={-1}
            >
              My Promo Codes
            </Link>
            <Link
              to="/dashboard/purchase-history"
              className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => setDropdownOpen(false)}
              role="menuitem"
              tabIndex={-1}
            >
              Purchase History
            </Link>
            <Link
              to="/dashboard/donate"
              className="block min-h-11 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => setDropdownOpen(false)}
              role="menuitem"
              tabIndex={-1}
            >
              Donate
            </Link>
            <button
              className="min-h-11 w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600"
              onClick={() => {
                setDropdownOpen(false);
                triggerRef.current?.focus();
                setShowLogoutConfirm(true);
              }}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              Log Out
            </button>
          </div>
        </div>
      )}
      <ConfirmLogoutModal
        open={showLogoutConfirm}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={() => {
          setShowLogoutConfirm(false);
          void handleLogout();
        }}
        loading={logoutLoading}
      />
    </div>
  );
}
