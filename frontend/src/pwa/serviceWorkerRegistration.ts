const SERVICE_WORKER_SCOPE = "/";

export interface ServiceWorkerRegistrationCallbacks {
  enabled?: boolean;
  onUpdateAvailable?: (worker: ServiceWorker) => void;
}

export interface ServiceWorkerRegistrationHandle {
  registration: ServiceWorkerRegistration;
  dispose: () => void;
}

export function getServiceWorkerScriptUrl(
  version: string = __APP_VERSION__,
): string {
  return `/sw.js?v=${encodeURIComponent(version)}`;
}

export async function registerServiceWorker({
  enabled = import.meta.env.PROD,
  onUpdateAvailable,
}: ServiceWorkerRegistrationCallbacks = {}): Promise<ServiceWorkerRegistrationHandle | null> {
  if (typeof window === "undefined" || !enabled || !("serviceWorker" in navigator)) {
    return null;
  }

  const container = navigator.serviceWorker;
  const registration = await container.register(getServiceWorkerScriptUrl(), {
    scope: SERVICE_WORKER_SCOPE,
    updateViaCache: "none",
  });

  let installingWorker: ServiceWorker | null = null;
  let lastNotifiedWorker: ServiceWorker | null = null;

  const notifyUpdate = (worker: ServiceWorker | null) => {
    if (!worker || !container.controller || worker === lastNotifiedWorker) return;
    lastNotifiedWorker = worker;
    onUpdateAvailable?.(worker);
  };

  const handleInstallingStateChange = () => {
    if (installingWorker?.state === "installed") {
      notifyUpdate(installingWorker);
    }
  };

  const handleUpdateFound = () => {
    installingWorker?.removeEventListener(
      "statechange",
      handleInstallingStateChange,
    );
    installingWorker = registration.installing;
    installingWorker?.addEventListener(
      "statechange",
      handleInstallingStateChange,
    );
  };

  registration.addEventListener("updatefound", handleUpdateFound);
  notifyUpdate(registration.waiting);

  return {
    registration,
    dispose: () => {
      registration.removeEventListener("updatefound", handleUpdateFound);
      installingWorker?.removeEventListener(
        "statechange",
        handleInstallingStateChange,
      );
    },
  };
}

export function activateServiceWorker(worker: ServiceWorker): void {
  worker.postMessage({ type: "SKIP_WAITING" });
}
