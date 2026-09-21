import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { LOGIN_HASH_ROUTE, onSessionExpired } from "../../services/session";
import { getSafeLocationRedirectPath } from "../../utils/loginRedirect";
import AlertModal from "./AlertModal";

/**
 * Global session expiration handler that shows a custom modal
 * instead of browser alert when session expires.
 */
export default function SessionExpiredModal() {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    // Register listener for session expiration events
    const unsubscribe = onSessionExpired(() => {
      // Capture the protected destination synchronously. Auth state can send the
      // router to /login before the user acknowledges this modal.
      const returnUrl = getSafeLocationRedirectPath(locationRef.current);
      if (returnUrl && returnUrl !== "/login") {
        sessionStorage.setItem("returnUrl", returnUrl);
      }
      setIsOpen(true);
    });

    return unsubscribe;
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    // Use hard navigation to force full app reload.
    // This ensures AuthContext re-initializes with no token, avoiding
    // race conditions where stale currentUser state redirects back.
    window.location.href = LOGIN_HASH_ROUTE;
  };

  return (
    <AlertModal
      isOpen={isOpen}
      onClose={handleClose}
      title="Session Expired"
      message="Your session has expired. Please login again."
      type="warning"
      buttonText="Login"
    />
  );
}
