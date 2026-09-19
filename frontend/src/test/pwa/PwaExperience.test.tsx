import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    const stepsButton = screen.getByRole("button", { name: "Show steps" });
    expect(stepsButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(stepsButton);

    expect(screen.getByText("Open the browser Share menu.")).toBeVisible();
    expect(screen.getByText(/Add to Home Screen/)).toBeVisible();
    expect(screen.getByRole("list")).toHaveFocus();
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

  it("keeps keyboard focus from being obscured by its fixed card", () => {
    render(
      <>
        <button type="button">Page action</button>
        <PwaExperience registrationEnabled={false} />
      </>,
    );
    act(() => window.dispatchEvent(new Event("offline")));
    const card = screen.getByRole("region", { name: "You are offline" });
    const action = screen.getByRole("button", { name: "Page action" });
    const scrollIntoView = vi.fn();
    action.scrollIntoView = scrollIntoView;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      bottom: 760,
      height: 200,
      left: 0,
      right: 320,
      top: 560,
      width: 320,
      x: 0,
      y: 560,
      toJSON: () => ({}),
    });
    vi.spyOn(action, "getBoundingClientRect").mockReturnValue({
      bottom: 620,
      height: 40,
      left: 20,
      right: 180,
      top: 580,
      width: 160,
      x: 20,
      y: 580,
      toJSON: () => ({}),
    });

    action.focus();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
    });
  });

  it("restores prior focus when an install card is dismissed", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Page action</button>
        <PwaExperience registrationEnabled={false} />
      </>,
    );
    const pageAction = screen.getByRole("button", { name: "Page action" });
    pageAction.focus();
    act(() => window.dispatchEvent(new InstallPromptEvent("dismissed")));

    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(pageAction).toHaveFocus());
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
