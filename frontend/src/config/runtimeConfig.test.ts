import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl } from "../lib/apiClient";
import {
  fetchRuntimeConfig,
  parseRuntimeConfigResponse,
} from "./runtimeConfig";

function responseFor(
  data: unknown,
  options: { ok?: boolean } = {},
): Pick<Response, "ok" | "json"> {
  return {
    ok: options.ok ?? true,
    json: vi.fn().mockResolvedValue(data),
  };
}

describe("runtime configuration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["off", false, false],
    ["read_only", true, false],
    ["on", true, true],
  ] as const)(
    "accepts a valid %s alumni-network projection",
    (mode, readable, writable) => {
      const config = parseRuntimeConfigResponse({
        success: true,
        data: {
          version: 1,
          revision: 7,
          alumniNetwork: { mode, readable, writable },
        },
      });

      expect(config).toEqual({
        version: 1,
        revision: 7,
        alumniNetwork: { mode, readable, writable },
      });
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.alumniNetwork)).toBe(true);
    },
  );

  it.each([
    null,
    {},
    { success: false, data: {} },
    {
      success: true,
      data: {
        version: 2,
        revision: 1,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    },
    {
      success: true,
      data: {
        version: 1,
        revision: -1,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    },
    {
      success: true,
      data: {
        version: 1,
        revision: 1,
        alumniNetwork: { mode: "on", readable: true, writable: false },
      },
    },
    {
      success: true,
      data: {
        version: 1,
        revision: 1,
        alumniNetwork: {
          mode: "off",
          readable: false,
          writable: false,
          unexpected: true,
        },
      },
    },
    {
      success: true,
      data: {
        version: 1,
        revision: 1,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
      unexpected: true,
    },
  ])("rejects a malformed or expanded DTO", (payload) => {
    expect(() => parseRuntimeConfigResponse(payload)).toThrow(
      "Invalid runtime configuration response",
    );
  });

  it("fetches the public endpoint as a no-store GET", async () => {
    const payload = {
      success: true,
      data: {
        version: 1,
        revision: 3,
        alumniNetwork: { mode: "read_only", readable: true, writable: false },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(responseFor(payload));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(fetchRuntimeConfig(controller.signal)).resolves.toEqual(
      payload.data,
    );
    expect(fetchMock).toHaveBeenCalledWith(apiUrl("/runtime-config"), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it("rejects unsuccessful HTTP responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(responseFor({}, { ok: false })),
    );

    await expect(fetchRuntimeConfig()).rejects.toThrow(
      "Unable to load runtime configuration",
    );
  });
});
