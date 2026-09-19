import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationSettings from "../../pages/NotificationSettings";
import { pushNotificationsService } from "../../services/api";
import {
  enablePushForCurrentBrowser,
  getCurrentBrowserPushState,
} from "../../services/webPushLifecycle";
import { shouldOfferAppleHomeScreenInstall } from "../../pwa/platform";

vi.mock("../../services/api", () => ({
  pushNotificationsService: {
    getConfig: vi.fn(),
    getPreferences: vi.fn(),
    listSubscriptions: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));

vi.mock("../../services/webPushLifecycle", () => ({
  disablePushGlobally: vi.fn(),
  enablePushForCurrentBrowser: vi.fn(),
  getCurrentBrowserPushState: vi.fn(),
  getExistingPushInstallationId: vi.fn(
    () => "web-550e8400-e29b-41d4-a716-446655440000",
  ),
  removePushForCurrentBrowser: vi.fn(),
}));

vi.mock("../../pwa/platform", () => ({
  shouldOfferAppleHomeScreenInstall: vi.fn(() => false),
}));

const installationId = "web-550e8400-e29b-41d4-a716-446655440000";
const timestamp = "2026-09-13T12:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldOfferAppleHomeScreenInstall).mockReturnValue(false);
  vi.mocked(pushNotificationsService.getConfig).mockResolvedValue({
    enabled: true,
    publicKey: "BA_valid-key",
  });
  vi.mocked(pushNotificationsService.getPreferences).mockResolvedValue({
    pushEnabled: true,
    emailEnabled: true,
    updatedAt: timestamp,
  });
  vi.mocked(pushNotificationsService.listSubscriptions).mockResolvedValue({
    subscriptions: [],
  });
  vi.mocked(getCurrentBrowserPushState).mockResolvedValue({
    supported: true,
    permission: "default",
    subscribed: false,
    installationId,
  });
  vi.mocked(pushNotificationsService.updatePreferences).mockImplementation(
    async (changes) => ({
      pushEnabled: true,
      emailEnabled: changes.emailEnabled ?? true,
      updatedAt: timestamp,
    }),
  );
  vi.mocked(enablePushForCurrentBrowser).mockResolvedValue({
    supported: true,
    permission: "granted",
    subscribed: true,
    installationId,
  });
});

describe("Notification Settings", () => {
  it("loads browser state without asking for permission", async () => {
    render(<NotificationSettings />);

    expect(
      await screen.findByRole("heading", { name: "Notification Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Privacy & Data Use" }),
    ).toHaveAttribute("href", "/#/privacy");
    expect(
      screen.getByText("Push is not enabled for this browser."),
    ).toBeInTheDocument();
    expect(enablePushForCurrentBrowser).not.toHaveBeenCalled();
    expect(
      screen.getByRole("switch", { name: "Push notifications" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", { name: "Email fallback" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", { name: "Push notifications" }),
    ).toHaveClass("bg-blue-700");
    expect(document.querySelector("main")).not.toBeInTheDocument();
  });

  it("uses a high-contrast off state while preserving switch semantics", async () => {
    vi.mocked(pushNotificationsService.getPreferences).mockResolvedValue({
      pushEnabled: false,
      emailEnabled: false,
      updatedAt: timestamp,
    });
    render(<NotificationSettings />);

    const push = await screen.findByRole("switch", {
      name: "Push notifications",
    });
    expect(push).toHaveAttribute("aria-checked", "false");
    expect(push).toHaveClass("bg-gray-600");
  });

  it("saves the Email fallback preference independently", async () => {
    render(<NotificationSettings />);
    const emailSwitch = await screen.findByRole("switch", {
      name: "Email fallback",
    });
    fireEvent.click(emailSwitch);

    await waitFor(() => {
      expect(pushNotificationsService.updatePreferences).toHaveBeenCalledWith({
        emailEnabled: false,
      });
    });
    expect(await screen.findByText("Email preference saved.")).toBeInTheDocument();
  });

  it("enables a browser only from the explicit enable button", async () => {
    render(<NotificationSettings />);
    const button = await screen.findByRole("button", {
      name: "Enable Push on this browser",
    });

    fireEvent.click(button);
    expect(enablePushForCurrentBrowser).toHaveBeenCalledWith("BA_valid-key");
    expect(
      await screen.findByText("Push is active for this browser."),
    ).toBeInTheDocument();
  });

  it("explains the iOS Home Screen prerequisite", async () => {
    vi.mocked(shouldOfferAppleHomeScreenInstall).mockReturnValue(true);
    render(<NotificationSettings />);

    expect(
      await screen.findByText(/Add to Home Screen/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enable Push on this browser" }),
    ).toBeDisabled();
  });

  it("explains how to recover from denied browser permission", async () => {
    vi.mocked(getCurrentBrowserPushState).mockResolvedValue({
      supported: true,
      permission: "denied",
      subscribed: false,
      installationId,
    });
    render(<NotificationSettings />);

    expect(
      await screen.findByText(/Update this site’s notification permission/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enable Push on this browser" }),
    ).toBeDisabled();
  });
});
