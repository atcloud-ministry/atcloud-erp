import { afterEach, describe, expect, it, vi } from "vitest";
import { authService } from "../../services/api/auth.api";

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registration privacy notice API", () => {
  it("loads the exact server-owned notice contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        notice: {
          version: "registration-privacy-v1",
          text: "Registration privacy notice.",
          effectiveAt: "2026-09-18T00:00:00.000Z",
        },
      }),
    );

    await expect(authService.getRegistrationNotice()).resolves.toEqual({
      version: "registration-privacy-v1",
      text: "Registration privacy notice.",
      effectiveAt: "2026-09-18T00:00:00.000Z",
    });
  });

  it("rejects unknown fields and invalid dates", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          notice: {
            version: "registration-privacy-v1",
            text: "Registration privacy notice.",
            effectiveAt: "2026-09-18T00:00:00.000Z",
            documentHash: "private",
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          notice: {
            version: "registration-privacy-v1",
            text: "Registration privacy notice.",
            effectiveAt: "not-a-date",
          },
        }),
      );

    await expect(authService.getRegistrationNotice()).rejects.toThrow(
      "Invalid registration notice response",
    );
    await expect(authService.getRegistrationNotice()).rejects.toThrow(
      "Invalid registration notice response",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
