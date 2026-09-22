import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseApiClient } from "../../services/api/common/baseApiClient";

class TestApiClient extends BaseApiClient {
  run(signal?: AbortSignal) {
    return this.request("/test", { signal });
  }
}

describe("BaseApiClient request cancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("rejects an aborted request without reporting it as an API failure", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(abortError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(new TestApiClient().run()).rejects.toBe(abortError);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("continues to report genuine transport failures", async () => {
    const networkError = new Error("network unavailable");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(networkError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(new TestApiClient().run()).rejects.toBe(networkError);
    expect(consoleError).toHaveBeenCalledWith(
      "API Request failed:",
      networkError,
    );
  });

  it("preserves cancellation of the retried request after token refresh", async () => {
    localStorage.setItem("authToken", "expired-token");
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: vi.fn().mockResolvedValue({ success: false }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue({
          success: true,
          data: {
            accessToken: "refreshed-token",
            expiresAt: "2026-09-22T20:00:00.000Z",
          },
        }),
      } as unknown as Response)
      .mockRejectedValueOnce(abortError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(new TestApiClient().run()).rejects.toBe(abortError);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
