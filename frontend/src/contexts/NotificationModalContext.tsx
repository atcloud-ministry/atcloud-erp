import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
} from "react";
import NotificationModal from "../components/common/NotificationModal";
import { isSessionExpiredPromptShown } from "../services/session";

interface NotificationOptions {
  title: string;
  message: string;
  type?: "success" | "error" | "warning" | "info";
  autoClose?: boolean;
  autoCloseDelay?: number;
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
  // Optional callback invoked when this specific notification is closed
  onClose?: () => void;
  // When true, subsequent showNotification calls are ignored until this one closes
  lockUntilClose?: boolean;
}

interface NotificationContextType {
  showNotification: (options: NotificationOptions) => void;
  hideNotification: () => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(
  undefined,
);

export const useNotification = () => {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error(
      "useNotification must be used within a NotificationProvider",
    );
  }
  return context;
};

interface NotificationProviderProps {
  children: React.ReactNode;
}

export const NotificationProvider: React.FC<NotificationProviderProps> = ({
  children,
}) => {
  const [notification, setNotification] = useState<NotificationOptions | null>(
    null,
  );
  const [locked, setLocked] = useState(false);
  const showNotification = useCallback(
    (options: NotificationOptions) => {
      // If locked, ignore attempts to replace until current modal is closed
      if (locked) return;
      // Suppress error notifications when session has expired (SessionExpiredModal handles it)
      if (options.type === "error" && isSessionExpiredPromptShown()) return;
      setNotification(options);
      if (options.lockUntilClose) setLocked(true);
    },
    [locked],
  );

  const hideNotification = useCallback(() => {
    // Capture current, clear, then invoke its onClose
    setNotification((current) => {
      if (current) {
        setTimeout(() => current.onClose?.(), 0);
      }
      return null;
    });
    setLocked(false);
  }, []);

  // Keep context value stable across renders to avoid unnecessary re-renders
  // and prevent dependency loops in consumers that include the whole context in deps.
  const contextValue = useMemo(
    () => ({ showNotification, hideNotification }),
    [showNotification, hideNotification],
  );

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <NotificationModal
        isOpen={!!notification}
        onClose={hideNotification}
        title={notification?.title || ""}
        message={notification?.message || ""}
        type={notification?.type}
        actionButton={notification?.actionButton}
        actionButtons={notification?.actionButtons}
        showCloseButton={notification?.showCloseButton}
        closeButtonText={notification?.closeButtonText}
      />
    </NotificationContext.Provider>
  );
};

// Convenience functions that match toast API for easy migration
export const useToastReplacement = () => {
  const { showNotification } = useNotification();

  // Stable callbacks so consumers can safely use them in deps
  const success = useCallback(
    (message: string, options?: Partial<NotificationOptions>) => {
      showNotification({
        title: "Success",
        message,
        type: "success",
        autoClose: true,
        autoCloseDelay: 3000,
        ...options,
      });
    },
    [showNotification],
  );

  const error = useCallback(
    (message: string, options?: Partial<NotificationOptions>) => {
      showNotification({
        title: "Error",
        message,
        type: "error",
        autoClose: true,
        autoCloseDelay: 5000,
        ...options,
      });
    },
    [showNotification],
  );

  const warning = useCallback(
    (message: string, options?: Partial<NotificationOptions>) => {
      showNotification({
        title: "Warning",
        message,
        type: "warning",
        autoClose: true,
        autoCloseDelay: 4000,
        ...options,
      });
    },
    [showNotification],
  );

  const info = useCallback(
    (message: string, options?: Partial<NotificationOptions>) => {
      showNotification({
        title: "Info",
        message,
        type: "info",
        autoClose: true,
        autoCloseDelay: 4000,
        ...options,
      });
    },
    [showNotification],
  );

  // Memoize object to keep stable reference if consumers depend on it as a whole
  return useMemo(
    () => ({ success, error, warning, info }),
    [success, error, warning, info],
  );
};
