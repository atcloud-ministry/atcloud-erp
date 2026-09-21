import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { apiClient } from "../../services/api";
import {
  handleSessionExpired,
  __resetSessionPromptFlag,
} from "../../services/session";

describe("Session expired prompt and redirect", () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetSessionPromptFlag();
    // Fresh token to be cleared
    localStorage.setItem("authToken", "test-token");
    sessionStorage.clear();
    // Mock alert
    vi.spyOn(window, "alert").mockImplementation(() => {});
    // Mock location.assign
    // jsdom's window.location is read-only; replace with a mockable object
    delete (window as any).location;
    (window as any).location = {
      assign: vi.fn(),
      hash: "",
    } as unknown as Location;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Restore original fetch if we changed it
    if (originalFetch) (globalThis as any).fetch = originalFetch;
    // Restore original location
    delete (window as any).location;
    (window as any).location = originalLocation;
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows a single fallback prompt (no listeners) and schedules redirect", async () => {
    handleSessionExpired();
    handleSessionExpired(); // idempotent second call

    expect(window.alert).toHaveBeenCalledTimes(1);
    expect(window.alert).toHaveBeenCalledWith(
      "Your session has expired. Please sign in again."
    );
    await vi.runAllTimersAsync();
    const assign = (window.location as any).assign as ReturnType<typeof vi.fn>;
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/#/login");
    expect(localStorage.getItem("authToken")).toBeNull();
  });

  it("captures a cold notification hash route before the fallback redirect", async () => {
    (window.location as unknown as { hash: string }).hash =
      "#/dashboard/chat-rooms/507f1f77bcf86cd799439011#latest";

    handleSessionExpired();

    expect(sessionStorage.getItem("returnUrl")).toBe(
      "/dashboard/chat-rooms/507f1f77bcf86cd799439011#latest",
    );
  });

  it("triggers fallback prompt via ApiClient on 401 with failed refresh", async () => {
    // Intercept fetch to force 401 for the endpoint and for refresh-token
    const mocked = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : (input as Request).url ?? String(input);
        let pathname = "";
        try {
          pathname = new URL(url).pathname;
        } catch {
          pathname = url;
        }
        const status401 = 401;
        const json = { success: false, message: "Token has expired." };
        const resp = new Response(JSON.stringify(json), {
          status: status401,
          headers: { "Content-Type": "application/json" },
        });
        if (pathname.includes("/auth/refresh-token")) return resp;
        if (pathname.includes("/users/stats")) return resp;
        // Default: pass-through to original if available
        return originalFetch!(input as any, init);
      }
    );
    (globalThis as any).fetch = mocked;

    await expect(apiClient.getUserStats()).rejects.toThrow();

    expect(window.alert).toHaveBeenCalledTimes(1);
    expect(window.alert).toHaveBeenCalledWith(
      "Your session has expired. Please sign in again."
    );
    await vi.runAllTimersAsync();
    const assign = (window.location as any).assign as ReturnType<typeof vi.fn>;
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/#/login");
    expect(localStorage.getItem("authToken")).toBeNull();
  });

  it("preserves the token when refresh cannot reach the network", async () => {
    const mocked = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("/auth/refresh-token")) {
          throw new TypeError("Failed to fetch");
        }
        return new Response(
          JSON.stringify({ success: false, message: "Token has expired." }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );
    globalThis.fetch = mocked;

    await expect(apiClient.getUserStats()).rejects.toThrow(
      /check your connection and try again/i,
    );

    expect(localStorage.getItem("authToken")).toBe("test-token");
    expect(window.alert).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("preserves the token when refresh returns a temporary server error", async () => {
    const mocked = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes("/auth/refresh-token")) {
          return new Response(
            JSON.stringify({ success: false, message: "Temporarily unavailable" }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ success: false, message: "Token has expired." }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );
    globalThis.fetch = mocked;

    await expect(apiClient.getUserStats()).rejects.toMatchObject({
      status: 503,
    });

    expect(localStorage.getItem("authToken")).toBe("test-token");
    expect(window.alert).not.toHaveBeenCalled();
  });
});
