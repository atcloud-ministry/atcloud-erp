import { useState, useRef, useEffect, useId } from "react";
import { useNavigate } from "react-router-dom";
import { BellIcon } from "@heroicons/react/24/outline";
import { Icon } from "../common";
import { useNotifications } from "../../contexts/NotificationContext";
import { getAlumniHelpRequestPath } from "../../utils/alumniHelpNotification";

type SystemMessageType =
  | "announcement"
  | "maintenance"
  | "update"
  | "warning"
  | "auth_level_change"
  | "user_management"
  | "atcloud_role_change"
  | "event_role_change";

type NotificationType =
  | "system"
  | "SYSTEM_MESSAGE"
  | "management_action"
  | "USER_ACTION";

interface BaseNotification {
  id: string;
  title?: string;
  message?: string;
  type: NotificationType | string;
  systemMessage?: {
    type?: SystemMessageType | string;
    creator?: {
      firstName?: string;
      lastName?: string;
      authLevel?: string;
      roleInAtCloud?: string;
    };
  };
  metadata?: Record<string, unknown>;
}

export default function NotificationDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();
  const navigate = useNavigate();
  const {
    allNotifications,
    totalUnreadCount,
    markAsRead,
    markAllAsRead,
    removeNotification,
    markSystemMessageAsRead,
  } = useNotifications();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsOpen(false);
      bellRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const handleNotificationClick = async (notification: BaseNotification) => {
    try {
      // Mark as read
      if (notification.systemMessage) {
        // This is a system message, mark it as read in the system messages
        await markSystemMessageAsRead(notification.id);
      } else {
        // This is a regular notification
        await markAsRead(notification.id);
      }

      // Navigate based on notification type
      switch (notification.type) {
        case "system":
        case "SYSTEM_MESSAGE":
          navigate(
            getAlumniHelpRequestPath(notification.metadata) ??
              `/dashboard/system-messages#${notification.id}`,
          );
          break;
        case "management_action":
        case "USER_ACTION":
          // Could navigate to a specific page or just mark as read
          break;
        default:
          console.warn("⚠️ Unknown notification type:", notification.type);
          break;
      }

      setIsOpen(false);
    } catch (error) {
      console.error("💥 Error handling notification click:", error);
    }
  };

  const handleDeleteNotification = async (
    e: React.MouseEvent,
    notificationId: string,
  ) => {
    e.stopPropagation(); // Prevent triggering the notification click
    await removeNotification(notificationId);
    window.requestAnimationFrame(() => panelRef.current?.focus());
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMinutes = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60)
    );

    if (diffInMinutes < 1) return "Just now";
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
    return `${Math.floor(diffInMinutes / 1440)}d ago`;
  };

  const getSystemMessageTypeIcon = (
    type: string,
    notification?: Pick<BaseNotification, "title">,
  ) => {
    switch (type) {
      case "announcement":
        return (
          <img
            src="/marketing.svg"
            alt=""
            aria-hidden="true"
            className="w-6 h-6"
            style={{
              filter:
                "brightness(0) saturate(100%) invert(26%) sepia(94%) saturate(6338%) hue-rotate(212deg) brightness(99%) contrast(91%)",
            }}
          />
        );
      case "maintenance":
        return <Icon name="shield-check" className="w-4 h-4 text-orange-700" />;
      case "update":
        return <Icon name="check-circle" className="w-4 h-4 text-green-600" />;
      case "warning":
        return <Icon name="x-circle" className="w-4 h-4 text-red-600" />;
      case "auth_level_change":
        return (
          <img
            src="/permission-management.svg"
            alt=""
            aria-hidden="true"
            className="w-6 h-6"
            style={{
              filter:
                "brightness(0) saturate(100%) invert(52%) sepia(41%) saturate(459%) hue-rotate(74deg) brightness(98%) contrast(90%)",
            }}
          />
        );
      case "user_management": {
        const title = (notification?.title || "").toLowerCase();
        const isRed =
          title.includes("deactivated") || title.includes("deleted");
        const colorClass = isRed ? "text-red-600" : "text-green-600"; // reactivated remains green
        return <Icon name="user" className={`w-4 h-4 ${colorClass}`} />;
      }
      case "atcloud_role_change":
        return <Icon name="tag" className="w-4 h-4 text-purple-600" />;
      case "event_role_change":
        return (
          <img
            src="/change.svg"
            alt=""
            aria-hidden="true"
            className="w-6 h-6"
            style={{
              filter:
                "brightness(0) saturate(100%) invert(41%) sepia(68%) saturate(2557%) hue-rotate(180deg) brightness(95%) contrast(101%)",
            }}
          />
        );
      default:
        return (
          <img
            src="/marketing.svg"
            alt=""
            aria-hidden="true"
            className="w-5 h-5"
            style={{
              filter:
                "brightness(0) saturate(100%) invert(26%) sepia(94%) saturate(6338%) hue-rotate(212deg) brightness(99%) contrast(91%)",
            }}
          />
        );
    }
  };

  const renderNotificationContent = (notification: BaseNotification) => {
    // Check for empty content
    if (!notification.title && !notification.message) {
      console.warn("⚠️ Empty notification detected:", notification);
      return (
        <div className="flex items-start space-x-3">
          <div className="flex-shrink-0">
            <div className="w-8 h-8 bg-red-100 rounded-full flex items-center justify-center">
              <span className="text-red-600 text-xs">!</span>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-600 break-words">
              Empty Notification
            </p>
            <p className="text-sm text-gray-500 break-words leading-relaxed">
              This notification has no content (ID: {notification.id})
            </p>
          </div>
        </div>
      );
    }

    switch (notification.type) {
      case "system":
      case "SYSTEM_MESSAGE":
        // Special handling for auth level change messages
        if (notification.systemMessage?.type === "auth_level_change") {
          return (
            <div className="flex items-start space-x-3">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                  {getSystemMessageTypeIcon("auth_level_change")}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 break-words">
                  {notification.title}
                </p>
                <p className="text-sm text-gray-500 break-words leading-relaxed">
                  System Authorization Level Update
                </p>
              </div>
            </div>
          );
        }

        // Regular system messages with creator info and icon
        return (
          <div className="flex items-start space-x-3">
            <div className="flex-shrink-0">
              <div aria-hidden="true" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center">
                {getSystemMessageTypeIcon(
                  notification.systemMessage?.type || "announcement",
                  notification
                )}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 break-words">
                {notification.title}
              </p>
              <p className="text-sm text-gray-500 break-words leading-relaxed">
                {notification.message
                  ? notification.message.length > 80
                    ? `${notification.message.substring(0, 80)}...`
                    : notification.message
                  : ""}
              </p>
              {notification.systemMessage?.creator && (
                <p className="text-xs text-gray-600 mt-1">
                  From: {notification.systemMessage.creator.firstName}{" "}
                  {notification.systemMessage.creator.lastName}
                  {/* Show both authLevel and roleInAtCloud when available */}
                  {(notification.systemMessage.creator.authLevel ||
                    notification.systemMessage.creator.roleInAtCloud) &&
                    ` • ${[
                      notification.systemMessage.creator.authLevel,
                      notification.systemMessage.creator.roleInAtCloud,
                    ]
                      .filter(Boolean) // Remove null/undefined values
                      .filter(
                        (value, index, array) => array.indexOf(value) === index
                      ) // Remove duplicates
                      .join(" • ")}`}{" "}
                  {/* Use bullet separator */}
                </p>
              )}
            </div>
          </div>
        );

      case "management_action":
      case "USER_ACTION":
        return (
          <div className="flex items-start space-x-3">
            <div className="flex-shrink-0">
              <div aria-hidden="true" className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                <Icon name="user" className="w-4 h-4 text-green-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 break-words">
                {notification.title}
              </p>
              <p className="text-sm text-gray-500 break-words leading-relaxed">
                {notification.message}
              </p>
            </div>
          </div>
        );

      default:
        console.warn("⚠️ Unknown notification type:", notification.type);
        // Fallback rendering for unknown types
        return (
          <div className="flex items-start space-x-3">
            <div className="flex-shrink-0">
              <div aria-hidden="true" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center">
                <Icon name="envelope" className="w-4 h-4 text-gray-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 break-words">
                {notification.title || "Notification"}
              </p>
              <p className="text-sm text-gray-500 break-words leading-relaxed">
                {notification.message || "No content available"}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Type: {notification.type}
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false);
        }
      }}
      ref={dropdownRef}
    >
      {/* Bell Button */}
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={
          totalUnreadCount > 0
            ? `Notifications, ${totalUnreadCount} unread`
            : "Notifications"
        }
        onClick={() => setIsOpen(!isOpen)}
        className="relative flex min-h-11 min-w-11 items-center justify-center p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        ref={bellRef}
        type="button"
      >
        <BellIcon aria-hidden="true" className="w-6 h-6" />
        {totalUnreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 bg-red-600 text-white text-xs font-bold rounded-full h-5 min-w-5 px-1 flex items-center justify-center"
          >
            {totalUnreadCount > 9 ? "9+" : totalUnreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          aria-labelledby={headingId}
          className="fixed left-2 right-2 top-16 z-[60] mt-2 flex max-h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg focus:outline-none sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:w-80"
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900" id={headingId}>
              Notifications
            </h2>
            <div className="flex items-center gap-1">
              {totalUnreadCount > 0 && (
                <button
                  onClick={async () => {
                    await markAllAsRead();
                    setIsOpen(false);
                    window.requestAnimationFrame(() => bellRef.current?.focus());
                  }}
                  className="min-h-11 text-sm text-blue-700 hover:text-blue-900 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                  type="button"
                >
                  Mark all read
                </button>
              )}
              <button
                aria-label="Close notifications"
                className="flex min-h-11 min-w-11 items-center justify-center rounded text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                onClick={() => {
                  setIsOpen(false);
                  window.requestAnimationFrame(() => bellRef.current?.focus());
                }}
                type="button"
              >
                <Icon name="x-mark" className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Notification List */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Responsive height: mobile 16rem (256px), sm+ 20rem (320px), md+ 24rem (384px), lg+ 32rem (512px) */}
            {allNotifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-gray-500">
                <BellIcon aria-hidden="true" className="w-8 h-8 mx-auto mb-2 text-gray-400" />
                <p>No notifications</p>
              </div>
            ) : (
              <ul aria-label="Recent notifications">
                {allNotifications.map((notification) => (
                  <li
                    key={notification.id}
                    className={`px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors duration-200 ${
                      !notification.isRead ? "bg-blue-50" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <button
                        className="min-w-0 flex-1 pr-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                        onClick={() => handleNotificationClick(notification)}
                        type="button"
                      >
                        {renderNotificationContent(notification)}
                        {!notification.isRead && (
                          <span className="sr-only">Unread</span>
                        )}
                      </button>
                      <div className="flex-shrink-0 flex flex-col items-end space-y-1">
                        <span className="text-xs text-gray-600">
                          {formatTime(notification.createdAt)}
                        </span>
                        <div className="flex items-center space-x-1">
                          {!notification.isRead && (
                            <span
                              aria-hidden="true"
                              className="w-2 h-2 bg-blue-600 rounded-full"
                            />
                          )}
                          {/* Remove button - only show for READ notifications */}
                          {notification.isRead && (
                            <button
                              aria-label={`Remove ${
                                notification.title || "notification"
                              }`}
                              onClick={(e) =>
                                handleDeleteNotification(e, notification.id)
                              }
                              className="flex min-h-11 min-w-11 items-center justify-center rounded text-gray-600 transition-colors hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                              type="button"
                            >
                              <Icon name="x-mark" className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
