import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeConfigProvider,
  useRuntimeConfig,
} from "../../contexts/RuntimeConfigContext";
import { createDeferred } from "../fixtures/deferred";

function responseFor(data: unknown): Pick<Response, "ok" | "json"> {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(data),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <RuntimeConfigProvider>{children}</RuntimeConfigProvider>;
}

describe("RuntimeConfigContext", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is fail-closed when the hook is used outside its provider", () => {
    const { result } = renderHook(() => useRuntimeConfig());

    expect(result.current.status).toBe("error");
    expect(result.current.config.alumniNetwork).toEqual({
      mode: "off",
      readable: false,
      writable: false,
    });
  });

  it("renders children immediately with a fail-closed loading value", async () => {
    const deferred = createDeferred<Pick<Response, "ok" | "json">>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(deferred.promise));

    const { result } = renderHook(() => useRuntimeConfig(), { wrapper });

    expect(result.current.status).toBe("loading");
    expect(result.current.config.alumniNetwork.mode).toBe("off");

    await act(async () => {
      deferred.resolve(
        responseFor({
          success: true,
          data: {
            version: 1,
            revision: 4,
            alumniNetwork: { mode: "on", readable: true, writable: true },
          },
        }),
      );
      await deferred.promise;
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.config.alumniNetwork.mode).toBe("on");
  });

  it("remains fail-closed when loading or validation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFor({
          success: true,
          data: {
            version: 1,
            revision: 5,
            alumniNetwork: { mode: "on", readable: false, writable: true },
          },
        }),
      ),
    );

    const { result } = renderHook(() => useRuntimeConfig(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.config.alumniNetwork).toEqual({
      mode: "off",
      readable: false,
      writable: false,
    });
  });

  it("fails closed while refreshing and after a refresh error", async () => {
    const initialPayload = {
      success: true,
      data: {
        version: 1,
        revision: 6,
        alumniNetwork: { mode: "on", readable: true, writable: true },
      },
    };
    const refreshDeferred = createDeferred<Pick<Response, "ok" | "json">>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responseFor(initialPayload))
      .mockReturnValueOnce(refreshDeferred.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useRuntimeConfig(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let refreshPromise: Promise<void> | undefined;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.config.alumniNetwork.mode).toBe("off");

    await act(async () => {
      refreshDeferred.reject(new Error("network unavailable"));
      await refreshPromise;
    });

    expect(result.current.status).toBe("error");
    expect(result.current.config.alumniNetwork.mode).toBe("off");
  });
});
