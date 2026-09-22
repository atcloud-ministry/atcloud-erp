import { useId } from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "../../hooks/useAccessibleDialog";
import Icon from "./Icon";

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  type?: "danger" | "warning" | "info";
  isLoading?: boolean;
}

export default function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText = "Cancel",
  type = "danger",
  isLoading = false,
}: ConfirmationModalProps) {
  const titleId = useId();
  const messageId = useId();
  const closeDialog = () => {
    if (!isLoading) onClose();
  };
  const dialogRef = useAccessibleDialog(isOpen, closeDialog);

  const getTypeStyles = () => {
    switch (type) {
      case "danger":
        return {
          icon: "trash" as const,
          iconColor: "text-red-600",
          buttonColor: "bg-red-600 hover:bg-red-700",
        };
      case "warning":
        return {
          icon: "x-circle" as const,
          iconColor: "text-yellow-600",
          buttonColor: "bg-yellow-700 hover:bg-yellow-800",
        };
      case "info":
        return {
          icon: "check-circle" as const,
          iconColor: "text-blue-600",
          buttonColor: "bg-blue-600 hover:bg-blue-700",
        };
      default:
        return {
          icon: "trash" as const,
          iconColor: "text-red-600",
          buttonColor: "bg-red-600 hover:bg-red-700",
        };
    }
  };

  const styles = getTypeStyles();

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black bg-opacity-50 p-4">
      <div
        aria-busy={isLoading}
        aria-describedby={messageId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white shadow-xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="p-6">
          <div className="flex items-center mb-4">
            <div
              aria-hidden="true"
              className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                type === "danger"
                  ? "bg-red-100"
                  : type === "warning"
                  ? "bg-yellow-100"
                  : "bg-blue-100"
              }`}
            >
              <Icon
                name={styles.icon}
                className={`w-6 h-6 ${styles.iconColor}`}
              />
            </div>
            <div className="ml-4">
              <h2 className="text-lg font-medium text-gray-900" id={titleId}>
                {title}
              </h2>
            </div>
          </div>

          <div className="mb-6">
            <p
              className="whitespace-pre-line text-sm text-gray-700"
              id={messageId}
            >
              {message}
            </p>
          </div>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <button
              data-dialog-initial-focus
              onClick={closeDialog}
              disabled={isLoading}
              className="min-h-11 rounded-md border border-gray-500 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50"
              type="button"
            >
              {cancelText}
            </button>
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className={`min-h-11 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50 ${styles.buttonColor}`}
              type="button"
            >
              {isLoading ? "Processing..." : confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
