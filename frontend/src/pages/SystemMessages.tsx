import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useNotifications } from "../contexts/NotificationContext";
import { useAuth } from "../hooks/useAuth";
import { useAvatarUpdates } from "../hooks/useAvatarUpdates";
import { Icon } from "../components/common";
import ConfirmationModal from "../components/common/ConfirmationModal";
import AlertModal from "../components/common/AlertModal";
import Pagination from "../components/common/Pagination";
import MessageListHeader from "../components/SystemMessages/MessageListHeader";
import CreateMessageModal, {
  type MessageFormData,
} from "../components/SystemMessages/CreateMessageModal";
import MessageListItem from "../components/SystemMessages/MessageListItem";
import { systemMessageService } from "../services/systemMessageService";
import type { SystemMessage } from "../types/notification";

export default function SystemMessages() {
  const { systemMessages, markSystemMessageAsRead, reloadSystemMessages } =
    useNotifications();
  const { hasRole, currentUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Listen for real-time avatar updates to refresh message sender avatars
  const avatarUpdateCounter = useAvatarUpdates();

  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    isOpen: boolean;
    messageId: string;
    messageTitle: string;
  }>({
    isOpen: false,
    messageId: "",
    messageTitle: "",
  });

  const [alertModal, setAlertModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: "success" | "error" | "warning" | "info";
  }>({
    isOpen: false,
    title: "",
    message: "",
    type: "info",
  });

  // Helper function to show alert
  const showAlert = (
    title: string,
    message: string,
    type: "success" | "error" | "warning" | "info" = "info"
  ) => {
    setAlertModal({
      isOpen: true,
      title,
      message,
      type,
    });
  };

  // Local paginated state pulled from backend
  const [pagedMessages, setPagedMessages] = useState<SystemMessage[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(20);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(
    async (page: number) => {
      setLoading(true);
      try {
        const { messages, pagination } =
          await systemMessageService.getSystemMessagesPaginated({
            page,
            limit: pageSize,
          });
        setPagedMessages(messages);
        setCurrentPage(pagination.currentPage);
        setTotalCount(pagination.totalCount);
        setTotalPages(pagination.totalPages);
      } finally {
        setLoading(false);
      }
    },
    [pageSize]
  );

  useEffect(() => {
    loadPage(1);
  }, [loadPage]);

  // When global system messages change (e.g., via WebSocket), refresh current page
  useEffect(() => {
    if (systemMessages) {
      loadPage(currentPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemMessages?.length]);

  // Reload messages when avatars are updated
  useEffect(() => {
    if (avatarUpdateCounter > 0) {
      loadPage(currentPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarUpdateCounter]);

  // Filter system messages - auth level changes only for current user, others for all
  const filteredSystemMessages = useMemo(
    () =>
      pagedMessages
        .filter((message) => {
          if (message.type === "auth_level_change") {
            // Show auth level change messages to:
            // 1. The target user (when targetUserId matches current user)
            // 2. Admin users (for oversight purposes, regardless of targetUserId)
            const isTargetUser = message.targetUserId === currentUser?.id;
            const isAdmin =
              currentUser?.role === "Administrator" ||
              currentUser?.role === "Super Admin";
            const shouldShow = isTargetUser || isAdmin;
            return shouldShow;
          }

          if (message.type === "user_management") {
            // Admin-only visibility for user management messages
            return (
              currentUser?.role === "Administrator" ||
              currentUser?.role === "Super Admin"
            );
          }

          if (message.type === "atcloud_role_change") {
            // Only show @Cloud role change notifications to admin users for oversight
            return (
              currentUser?.role === "Administrator" ||
              currentUser?.role === "Super Admin"
            );
          }

          if (message.type === "event_role_change") {
            // Show event role change messages to:
            // 1. The target user (when targetUserId matches current user)
            // 2. Admin users (for oversight purposes, regardless of targetUserId)
            const isTargetUser = message.targetUserId === currentUser?.id;
            const isAdmin =
              currentUser?.role === "Administrator" ||
              currentUser?.role === "Super Admin";
            const shouldShow = isTargetUser || isAdmin;
            return shouldShow;
          }

          // Show all other system messages to everyone (including real security alerts)
          return true;
        })
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ),
    [pagedMessages, currentUser?.id, currentUser?.role]
  );

  // Handle URL hash navigation to scroll to specific message
  useEffect(() => {
    if (location.hash) {
      const messageId = location.hash.substring(1); // Remove the # symbol
      const messageElement = document.getElementById(messageId);
      if (messageElement) {
        // Scroll to the message
        messageElement.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });

        // Mark the message as read if it's not already
        const message = filteredSystemMessages.find((m) => m.id === messageId);
        if (message && !message.isRead) {
          markSystemMessageAsRead(messageId);
        }

        // Add a brief highlight effect
        messageElement.classList.add(
          "ring-2",
          "ring-blue-500",
          "ring-opacity-75"
        );
        setTimeout(() => {
          messageElement.classList.remove(
            "ring-2",
            "ring-blue-500",
            "ring-opacity-75"
          );
        }, 2000);

        // Clear the hash after handling to prevent re-triggering
        // Use react-router navigate so location.hash updates and effect doesn't re-run
        navigate(location.pathname, { replace: true });
      }
    }
  }, [
    location.hash,
    filteredSystemMessages,
    markSystemMessageAsRead,
    navigate,
    location.pathname,
  ]);

  // Check if current user can navigate to other user profiles
  const canNavigateToProfiles =
    currentUser?.role === "Super Admin" ||
    currentUser?.role === "Administrator" ||
    currentUser?.role === "Leader";

  const canCreateSystemMessages =
    hasRole("Super Admin") || hasRole("Administrator");

  // Get the correct profile link (matching EventDetail and Management page logic)
  const getProfileLink = (userId: string) => {
    const currentUserId =
      currentUser?.id || "550e8400-e29b-41d4-a716-446655440000";
    return userId === currentUserId
      ? "/dashboard/profile" // Own profile page (editable)
      : `/dashboard/profile/${userId}`; // View-only profile page
  };

  // Handle name card click - direct navigation with role-based authorization
  const handleNameCardClick = (userId: string) => {
    const currentUserId =
      currentUser?.id || "550e8400-e29b-41d4-a716-446655440000";

    // If clicking on self, always allow navigation to own profile
    if (userId === currentUserId) {
      navigate(getProfileLink(userId));
      return;
    }

    // Only Super Admin, Administrator, and Leader can view other users' profiles
    // Guest Expert and Participant cannot (name cards should not be clickable for them)
    if (canNavigateToProfiles) {
      navigate(getProfileLink(userId));
    }
    // If not authorized, do nothing (name card should not be clickable anyway)
  };

  const handleSendMessage = async (
    formData: MessageFormData,
    targetRoles?: string[]
  ) => {
    try {
      // Call the actual service to create the system message
      await systemMessageService.createSystemMessage({
        title: formData.title,
        content: formData.content,
        type: formData.type,
        priority: formData.priority,
        includeCreator: formData.includeCreator,
        targetRoles: targetRoles,
      });

      // Reload messages to show the new one
      await loadPage(currentPage);
      await reloadSystemMessages();

      // Show success message based on target
      const getRecipientDisplayText = (roles: string[]): string => {
        if (
          roles.includes("Super Admin") &&
          roles.includes("Administrator") &&
          roles.length === 2
        ) {
          return "admins";
        }
        if (
          roles.includes("Super Admin") &&
          roles.includes("Administrator") &&
          roles.includes("Leader") &&
          roles.length === 3
        ) {
          return "@Cloud co-workers";
        }
        if (roles.length === 1) {
          if (roles[0] === "Guest Expert") {
            return "Guest Experts";
          }
          if (roles[0] === "Participant") {
            return "Participants";
          }
        }
        return "selected users";
      };

      const recipientText = targetRoles
        ? getRecipientDisplayText(targetRoles)
        : "all users";

      setShowCreateForm(false);

      showAlert(
        "Success",
        `System message sent to ${recipientText} successfully!`,
        "success"
      );
    } catch (error) {
      console.error("Error creating system message:", error);
      showAlert(
        "Error",
        "Failed to create system message. Please try again.",
        "error"
      );
    }
  };

  const handleCancel = () => {
    setShowCreateForm(false);
  };

  const handleMessageClick = (messageId: string) => {
    markSystemMessageAsRead(messageId);
    // Optimistically update local paged state
    setPagedMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? { ...m, isRead: true, readAt: new Date().toISOString() }
          : m
      )
    );
  };

  const handleDeleteMessage = (e: React.MouseEvent, messageId: string) => {
    e.stopPropagation(); // Prevent triggering the message click
    const message = filteredSystemMessages.find((m) => m.id === messageId);
    setDeleteConfirmation({
      isOpen: true,
      messageId,
      messageTitle: message?.title || "this system message",
    });
  };

  const confirmDeleteMessage = async () => {
    try {
      await systemMessageService.deleteSystemMessage(
        deleteConfirmation.messageId
      );
      await reloadSystemMessages(); // Keep bell dropdown/state in sync
      await loadPage(currentPage); // Refresh current page to reflect deletion and totals
      setDeleteConfirmation({
        isOpen: false,
        messageId: "",
        messageTitle: "",
      });
      showAlert("System message deleted successfully", "success");
    } catch (error) {
      console.error("Failed to delete system message:", error);
      showAlert("Failed to delete system message", "error");
    }
  };

  const cancelDeleteMessage = () => {
    setDeleteConfirmation({
      isOpen: false,
      messageId: "",
      messageTitle: "",
    });
  };

  const formatDate = (dateString: string) => {
    // Parse date string safely to avoid timezone issues
    let date: Date;

    if (dateString.includes("T")) {
      // If it's an ISO string, use it directly (for timestamps)
      date = new Date(dateString);
    } else if (dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
      // If it's YYYY-MM-DD format, parse manually to avoid timezone shift
      const [year, month, day] = dateString.split("-").map(Number);
      date = new Date(year, month - 1, day); // month is 0-indexed
    } else {
      // Fallback to regular parsing for other formats
      date = new Date(dateString);
    }

    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <MessageListHeader
        hasCreatePermission={canCreateSystemMessages}
        onCreateClick={() => setShowCreateForm(true)}
      />

      {/* Stats */}
      {totalCount > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>
              {/* Unread count is approximate on page; full count from backend is optional */}
            </span>
            <span>
              {totalCount} total message{totalCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}

      {/* Top Pagination controls (no container background) */}
      {totalPages > 1 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          hasNext={currentPage < totalPages && !loading}
          hasPrev={currentPage > 1 && !loading}
          onPageChange={loadPage}
          showPageNumbers={false}
          size="md"
          variant="default"
        />
      )}

      {/* Messages List */}
      <div className="space-y-4">
        {loading ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <p className="text-gray-500">Loading system messages…</p>
          </div>
        ) : filteredSystemMessages.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <Icon
              name="mail"
              className="w-12 h-12 mx-auto mb-4 text-gray-300"
            />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No system messages
            </h3>
            <p className="text-gray-500">
              You're all caught up! Check back later for system updates.
            </p>
          </div>
        ) : (
          filteredSystemMessages.map((message) => (
            <MessageListItem
              key={message.id}
              message={message}
              currentUserId={currentUser?.id}
              canNavigateToProfiles={canNavigateToProfiles}
              avatarUpdateCounter={avatarUpdateCounter}
              onMessageClick={handleMessageClick}
              onDeleteMessage={handleDeleteMessage}
              onNameCardClick={handleNameCardClick}
              formatDate={formatDate}
            />
          ))
        )}
      </div>

      {/* Bottom Pagination controls (no container background) */}
      {totalPages > 1 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          hasNext={currentPage < totalPages && !loading}
          hasPrev={currentPage > 1 && !loading}
          onPageChange={loadPage}
          showPageNumbers={false}
          size="md"
          variant="default"
        />
      )}

      <CreateMessageModal
        isOpen={canCreateSystemMessages && showCreateForm}
        currentUser={currentUser}
        onClose={handleCancel}
        onSendMessage={handleSendMessage}
        onNameCardClick={handleNameCardClick}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={deleteConfirmation.isOpen}
        onClose={cancelDeleteMessage}
        onConfirm={confirmDeleteMessage}
        title="Delete System Message"
        message={`Are you sure you want to delete "${deleteConfirmation.messageTitle}"?\n\nThis action cannot be undone.`}
        confirmText="Delete Message"
        type="danger"
      />

      {/* Alert Modal */}
      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={() => setAlertModal({ ...alertModal, isOpen: false })}
        title={alertModal.title}
        message={alertModal.message}
        type={alertModal.type}
      />
    </div>
  );
}
