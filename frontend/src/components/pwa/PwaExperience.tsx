import { useEffect, useMemo, useRef, useState } from "react";
import {
  activateServiceWorker,
  registerServiceWorker,
  type ServiceWorkerRegistrationHandle,
} from "../../pwa/serviceWorkerRegistration";
import {
  isStandaloneDisplay,
  shouldOfferAppleHomeScreenInstall,
  type NavigatorPlatformDetails,
} from "../../pwa/platform";

const INSTALL_DISMISSAL_KEY = "atcloud.pwa.installDismissedAt";
const INSTALL_DISMISSAL_MS = 14 * 24 * 60 * 60 * 1000;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

interface PwaExperienceProps {
  registrationEnabled?: boolean;
}

function platformDetails(): NavigatorPlatformDetails {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: navigator.standalone,
  };
}

function displayModeQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(display-mode: standalone)")
    : null;
}

function installPromptWasRecentlyDismissed(now = Date.now()): boolean {
  try {
    const stored = Number(localStorage.getItem(INSTALL_DISMISSAL_KEY));
    return Number.isFinite(stored) && stored > 0 && now - stored < INSTALL_DISMISSAL_MS;
  } catch {
    return false;
  }
}

function rememberInstallDismissal(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSAL_KEY, String(Date.now()));
  } catch {
    // Installation remains usable when storage is disabled.
  }
}

function clearInstallDismissal(): void {
  try {
    localStorage.removeItem(INSTALL_DISMISSAL_KEY);
  } catch {
    // Nothing else is required when storage is disabled.
  }
}

function PwaCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 z-[10000] rounded-xl border border-gray-200 bg-white p-4 shadow-2xl sm:left-auto sm:w-[24rem]"
    >
      <div className="flex items-start gap-3">
        <img
          src="/pwa-icon-192.png"
          alt=""
          aria-hidden="true"
          className="h-10 w-10 flex-none rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {children}
        </div>
      </div>
    </section>
  );
}

export default function PwaExperience({
  registrationEnabled,
}: PwaExperienceProps) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [standalone, setStandalone] = useState(() =>
    isStandaloneDisplay(platformDetails(), displayModeQuery()),
  );
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showAppleSteps, setShowAppleSteps] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(() =>
    installPromptWasRecentlyDismissed(),
  );
  const [installing, setInstalling] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [activatingUpdate, setActivatingUpdate] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistrationHandle | null>(null);
  const reloadOnControllerChangeRef = useRef(false);

  const offerAppleInstall = useMemo(
    () =>
      !standalone &&
      !installDismissed &&
      shouldOfferAppleHomeScreenInstall(platformDetails(), displayModeQuery()),
    [installDismissed, standalone],
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleBeforeInstallPrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      if (!installPromptWasRecentlyDismissed()) {
        setInstallEvent(event);
      }
    };
    const handleInstalled = () => {
      clearInstallDismissal();
      setInstallEvent(null);
      setStandalone(true);
    };
    const displayMode = displayModeQuery();
    const handleDisplayModeChange = () =>
      setStandalone(isStandaloneDisplay(platformDetails(), displayMode));

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    displayMode?.addEventListener?.("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleInstalled);
      displayMode?.removeEventListener?.("change", handleDisplayModeChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    void registerServiceWorker({
      enabled: registrationEnabled,
      onUpdateAvailable: (worker) => {
        if (!disposed) setWaitingWorker(worker);
      },
    })
      .then((handle) => {
        if (disposed) {
          handle?.dispose();
          return;
        }
        registrationRef.current = handle;
      })
      .catch(() => {
        // The website remains fully usable if this browser blocks Service Workers.
      });

    const checkForUpdate = () => {
      if (document.visibilityState === "visible") {
        void registrationRef.current?.registration.update().catch(() => undefined);
      }
    };
    const updateTimer = window.setInterval(checkForUpdate, UPDATE_INTERVAL_MS);
    document.addEventListener("visibilitychange", checkForUpdate);

    return () => {
      disposed = true;
      window.clearInterval(updateTimer);
      document.removeEventListener("visibilitychange", checkForUpdate);
      registrationRef.current?.dispose();
      registrationRef.current = null;
    };
  }, [registrationEnabled]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const handleControllerChange = () => {
      if (!reloadOnControllerChangeRef.current) return;
      reloadOnControllerChangeRef.current = false;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );
    return () =>
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
  }, []);

  const dismissInstall = () => {
    rememberInstallDismissal();
    setInstallDismissed(true);
    setInstallEvent(null);
    setShowAppleSteps(false);
  };

  const requestBrowserInstall = async () => {
    if (!installEvent) return;
    setInstalling(true);
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      setInstallEvent(null);
      if (choice.outcome === "accepted") {
        clearInstallDismissal();
      } else {
        rememberInstallDismissal();
        setInstallDismissed(true);
      }
    } catch {
      setInstallEvent(null);
    } finally {
      setInstalling(false);
    }
  };

  const applyUpdate = () => {
    if (!waitingWorker) return;
    reloadOnControllerChangeRef.current = true;
    setActivatingUpdate(true);
    try {
      activateServiceWorker(waitingWorker);
    } catch {
      reloadOnControllerChangeRef.current = false;
      setActivatingUpdate(false);
    }
  };

  if (!online) {
    return (
      <PwaCard title="You are offline">
        <p className="mt-1 text-sm text-gray-600">
          Previously loaded screens may still work. Reconnect for current data and messages.
        </p>
      </PwaCard>
    );
  }

  if (waitingWorker) {
    return (
      <PwaCard title="An @Cloud update is ready">
        <p className="mt-1 text-sm text-gray-600">
          Refresh into the latest version when you are ready.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={applyUpdate}
            disabled={activatingUpdate}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
          >
            {activatingUpdate ? "Updating…" : "Update now"}
          </button>
          <button
            type="button"
            onClick={() => setWaitingWorker(null)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Later
          </button>
        </div>
      </PwaCard>
    );
  }

  if (!standalone && installEvent) {
    return (
      <PwaCard title="Install @Cloud">
        <p className="mt-1 text-sm text-gray-600">
          Add @Cloud to this device for faster, full-screen access.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void requestBrowserInstall()}
            disabled={installing}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
          >
            {installing ? "Opening…" : "Install app"}
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Not now
          </button>
        </div>
      </PwaCard>
    );
  }

  if (offerAppleInstall) {
    return (
      <PwaCard title="Install @Cloud on this device">
        {showAppleSteps ? (
          <>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700">
              <li>Open the browser Share menu.</li>
              <li>Select “Add to Home Screen”.</li>
              <li>Confirm by tapping “Add”.</li>
            </ol>
            <button
              type="button"
              onClick={dismissInstall}
              className="mt-3 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-gray-600">
              Add the website to your iPhone or iPad Home Screen for app-like access.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowAppleSteps(true)}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Show steps
              </button>
              <button
                type="button"
                onClick={dismissInstall}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Not now
              </button>
            </div>
          </>
        )}
      </PwaCard>
    );
  }

  return null;
}
