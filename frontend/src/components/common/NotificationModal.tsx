import { useId } from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "../../hooks/useAccessibleDialog";
import Icon from "./Icon";

interface NotificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  type?: "success" | "error" | "warning" | "info";
  actionButton?: {
    text: string;
    onClick: () => void;
    variant?: "primary" | "secondary";
  };
  // Support for multiple action buttons
  actionButtons?: Array<{
    text: string;
    onClick: () => void;
    variant?: "primary" | "secondary";
  }>;
  showCloseButton?: boolean;
  closeButtonText?: string;
  // autoClose props removed per new requirement (modal persists until user clicks)
}

export default function NotificationModal({
  isOpen,
  onClose,
  title,
  message,
  type = "info",
  actionButton,
  actionButtons,
  showCloseButton = true,
  closeButtonText,
}: NotificationModalProps) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useAccessibleDialog(isOpen, onClose);

  if (!isOpen) return null;

  const getTypeStyles = () => {
    switch (type) {
      case "success":
        return {
          icon: "check-circle" as const,
          iconColor: "text-green-600",
          borderColor: "border-green-200",
          bgColor: "bg-green-50",
          titleColor: "text-green-900",
          textColor: "text-green-700",
          buttonColor: "!bg-green-700 hover:!bg-green-800",
        };
      case "error":
        return {
          icon: "x-circle" as const,
          iconColor: "text-red-600",
          borderColor: "border-red-200",
          bgColor: "bg-red-50",
          titleColor: "text-red-900",
          textColor: "text-red-700",
          buttonColor: "!bg-red-600 hover:!bg-red-700",
        };
      case "warning":
        return {
          icon: "x-circle" as const, // Using x-circle since exclamation-triangle is not available
          iconColor: "text-yellow-700",
          borderColor: "border-yellow-200",
          bgColor: "bg-yellow-50",
          titleColor: "text-yellow-900",
          textColor: "text-yellow-800",
          buttonColor: "!bg-yellow-700 hover:!bg-yellow-800",
        };
      case "info":
      default:
        return {
          icon: "chat-bubble" as const, // Using chat-bubble for info
          iconColor: "text-blue-600",
          borderColor: "border-blue-200",
          bgColor: "bg-blue-50",
          titleColor: "text-blue-900",
          textColor: "text-blue-700",
          buttonColor: "!bg-blue-600 hover:!bg-blue-700",
        };
    }
  };

  const styles = getTypeStyles();

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto bg-black bg-opacity-50 p-4">
      <div
        aria-describedby={messageId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-lg border-2 bg-white shadow-xl ${styles.borderColor} ${styles.bgColor} animate-slide-in`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="p-6">
          <div className="flex items-start">
            <div aria-hidden="true" className={`flex-shrink-0 ${styles.iconColor}`}>
              <Icon name={styles.icon} className="w-6 h-6" />
            </div>
            <div className="ml-3 flex-1">
              <h2
                className={`text-lg font-semibold ${styles.titleColor} mb-2`}
                id={titleId}
              >
                {title}
              </h2>
              <p
                className={`text-sm ${styles.textColor} leading-relaxed whitespace-pre-wrap`}
                id={messageId}
              >
                {message}
              </p>
            </div>
            {showCloseButton && (
              <button
                aria-label="Close notification"
                onClick={onClose}
                className="ml-4 flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center !rounded-lg !border-0 !bg-transparent !p-0 text-gray-600 transition-colors hover:!border-transparent hover:bg-black/5 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                type="button"
              >
                <Icon name="x-mark" className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Action Buttons */}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
            {/* Multiple action buttons (new feature) */}
            {actionButtons &&
              actionButtons.map((button, index) => (
                <button
                  key={index}
                  onClick={() => {
                    button.onClick();
                    onClose();
                  }}
                  className={`min-h-11 w-full !rounded-lg !border-0 !px-4 !py-2 text-sm font-medium transition-colors hover:!border-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:w-auto ${
                    button.variant === "secondary"
                      ? "!bg-gray-100 text-gray-700 hover:!bg-gray-200"
                      : `text-white ${styles.buttonColor}`
                  }`}
                  type="button"
                >
                  {button.text}
                </button>
              ))}
            {/* Single action button (legacy support) */}
            {actionButton && !actionButtons && (
              <button
                onClick={() => {
                  actionButton.onClick();
                  onClose();
                }}
                className={`min-h-11 w-full !rounded-lg !border-0 !px-4 !py-2 text-sm font-medium transition-colors hover:!border-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:w-auto ${
                  actionButton.variant === "secondary"
                    ? "!bg-gray-100 text-gray-700 hover:!bg-gray-200"
                    : `text-white ${styles.buttonColor}`
                }`}
                type="button"
              >
                {actionButton.text}
              </button>
            )}
            <button
              data-dialog-initial-focus
              onClick={onClose}
              className="min-h-11 w-full !rounded-lg !border-0 !bg-gray-100 !px-4 !py-2 text-sm font-medium text-gray-800 transition-colors hover:!border-transparent hover:!bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 sm:w-auto"
              type="button"
            >
              {closeButtonText ??
                (actionButton || actionButtons ? "Cancel" : "OK")}
            </button>
          </div>

          {/* Countdown bar & auto-close removed; modal persists until a button is clicked. */}
        </div>
      </div>
    </div>,
    document.body,
  );
}
