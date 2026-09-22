// Centralized session expiration handler for the frontend
// Shows a clear prompt and redirects to login once.

import { getHashRouteUrl } from "../utils/hashRouting";
import { isSafeInternalRedirectPath } from "../utils/loginRedirect";
import { socketService } from "./socketService";

let sessionPromptShown = false;

export const LOGIN_HASH_ROUTE = getHashRouteUrl("/login");

function captureCurrentHashRoute(): void {
  try {
    const hash = window.location.hash;
    const candidate = hash.startsWith("#/") ? hash.slice(1) : null;
    if (
      candidate &&
      candidate !== "/login" &&
      isSafeInternalRedirectPath(candidate)
    ) {
      sessionStorage.setItem("returnUrl", candidate);
    }
  } catch {
    // Storage and location access can be unavailable in hardened browsers.
  }
}

// Lightweight pub/sub so components (e.g., a top-level listener) can show a custom modal
type SessionExpiredListener = () => void;
const listeners: SessionExpiredListener[] = [];

export function onSessionExpired(listener: SessionExpiredListener) {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function handleSessionExpired(): void {
  if (sessionPromptShown) return;
  sessionPromptShown = true;
  captureCurrentHashRoute();

  try {
    localStorage.removeItem("authToken");
    socketService.updateAuthenticationToken(null);
  } catch {
    void 0;
  }

  // Notify UI layer to render modal; fallback to alert if no listener registered
  if (listeners.length > 0) {
    listeners.forEach((l) => {
      try {
        l();
      } catch {
        // swallow listener errors
      }
    });
  } else if (
    typeof window !== "undefined" &&
    typeof window.alert === "function"
  ) {
    window.alert("Your session has expired. Please sign in again.");
    // Only redirect if using fallback alert (no modal listeners registered)
    setTimeout(() => {
      try {
        if (typeof window !== "undefined" && window.location) {
          window.location.assign(LOGIN_HASH_ROUTE);
        }
      } catch {
        void 0;
      }
    }, 0);
  }
}

// Check if session expired prompt has already been shown
// (used by NotificationModalContext to suppress error toasts during logout)
export function isSessionExpiredPromptShown(): boolean {
  return sessionPromptShown;
}

// For tests or resets (not used in production runtime)
export function __resetSessionPromptFlag() {
  sessionPromptShown = false;
}
