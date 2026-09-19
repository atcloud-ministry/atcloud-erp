import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authService } from "../../services/api/auth.api";
import { socketService } from "../../services/socketService";

vi.mock("../../services/socketService", () => ({
  socketService: {
    updateAuthenticationToken: vi.fn(),
  },
}));

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "locks",
);

function successfulRefresh(accessToken: string): Response {
  return new Response(
    JSON.stringify({ success: true, data: { accessToken } }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("refresh-token coordination", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalLocksDescriptor) {
      Object.defineProperty(navigator, "locks", originalLocksDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("single-flights concurrent refreshes in the same page", async () => {
    localStorage.setItem("authToken", "expired-access-token");
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = authService.refreshToken();
    const second = authService.refreshToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(successfulRefresh("replacement-access-token"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: "replacement-access-token" }),
      expect.objectContaining({ accessToken: "replacement-access-token" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(socketService.updateAuthenticationToken).toHaveBeenCalledTimes(1);
  });

  it("reuses a token rotated by another tab and synchronizes socket auth", async () => {
    localStorage.setItem("authToken", "expired-access-token");
    const request = vi.fn(
      async <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
        localStorage.setItem("authToken", "other-tab-access-token");
        return callback();
      },
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.refreshToken()).resolves.toMatchObject({
      accessToken: "other-tab-access-token",
    });
    expect(request).toHaveBeenCalledWith(
      "atcloud-refresh-token",
      expect.any(Function),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(socketService.updateAuthenticationToken).toHaveBeenCalledWith(
      "other-tab-access-token",
    );
  });
});
