import React, { useId } from "react";
import { createPortal } from "react-dom";
import { useAccessibleDialog } from "../../hooks/useAccessibleDialog";

interface ConfirmLogoutModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export const ConfirmLogoutModal: React.FC<ConfirmLogoutModalProps> = ({
  open,
  onConfirm,
  onCancel,
  loading = false,
}) => {
  const titleId = useId();
  const messageId = useId();
  const closeDialog = () => {
    if (!loading) onCancel();
  };
  const dialogRef = useAccessibleDialog(open, closeDialog);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={closeDialog}
      />
      <div
        aria-busy={loading}
        aria-describedby={messageId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative max-h-[calc(100vh-2rem)] w-full max-w-sm overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 shadow-xl animate-fade-in"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="mb-2 text-lg font-semibold text-gray-900" id={titleId}>
          Confirm Logout
        </h2>
        <p className="mb-6 text-sm text-gray-700" id={messageId}>
          Are you sure you want to log out? You can sign back in anytime.
        </p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            data-dialog-initial-focus
            type="button"
            onClick={closeDialog}
            className="min-h-11 rounded-md border border-gray-500 bg-white px-4 py-2 text-sm text-gray-800 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="min-h-11 rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1 disabled:opacity-60"
            disabled={loading}
          >
            {loading ? "Logging out..." : "Log Out"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ConfirmLogoutModal;
