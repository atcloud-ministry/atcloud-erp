import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "../../hooks/useAccessibleDialog";
import Icon from "../common/Icon";

interface UserDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  userName: string;
  title: string;
  message: string;
  isLoading?: boolean;
}

export default function UserDeleteModal({
  isOpen,
  onClose,
  onConfirm,
  userName,
  title,
  message,
  isLoading = false,
}: UserDeleteModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const [showWarning, setShowWarning] = useState(false);
  const titleId = useId();
  const messageId = useId();
  const instructionId = useId();
  const warningId = useId();

  const isConfirmationValid =
    confirmText.trim().toLowerCase() === userName.toLowerCase();

  const handleConfirm = () => {
    if (isConfirmationValid) {
      onConfirm();
    } else {
      setShowWarning(true);
    }
  };

  const handleClose = () => {
    setConfirmText("");
    setShowWarning(false);
    onClose();
  };
  const dialogRef = useAccessibleDialog(isOpen, () => {
    if (!isLoading) handleClose();
  });

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black bg-opacity-50 p-4">
      <div
        aria-busy={isLoading}
        aria-describedby={`${messageId} ${instructionId}`}
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
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-100"
            >
              <Icon name="trash" className="w-6 h-6 text-red-600" />
            </div>
            <div className="ml-4">
              <h2 className="text-lg font-medium text-gray-900" id={titleId}>
                {title}
              </h2>
            </div>
          </div>

          <div className="mb-6">
            <p
              className="mb-4 whitespace-pre-line text-sm text-gray-700"
              id={messageId}
            >
              {message}
            </p>

            <div className="space-y-2">
              <label
                htmlFor="confirm-name"
                className="block text-sm font-medium text-gray-700"
                id={instructionId}
              >
                Type the user's full name to confirm:
              </label>
              <input
                aria-describedby={showWarning ? warningId : instructionId}
                aria-invalid={showWarning}
                data-dialog-initial-focus
                id="confirm-name"
                type="text"
                value={confirmText}
                onChange={(e) => {
                  setConfirmText(e.target.value);
                  setShowWarning(false);
                }}
                placeholder={userName}
                disabled={isLoading}
                className="min-h-11 w-full rounded-md border border-gray-500 px-3 py-2 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:opacity-50"
              />
              {showWarning && (
                <p
                  className="flex items-center text-sm text-red-700"
                  id={warningId}
                  role="alert"
                >
                  <span aria-hidden="true">
                    <Icon name="x-circle" className="mr-1 h-4 w-4" />
                  </span>
                  Please type the exact name: "{userName}"
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <button
              onClick={handleClose}
              disabled={isLoading}
              className="min-h-11 rounded-md border border-gray-500 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-50"
              type="button"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={isLoading || !isConfirmationValid}
              className={`min-h-11 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:opacity-50 ${
                isConfirmationValid
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-gray-400 cursor-not-allowed"
              }`}
              type="button"
            >
              {isLoading ? "Deleting..." : "Delete User"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
