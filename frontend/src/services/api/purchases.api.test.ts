import { beforeEach, describe, expect, it, vi } from "vitest";
import { purchaseService } from "./purchases.api";

describe("purchaseService.checkProgramsAccess", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("authToken", "test-token");
    vi.stubGlobal("fetch", fetchMock);
  });

  it("checks multiple program IDs in one request", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          access: [
            {
              programId: "program-1",
              hasAccess: true,
              reason: "purchased",
            },
            {
              programId: "program-2",
              hasAccess: false,
              reason: "not_purchased",
            },
          ],
        },
      }),
    });

    await expect(
      purchaseService.checkProgramsAccess(["program-1", "program-2"]),
    ).resolves.toEqual({
      "program-1": { hasAccess: true, reason: "purchased" },
      "program-2": { hasAccess: false, reason: "not_purchased" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, config] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/purchases\/check-access\/batch$/);
    expect(config).toMatchObject({
      method: "POST",
      body: JSON.stringify({ programIds: ["program-1", "program-2"] }),
    });
  });

  it("does not make a request for an empty program list", async () => {
    await expect(purchaseService.checkProgramsAccess([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
