import { useCallback, useEffect, useMemo, useState } from "react";
import {
  pushNotificationsService,
  type NotificationPreferenceDTO,
  type PushPublicConfigDTO,
  type PushSubscriptionListDTO,
} from "../services/api";
import {
  disablePushGlobally,
  enablePushForCurrentBrowser,
  getCurrentBrowserPushState,
  getExistingPushInstallationId,
  removePushForCurrentBrowser,
  type CurrentBrowserPushState,
} from "../services/webPushLifecycle";
import { shouldOfferAppleHomeScreenInstall } from "../pwa/platform";

const INITIAL_BROWSER_STATE: CurrentBrowserPushState = {
  supported: false,
  permission: "unsupported",
  subscribed: false,
  installationId: null,
};

function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full ring-1 ring-inset ring-black/20 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-blue-700" : "bg-gray-600"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-1 inline-block h-5 w-5 rounded-full bg-white shadow transition ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function appleInstallRequired(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const appleNavigator = navigator as Navigator & { standalone?: boolean };
  return shouldOfferAppleHomeScreenInstall(
    {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: appleNavigator.standalone,
    },
    typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)")
      : null,
  );
}

function browserStatusText(
  config: PushPublicConfigDTO,
  browser: CurrentBrowserPushState,
  registeredOnServer: boolean,
): string {
  if (!config.enabled) return "Push is not currently available.";
  if (!browser.supported) return "This browser does not support Web Push.";
  if (browser.permission === "denied") {
    return "Notifications are blocked in this browser's settings.";
  }
  if (browser.subscribed && registeredOnServer) {
    return "Push is active for this browser.";
  }
  if (browser.subscribed) {
    return "This browser needs to reconnect its Push subscription.";
  }
  return "Push is not enabled for this browser.";
}

export default function NotificationSettings() {
  const [config, setConfig] = useState<PushPublicConfigDTO | null>(null);
  const [preferences, setPreferences] =
    useState<NotificationPreferenceDTO | null>(null);
  const [subscriptions, setSubscriptions] =
    useState<PushSubscriptionListDTO>({ subscriptions: [] });
  const [browserState, setBrowserState] =
    useState<CurrentBrowserPushState>(INITIAL_BROWSER_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const needsAppleInstall = useMemo(appleInstallRequired, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    const [nextConfig, nextPreferences, nextSubscriptions, nextBrowserState] =
      await Promise.all([
        pushNotificationsService.getConfig(signal),
        pushNotificationsService.getPreferences(signal),
        pushNotificationsService.listSubscriptions(signal),
        getCurrentBrowserPushState(),
      ]);
    if (signal?.aborted) return;
    setConfig(nextConfig);
    setPreferences(nextPreferences);
    setSubscriptions(nextSubscriptions);
    setBrowserState(nextBrowserState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal)
      .catch(() => {
        if (!controller.signal.aborted) {
          setError("We could not load your notification settings. Try again.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);

  const currentInstallationId =
    browserState.installationId ?? getExistingPushInstallationId();
  const registeredOnServer = Boolean(
    currentInstallationId &&
      subscriptions.subscriptions.some(
        (subscription) =>
          subscription.installationId === currentInstallationId,
      ),
  );

  const runAction = async (action: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch {
      setError("We could not save that change. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const setEmailEnabled = (emailEnabled: boolean) => {
    void runAction(async () => {
      const next = await pushNotificationsService.updatePreferences({
        emailEnabled,
      });
      setPreferences(next);
      setNotice("Email preference saved.");
    });
  };

  const setPushEnabled = (pushEnabled: boolean) => {
    void runAction(async () => {
      if (!pushEnabled) {
        const { cleanup } = await disablePushGlobally();
        setPreferences((current) =>
          current ? { ...current, pushEnabled: false } : current,
        );
        setBrowserState(await getCurrentBrowserPushState());
        setSubscriptions((current) => ({
          subscriptions: current.subscriptions.filter(
            (entry) => entry.installationId !== currentInstallationId,
          ),
        }));
        setNotice(
          cleanup.serverRemoved && cleanup.browserUnsubscribed
            ? "Push notifications turned off."
            : "Push is off. This browser will finish local cleanup when available.",
        );
        return;
      }
      const next = await pushNotificationsService.updatePreferences({
        pushEnabled: true,
      });
      setPreferences(next);
      setNotice("Push preference saved. Enable this browser below to receive Push.");
    });
  };

  const enableThisBrowser = () => {
    if (!config?.publicKey) return;
    // This function invokes requestPermission synchronously in this click handler.
    const enableRequest = enablePushForCurrentBrowser(config.publicKey);
    void runAction(async () => {
      const nextBrowserState = await enableRequest;
      setBrowserState(nextBrowserState);
      if (nextBrowserState.permission === "granted") {
        setPreferences((current) =>
          current ? { ...current, pushEnabled: true } : current,
        );
        const nextSubscriptions =
          await pushNotificationsService.listSubscriptions();
        setSubscriptions(nextSubscriptions);
        setNotice("Push is active for this browser.");
      } else if (nextBrowserState.permission === "denied") {
        setNotice(null);
        setError(
          "Notifications were blocked. Allow them in your browser or device settings, then try again.",
        );
      } else {
        setNotice("Permission was not granted. Your email preference is unchanged.");
      }
    });
  };

  const disableThisBrowser = () => {
    void runAction(async () => {
      const cleanup = await removePushForCurrentBrowser();
      setBrowserState(await getCurrentBrowserPushState());
      setSubscriptions((current) => ({
        subscriptions: current.subscriptions.filter(
          (entry) => entry.installationId !== currentInstallationId,
        ),
      }));
      setNotice(
        cleanup.serverRemoved && cleanup.browserUnsubscribed
          ? "Push was removed from this browser."
          : "Push removal was saved where available. Try again if this browser still appears active.",
      );
    });
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8" aria-busy="true" aria-live="polite" role="status">
        <p className="text-gray-700">Loading notification settings…</p>
      </div>
    );
  }

  if (!config || !preferences) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">
          Notification Settings
        </h1>
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
          {error ?? "Notification settings are unavailable."}
        </div>
        <button
          type="button"
          className="mt-4 min-h-11 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          onClick={() => {
            setLoading(true);
            void refresh()
              .catch(() =>
                setError(
                  "We could not load your notification settings. Try again.",
                ),
              )
              .finally(() => setLoading(false));
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const canEnableBrowser =
    config.enabled &&
    Boolean(config.publicKey) &&
    browserState.supported &&
    browserState.permission !== "denied" &&
    !needsAppleInstall;

  return (
    <div aria-busy={saving} className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-gray-900">
        Notification Settings
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Choose how Alumni Help and Chat Room updates reach you.
      </p>
      <p className="mt-2 text-sm text-gray-600">
        See how notification and chat records are used and retained in{" "}
        <a className="font-medium text-blue-700 underline hover:text-blue-900" href="/#/privacy">
          Privacy &amp; Data Use
        </a>
        .
      </p>

      {error && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-5 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">
          {notice}
        </div>
      )}

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm" aria-labelledby="delivery-heading">
        <h2 id="delivery-heading" className="text-lg font-semibold text-gray-900">
          Delivery preferences
        </h2>
        <div className="mt-4 divide-y divide-gray-200">
          <div className="flex items-start justify-between gap-5 py-4">
            <div>
              <p className="font-medium text-gray-900">Push notifications</p>
              <p className="mt-1 text-sm text-gray-600">
                Receive eligible updates on browsers you enable below.
              </p>
            </div>
            <Toggle
              label="Push notifications"
              checked={preferences.pushEnabled}
              disabled={saving}
              onChange={setPushEnabled}
            />
          </div>
          <div className="flex items-start justify-between gap-5 py-4">
            <div>
              <p className="font-medium text-gray-900">Email fallback</p>
              <p className="mt-1 text-sm text-gray-600">
                Send eligible updates by email when no active Push delivery is available.
              </p>
            </div>
            <Toggle
              label="Email fallback"
              checked={preferences.emailEnabled}
              disabled={saving}
              onChange={setEmailEnabled}
            />
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm" aria-labelledby="browser-heading">
        <h2 id="browser-heading" className="text-lg font-semibold text-gray-900">
          This browser
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          {browserStatusText(config, browserState, registeredOnServer)}
        </p>

        {needsAppleInstall && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            On iPhone or iPad, first use Safari’s Share menu and choose “Add to Home Screen.” Open the installed site, then return here to enable Push.
          </div>
        )}
        {browserState.permission === "denied" && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Notifications are blocked. Update this site’s notification permission in your browser or device settings, then reload this page.
          </div>
        )}
        {!browserState.supported && !needsAppleInstall && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
            Push is unavailable in this browser. You can keep Email fallback enabled.
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          {!browserState.subscribed || !registeredOnServer ? (
            <button
              type="button"
              disabled={saving || !canEnableBrowser}
              onClick={enableThisBrowser}
              className="min-h-11 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Enable Push on this browser"}
            </button>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={disableThisBrowser}
              className="min-h-11 rounded-lg border border-gray-500 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Remove Push from this browser"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
