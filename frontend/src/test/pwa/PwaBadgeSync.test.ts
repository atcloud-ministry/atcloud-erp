import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PwaBadgeSync, {
  applyLauncherBadge,
  launcherBadgeTotal,
} from "../../components/pwa/PwaBadgeSync";
import { isStandaloneDisplay } from "../../pwa/platform";

const context = vi.hoisted(() => ({
  currentUser: null as null | { id: string },
  authLoading: false,
  initializationError: null as string | null,
  chatUnreadTotal: 0,
  chatUnreadReady: true,
  systemMessageUnreadCount: 0,
  systemMessageUnreadReady: true,
}));

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({
    currentUser: context.currentUser,
    isLoading: context.authLoading,
    initializationError: context.initializationError,
  }),
}));

vi.mock("../../contexts/ChatRoomsContext", () => ({
  useChatRooms: () => ({
    chatUnreadTotal: context.chatUnreadTotal,
    countReady: context.chatUnreadReady,
  }),
}));

vi.mock("../../contexts/NotificationContext", () => ({
  useNotifications: () => ({
    systemMessageUnreadCount: context.systemMessageUnreadCount,
    systemMessageUnreadReady: context.systemMessageUnreadReady,
  }),
}));

vi.mock("../../pwa/platform", () => ({
  isStandaloneDisplay: vi.fn(() => false),
}));

const originalSetAppBadge = Object.getOwnPropertyDescriptor(
  navigator,
  "setAppBadge",
);
const originalClearAppBadge = Object.getOwnPropertyDescriptor(
  navigator,
  "clearAppBadge",
);

afterEach(() => {
  context.currentUser = null;
  context.authLoading = false;
  context.initializationError = null;
  context.chatUnreadTotal = 0;
  context.chatUnreadReady = true;
  context.systemMessageUnreadCount = 0;
  context.systemMessageUnreadReady = true;
  vi.mocked(isStandaloneDisplay).mockReturnValue(false);
  for (const [name, descriptor] of [
    ["setAppBadge", originalSetAppBadge],
    ["clearAppBadge", originalClearAppBadge],
  ] as const) {
    if (descriptor) Object.defineProperty(navigator, name, descriptor);
    else Reflect.deleteProperty(navigator, name);
  }
});

describe("PWA launcher badge synchronization", () => {
  it("combines Chat and System Message unread counts at the 99+ boundary", () => {
    expect(launcherBadgeTotal(12, 7)).toBe(19);
    expect(launcherBadgeTotal(98, 4)).toBe(99);
    expect(launcherBadgeTotal(-1, Number.NaN)).toBe(0);
  });

  it("uses the page Badging API without invoking it again through the worker", async () => {
    const postMessage = vi.fn();
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    await applyLauncherBadge(8, {
      setAppBadge,
      serviceWorker: {
        controller: { postMessage },
      },
    } as unknown as Navigator & {
      setAppBadge: (count: number) => Promise<void>;
    });

    expect(setAppBadge).toHaveBeenCalledWith(8);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("falls back to the active Service Worker when page badging is unavailable", async () => {
    const postMessage = vi.fn();
    await applyLauncherBadge(8, {
      serviceWorker: {
        controller: { postMessage },
      },
    } as unknown as Navigator);

    expect(postMessage).toHaveBeenCalledWith({
      type: "SET_APP_BADGE",
      launcherBadgeTotal: 8,
    });
  });

  it("clears the launcher badge on zero", async () => {
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    await applyLauncherBadge(0, {
      clearAppBadge,
    } as unknown as Navigator & {
      clearAppBadge: () => Promise<void>;
    });
    expect(clearAppBadge).toHaveBeenCalledOnce();
  });

  it("does not call native badging from an ordinary browser page", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadge },
    });
    context.currentUser = { id: "user-1" };
    context.chatUnreadTotal = 4;

    render(createElement(PwaBadgeSync));
    await Promise.resolve();

    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("uses one page-level native call for an authenticated standalone install", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadge },
    });
    vi.mocked(isStandaloneDisplay).mockReturnValue(true);
    context.currentUser = { id: "user-1" };
    context.chatUnreadTotal = 4;
    context.systemMessageUnreadCount = 3;

    render(createElement(PwaBadgeSync));

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledOnce());
    expect(setAppBadge).toHaveBeenCalledWith(7);
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("preserves an existing badge until auth and both absolute counts are ready", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      setAppBadge: { configurable: true, value: setAppBadge },
      clearAppBadge: { configurable: true, value: clearAppBadge },
    });
    vi.mocked(isStandaloneDisplay).mockReturnValue(true);
    context.currentUser = { id: "user-1" };
    context.chatUnreadReady = false;
    context.systemMessageUnreadReady = false;

    const view = render(createElement(PwaBadgeSync));
    await Promise.resolve();
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();

    context.chatUnreadReady = true;
    context.systemMessageUnreadReady = true;
    context.chatUnreadTotal = 2;
    context.systemMessageUnreadCount = 1;
    view.rerender(createElement(PwaBadgeSync));

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(3));
  });

  it("does not clear a badge while authentication initialization has failed", async () => {
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clearAppBadge", {
      configurable: true,
      value: clearAppBadge,
    });
    vi.mocked(isStandaloneDisplay).mockReturnValue(true);
    context.initializationError = "Network unavailable";

    render(createElement(PwaBadgeSync));
    await Promise.resolve();

    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});
