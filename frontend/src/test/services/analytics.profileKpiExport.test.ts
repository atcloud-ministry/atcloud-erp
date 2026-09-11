import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsService } from "../../services/api/analytics.api";

describe("registration profile KPI export API", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("requests the dedicated privacy-protected export with authentication", async () => {
    localStorage.setItem("authToken", "test-token");
    const exportedBlob = new Blob(["workbook"]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(exportedBlob),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyticsService.exportRegistrationProfileKpis(
      "xlsx",
    );

    expect(result).toBe(exportedBlob);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/analytics\/registration-profile-kpis\/export\?format=xlsx$/,
      ),
      {
        headers: { Authorization: "Bearer test-token" },
      },
    );
  });

  it("does not turn an unsuccessful response into a download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false }),
    );

    await expect(
      analyticsService.exportRegistrationProfileKpis("json"),
    ).rejects.toThrow("Failed to export registration profile KPIs");
  });
});
