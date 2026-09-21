import { useEffect, useRef } from "react";
import { useChatRooms } from "../../contexts/ChatRoomsContext";
import { useNotifications } from "../../contexts/NotificationContext";
import { useAuth } from "../../hooks/useAuth";
import { isStandaloneDisplay } from "../../pwa/platform";

export const MAX_LAUNCHER_BADGE_COUNT = 99;

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function safeUnreadCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export function launcherBadgeTotal(
  chatUnreadTotal: unknown,
  systemMessageUnreadCount: unknown,
): number {
  return Math.min(
    safeUnreadCount(chatUnreadTotal) + safeUnreadCount(systemMessageUnreadCount),
    MAX_LAUNCHER_BADGE_COUNT,
  );
}

export async function applyLauncherBadge(
  total: number,
  source: BadgeNavigator = navigator as BadgeNavigator,
): Promise<void> {
  const normalized = launcherBadgeTotal(total, 0);
  const updates: Promise<unknown>[] = [];
  let pageBadgeApiUsed = false;

  try {
    if (normalized === 0 && typeof source.clearAppBadge === "function") {
      updates.push(Promise.resolve(source.clearAppBadge()));
      pageBadgeApiUsed = true;
    } else if (normalized > 0 && typeof source.setAppBadge === "function") {
      updates.push(Promise.resolve(source.setAppBadge(normalized)));
      pageBadgeApiUsed = true;
    }
  } catch {
    // OS badging is progressive enhancement.
  }

  // Avoid invoking the same Badging implementation twice. The active worker
  // is a fallback only when the page-level API is unavailable.
  if (!pageBadgeApiUsed && "serviceWorker" in source) {
    source.serviceWorker?.controller?.postMessage({
      type: "SET_APP_BADGE",
      launcherBadgeTotal: normalized,
    });
  }

  await Promise.allSettled(updates);
}

/** Synchronizes the absolute in-app counters to the installed PWA icon. */
export default function PwaBadgeSync() {
  const { currentUser, isLoading, initializationError } = useAuth();
  const { chatUnreadTotal, countReady: chatUnreadReady } = useChatRooms();
  const { systemMessageUnreadCount, systemMessageUnreadReady } =
    useNotifications();
  const queue = useRef(Promise.resolve());
  const standalone =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    isStandaloneDisplay(
      {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone: navigator.standalone,
      },
      typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)")
        : null,
    );
  const total = currentUser
    ? launcherBadgeTotal(chatUnreadTotal, systemMessageUnreadCount)
    : 0;

  useEffect(() => {
    if (
      !standalone ||
      isLoading ||
      initializationError ||
      (currentUser && (!chatUnreadReady || !systemMessageUnreadReady))
    ) {
      return;
    }
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => applyLauncherBadge(total));
  }, [
    chatUnreadReady,
    currentUser,
    initializationError,
    isLoading,
    standalone,
    systemMessageUnreadReady,
    total,
  ]);

  return null;
}
