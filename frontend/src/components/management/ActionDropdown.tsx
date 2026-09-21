import {
  ChevronDownIcon,
  EllipsisVerticalIcon,
} from "@heroicons/react/24/outline";
import type { UserAction } from "../../types/management";
import { useRef, useEffect, useId, useState } from "react";

const MENU_WIDTH_PX = 192;
const VIEWPORT_GUTTER_PX = 8;

interface ActionDropdownProps {
  userId: string;
  actions: UserAction[];
  isOpen: boolean;
  onToggle: (userId: string) => void;
  showUpward?: boolean;
  isMobile?: boolean;
  userName?: string;
}

export default function ActionDropdown({
  userId,
  actions,
  isOpen,
  onToggle,
  showUpward = false,
  isMobile = false,
  userName,
}: ActionDropdownProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const focusLastOnOpenRef = useRef(false);
  const onToggleRef = useRef(onToggle);
  const menuId = useId();
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    maxHeight: 0,
    opensUpward: false,
  });

  useEffect(() => {
    onToggleRef.current = onToggle;
  }, [onToggle]);

  // Update dropdown position when it opens
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const preferredLeft = isMobile
        ? rect.left
        : rect.right - MENU_WIDTH_PX;
      const maximumLeft = Math.max(
        VIEWPORT_GUTTER_PX,
        window.innerWidth - MENU_WIDTH_PX - VIEWPORT_GUTTER_PX,
      );
      const availableBelow = Math.max(
        0,
        window.innerHeight - rect.bottom - VIEWPORT_GUTTER_PX,
      );
      const availableAbove = Math.max(
        0,
        rect.top - VIEWPORT_GUTTER_PX,
      );
      const expectedHeight = Math.min(actions.length * 44 + 8, 352);
      const opensUpward =
        showUpward ||
        (availableBelow < expectedHeight && availableAbove > availableBelow);
      setDropdownPosition({
        top: opensUpward
          ? rect.top - VIEWPORT_GUTTER_PX
          : rect.bottom + VIEWPORT_GUTTER_PX,
        left: Math.min(
          Math.max(preferredLeft, VIEWPORT_GUTTER_PX),
          maximumLeft,
        ),
        maxHeight: opensUpward ? availableAbove : availableBelow,
        opensUpward,
      });
    }
  }, [actions.length, isOpen, showUpward, isMobile]);

  useEffect(() => {
    if (!isOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const items = Array.from(
        dropdownRef.current?.querySelectorAll<HTMLElement>(
          "[role='menuitem']:not([disabled])",
        ) ?? [],
      );
      const target = focusLastOnOpenRef.current
        ? items[items.length - 1]
        : items[0];
      focusLastOnOpenRef.current = false;
      (target ?? dropdownRef.current)?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onToggleRef.current(userId);
      window.requestAnimationFrame(() => buttonRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen, userId]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      dropdownRef.current?.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([disabled])",
      ) ?? [],
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

  return (
    <div
      className="inline-block dropdown-container"
      onBlur={(event) => {
        if (
          isOpen &&
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          onToggle(userId);
        }
      }}
    >
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={userName ? `Actions for ${userName}` : "User actions"}
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(userId);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          focusLastOnOpenRef.current = event.key === "ArrowUp";
          if (isOpen) {
            const items = Array.from(
              dropdownRef.current?.querySelectorAll<HTMLElement>(
                "[role='menuitem']:not([disabled])",
              ) ?? [],
            );
            (event.key === "ArrowUp" ? items[items.length - 1] : items[0])?.focus();
          } else {
            onToggle(userId);
          }
        }}
        className={`inline-flex min-h-11 items-center rounded-md border px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 ${
          isMobile ? "w-full justify-center" : ""
        } ${
          isOpen
            ? "border-blue-600 bg-blue-50 text-blue-700"
            : "border-gray-500 bg-white text-gray-700 hover:bg-gray-50"
        }`}
        type="button"
      >
        <EllipsisVerticalIcon aria-hidden="true" className="w-4 h-4 mr-1" />
        Actions
        <ChevronDownIcon
          aria-hidden="true"
          className={`w-4 h-4 ml-1 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          aria-label={userName ? `Actions for ${userName}` : "User actions"}
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          ref={dropdownRef}
          className="fixed z-[9999] max-h-[calc(100vh-1rem)] w-48 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg focus:outline-none"
          role="menu"
          style={{
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            maxHeight: `${dropdownPosition.maxHeight}px`,
            transform: dropdownPosition.opensUpward
              ? "translateY(-100%)"
              : "none",
            pointerEvents: "auto",
          }}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="py-1">
            {actions.length > 0 ? (
              actions.map((action) => (
                <button
                  key={`${userId}-${action.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!action.disabled) {
                      buttonRef.current?.focus();
                      action.onClick();
                      // Close dropdown after action
                      onToggle(userId);
                    }
                  }}
                  disabled={action.disabled}
                  className={`block min-h-11 w-full px-4 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 ${
                    action.className
                  } ${
                    action.disabled
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-gray-100"
                  }`}
                  role="menuitem"
                  tabIndex={-1}
                  type="button"
                >
                  {action.label}
                </button>
              ))
            ) : (
              <div className="px-4 py-2 text-sm text-gray-500">
                No actions available
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
