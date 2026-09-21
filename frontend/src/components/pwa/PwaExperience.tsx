import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  const headingId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useLayoutEffect(() => {
    const card = cardRef.current;
    const previouslyFocused = previouslyFocusedRef.current;
    if (!card) return;

    const keepFocusedControlVisible = (target: HTMLElement | null) => {
      if (!target || target === document.body || card.contains(target)) return;
      const targetRect = target.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const overlaps =
        targetRect.right > cardRect.left &&
        targetRect.left < cardRect.right &&
        targetRect.bottom > cardRect.top &&
        targetRect.top < cardRect.bottom;
      if (overlaps && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      }
    };
    const handleFocus = (event: FocusEvent) => {
      keepFocusedControlVisible(
        event.target instanceof HTMLElement ? event.target : null,
      );
    };

    keepFocusedControlVisible(
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    );
    document.addEventListener("focusin", handleFocus);
    return () => {
      document.removeEventListener("focusin", handleFocus);
      if (!card.contains(document.activeElement)) return;
      const fallback = document.querySelector<HTMLElement>(
        "#dashboard-main-content, main, [role='main']",
      );
      const returnTarget =
        previouslyFocused?.isConnected && previouslyFocused !== document.body
          ? previouslyFocused
          : fallback;
      window.requestAnimationFrame(() => {
        if (!returnTarget?.isConnected) return;
        if (!returnTarget.hasAttribute("tabindex")) {
          returnTarget.setAttribute("tabindex", "-1");
        }
        returnTarget.focus();
      });
    };
  }, []);

  return (
    <section
      aria-atomic="true"
      aria-labelledby={headingId}
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 z-[10000] max-h-[35dvh] overflow-y-auto rounded-xl border border-gray-500 bg-white p-4 shadow-2xl sm:left-auto sm:w-[24rem]"
      data-pwa-card
      ref={cardRef}
    >
      <div className="flex items-start gap-3">
        <img
          src="/pwa-icon-192.png"
          alt=""
          aria-hidden="true"
          className="h-10 w-10 flex-none rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900" id={headingId}>{title}</h2>
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
  const appleStepsRef = useRef<HTMLOListElement>(null);

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
    if (showAppleSteps) appleStepsRef.current?.focus();
  }, [showAppleSteps]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const serviceWorker = navigator.serviceWorker;

    const handleControllerChange = () => {
      if (!reloadOnControllerChangeRef.current) return;
      reloadOnControllerChangeRef.current = false;
      window.location.reload();
    };

    serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );
    return () =>
      serviceWorker.removeEventListener(
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
            className="min-h-11 rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
          >
            {activatingUpdate ? "Updating…" : "Update now"}
          </button>
          <button
            type="button"
            onClick={() => setWaitingWorker(null)}
            className="min-h-11 rounded-lg border border-gray-500 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
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
            className="min-h-11 rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
          >
            {installing ? "Opening…" : "Install app"}
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            className="min-h-11 rounded-lg border border-gray-500 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
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
            <ol
              className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700 focus:outline-none"
              id="apple-install-steps"
              ref={appleStepsRef}
              tabIndex={-1}
            >
              <li>Open the browser Share menu.</li>
              <li>Select “Add to Home Screen”.</li>
              <li>Confirm by tapping “Add”.</li>
            </ol>
            <button
              type="button"
              onClick={dismissInstall}
              className="mt-3 min-h-11 rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
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
                aria-controls="apple-install-steps"
                aria-expanded="false"
                type="button"
                onClick={() => setShowAppleSteps(true)}
                className="min-h-11 rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Show steps
              </button>
              <button
                type="button"
                onClick={dismissInstall}
                className="min-h-11 rounded-lg border border-gray-500 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
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
