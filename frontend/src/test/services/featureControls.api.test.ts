import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FeatureControlsApiClient,
  type UpdateAlumniNetworkModeInput,
} from "../../services/api/featureControls.api";

const validResponse = {
  success: true,
  data: {
    version: 1,
    revision: 4,
    alumniNetwork: { mode: "off", readable: false, writable: false },
  },
};

function responseFor(data: unknown): Pick<Response, "ok" | "json" | "status"> {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  };
}

describe("FeatureControlsApiClient", () => {
  const fetchMock = vi.fn();
  const client = new FeatureControlsApiClient("https://api.example.test/api");

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("authToken", "test-token");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and strictly decodes the protected no-store runtime control", async () => {
    fetchMock.mockResolvedValueOnce(responseFor(validResponse));
    const controller = new AbortController();

    await expect(client.get(controller.signal)).resolves.toEqual(
      validResponse.data,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/system/feature-controls",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("rejects malformed protected runtime DTOs", async () => {
    fetchMock.mockResolvedValueOnce(
      responseFor({
        ...validResponse,
        data: {
          ...validResponse.data,
          alumniNetwork: { mode: "on", readable: true, writable: false },
        },
      }),
    );

    await expect(client.get()).rejects.toThrow(
      "Invalid runtime configuration response",
    );
  });

  it("sends only the exact revisioned PATCH body", async () => {
    const input: UpdateAlumniNetworkModeInput = {
      mode: "on",
      expectedRevision: 4,
    };
    const updated = {
      success: true,
      data: {
        version: 1,
        revision: 5,
        alumniNetwork: { mode: "on", readable: true, writable: true },
      },
    };
    fetchMock.mockResolvedValueOnce(responseFor(updated));

    await expect(client.updateAlumniNetworkMode(input)).resolves.toEqual(
      updated.data,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/system/feature-controls/alumni-network",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify(input),
        credentials: "include",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it.each([
    { mode: "unknown", expectedRevision: 4 },
    { mode: "on", expectedRevision: -1 },
    { mode: "on", expectedRevision: Number.MAX_SAFE_INTEGER },
  ])("rejects invalid input before making a request", async (input) => {
    await expect(
      client.updateAlumniNetworkMode(input as UpdateAlumniNetworkModeInput),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
