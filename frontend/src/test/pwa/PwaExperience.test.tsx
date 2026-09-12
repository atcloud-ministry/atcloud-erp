import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PwaExperience from "../../components/pwa/PwaExperience";

const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(
  navigator,
  "maxTouchPoints",
);
const originalStandalone = Object.getOwnPropertyDescriptor(
  navigator,
  "standalone",
);
const originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");
const originalMatchMedia = window.matchMedia;
const originalServiceWorker = Object.getOwnPropertyDescriptor(
  navigator,
  "serviceWorker",
);

function setNavigatorValue(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

function restoreNavigatorValue(
  name: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(navigator, name, descriptor);
  else delete (navigator as unknown as Record<string, unknown>)[name];
}

function installMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: "(display-mode: standalone)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

class InstallPromptEvent extends Event implements BeforeInstallPromptEvent {
  readonly platforms = ["web"];
  readonly prompt = vi.fn().mockResolvedValue(undefined);
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;

  constructor(outcome: "accepted" | "dismissed") {
    super("beforeinstallprompt", { cancelable: true });
    this.userChoice = Promise.resolve({ outcome, platform: "web" });
  }
}

beforeEach(() => {
  setNavigatorValue("userAgent", "Mozilla/5.0 Chrome/126.0");
  setNavigatorValue("platform", "Linux x86_64");
  setNavigatorValue("maxTouchPoints", 0);
  setNavigatorValue("standalone", false);
  setNavigatorValue("onLine", true);
  installMatchMedia(false);
});

afterEach(() => {
  restoreNavigatorValue("userAgent", originalUserAgent);
  restoreNavigatorValue("platform", originalPlatform);
  restoreNavigatorValue("maxTouchPoints", originalMaxTouchPoints);
  restoreNavigatorValue("standalone", originalStandalone);
  restoreNavigatorValue("onLine", originalOnline);
  restoreNavigatorValue("serviceWorker", originalServiceWorker);
  window.matchMedia = originalMatchMedia;
});

describe("PWA installation and lifecycle UX", () => {
  it("uses the browser-mediated install prompt and hides after acceptance", async () => {
    render(<PwaExperience registrationEnabled={false} />);
    const promptEvent = new InstallPromptEvent("accepted");

    act(() => window.dispatchEvent(promptEvent));
    expect(promptEvent.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Install app" }));
    await waitFor(() => expect(promptEvent.prompt).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Install @Cloud" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("provides iPhone and iPad Home Screen instructions", () => {
    setNavigatorValue(
      "userAgent",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
    );
    setNavigatorValue("platform", "iPhone");

    render(<PwaExperience registrationEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Show steps" }));

    expect(screen.getByText("Open the browser Share menu.")).toBeVisible();
    expect(screen.getByText(/Add to Home Screen/)).toBeVisible();
  });

  it("does not offer installation in standalone mode", () => {
    setNavigatorValue(
      "userAgent",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
    );
    setNavigatorValue("standalone", true);
    render(<PwaExperience registrationEnabled={false} />);

    expect(screen.queryByText(/Install @Cloud/)).not.toBeInTheDocument();
  });

  it("shows offline status without claiming private data is cached", () => {
    render(<PwaExperience registrationEnabled={false} />);
    act(() => window.dispatchEvent(new Event("offline")));

    expect(screen.getByRole("region", { name: "You are offline" })).toBeVisible();
    expect(screen.getByText(/Reconnect for current data/)).toBeVisible();
  });

  it("lets the user activate a waiting Service Worker", async () => {
    const waiting = Object.assign(new EventTarget(), {
      state: "installed",
      postMessage: vi.fn(),
    }) as unknown as ServiceWorker;
    const registration = Object.assign(new EventTarget(), {
      waiting,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
    }) as unknown as ServiceWorkerRegistration;
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn().mockResolvedValue(registration),
    }) as unknown as ServiceWorkerContainer;
    setNavigatorValue("serviceWorker", container);

    render(<PwaExperience registrationEnabled />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Update now" }),
    );

    expect(waiting.postMessage).toHaveBeenCalledWith({
      type: "SKIP_WAITING",
    });
  });
});
