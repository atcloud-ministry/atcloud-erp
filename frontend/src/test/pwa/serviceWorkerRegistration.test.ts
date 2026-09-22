import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateServiceWorker,
  getServiceWorkerScriptUrl,
  registerServiceWorker,
} from "../../pwa/serviceWorkerRegistration";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "serviceWorker",
);

function createWorker(state: ServiceWorkerState = "installed") {
  return Object.assign(new EventTarget(), {
    state,
    postMessage: vi.fn(),
  }) as unknown as ServiceWorker;
}

function installServiceWorkerMock({
  controller = {},
  waiting = null,
  installing = null,
}: {
  controller?: object | null;
  waiting?: ServiceWorker | null;
  installing?: ServiceWorker | null;
} = {}) {
  const registration = Object.assign(new EventTarget(), {
    waiting,
    installing,
    update: vi.fn().mockResolvedValue(undefined),
  }) as unknown as ServiceWorkerRegistration;
  const container = Object.assign(new EventTarget(), {
    controller,
    register: vi.fn().mockResolvedValue(registration),
  }) as unknown as ServiceWorkerContainer;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: container,
  });
  return { container, registration };
}

afterEach(() => {
  if (originalServiceWorkerDescriptor) {
    Object.defineProperty(
      navigator,
      "serviceWorker",
      originalServiceWorkerDescriptor,
    );
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
});

describe("Service Worker registration", () => {
  it("uses a versioned script URL and bypasses the HTTP cache", async () => {
    const { container } = installServiceWorkerMock();

    const handle = await registerServiceWorker({ enabled: true });

    expect(container.register).toHaveBeenCalledWith("/sw.js?v=0.0.0-test", {
      scope: "/",
      updateViaCache: "none",
    });
    handle?.dispose();
    expect(getServiceWorkerScriptUrl("2.53.0 beta")).toBe(
      "/sw.js?v=2.53.0%20beta",
    );
  });

  it("reports a waiting update only when an existing worker controls the page", async () => {
    const waiting = createWorker();
    installServiceWorkerMock({ controller: {}, waiting });
    const onUpdateAvailable = vi.fn();

    const handle = await registerServiceWorker({
      enabled: true,
      onUpdateAvailable,
    });

    expect(onUpdateAvailable).toHaveBeenCalledOnce();
    expect(onUpdateAvailable).toHaveBeenCalledWith(waiting);
    handle?.dispose();

    installServiceWorkerMock({ controller: null, waiting });
    const firstInstallCallback = vi.fn();
    const firstInstallHandle = await registerServiceWorker({
      enabled: true,
      onUpdateAvailable: firstInstallCallback,
    });
    expect(firstInstallCallback).not.toHaveBeenCalled();
    firstInstallHandle?.dispose();
  });

  it("observes newly installed workers and activates only on request", async () => {
    const installing = createWorker("installing") as ServiceWorker & {
      state: ServiceWorkerState;
    };
    const { registration } = installServiceWorkerMock({ installing });
    const onUpdateAvailable = vi.fn();
    const handle = await registerServiceWorker({
      enabled: true,
      onUpdateAvailable,
    });

    registration.dispatchEvent(new Event("updatefound"));
    installing.state = "installed";
    installing.dispatchEvent(new Event("statechange"));

    expect(onUpdateAvailable).toHaveBeenCalledWith(installing);
    expect(installing.postMessage).not.toHaveBeenCalled();
    activateServiceWorker(installing);
    expect(installing.postMessage).toHaveBeenCalledWith({
      type: "SKIP_WAITING",
    });
    handle?.dispose();
  });

  it("does not register when explicitly disabled", async () => {
    const { container } = installServiceWorkerMock();
    await expect(registerServiceWorker({ enabled: false })).resolves.toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });
});
