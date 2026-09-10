import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeConfigDTO } from "../../../src/contracts/runtimeConfig";
import { createAlumniNetworkFeatureGate } from "../../../src/middleware/alumniNetworkFeatureGate";

function responseHarness() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const setHeader = vi.fn();
  return {
    response: { status, setHeader } as unknown as Response,
    json,
    status,
    setHeader,
  };
}

describe("alumni network HTTP feature gate", () => {
  it.each([
    ["read", "off", false],
    ["read", "read_only", true],
    ["read", "on", true],
    ["write", "off", false],
    ["write", "read_only", false],
    ["write", "on", true],
  ] as const)(
    "%s access in %s mode is allowed=%s",
    async (capability, mode, allowed) => {
      const reader = {
        getRuntimeConfig: vi.fn().mockResolvedValue(
          createRuntimeConfigDTO(mode, 3),
        ),
      };
      const next = vi.fn() as NextFunction;
      const response = responseHarness();

      await createAlumniNetworkFeatureGate(capability, reader)(
        {} as Request,
        response.response,
        next,
      );

      expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(response.status).toHaveBeenCalledTimes(allowed ? 0 : 1);
      if (!allowed) {
        expect(response.status).toHaveBeenCalledWith(503);
        expect(response.setHeader).toHaveBeenCalledWith(
          "Cache-Control",
          "no-store",
        );
      }
    },
  );

  it("fails closed when the runtime control cannot be read", async () => {
    const reader = {
      getRuntimeConfig: vi.fn().mockRejectedValue(new Error("database secret")),
    };
    const next = vi.fn() as NextFunction;
    const response = responseHarness();

    await createAlumniNetworkFeatureGate("read", reader)(
      {} as Request,
      response.response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: "The alumni network is temporarily unavailable.",
      code: "ALUMNI_NETWORK_READ_UNAVAILABLE",
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      "database secret",
    );
  });

  it("does not trust inconsistent capability booleans", async () => {
    const reader = {
      getRuntimeConfig: vi.fn().mockResolvedValue({
        success: true,
        data: {
          version: 1,
          revision: 1,
          alumniNetwork: { mode: "off", readable: true, writable: true },
        },
      }),
    };
    const next = vi.fn() as NextFunction;
    const response = responseHarness();

    await createAlumniNetworkFeatureGate("write", reader)(
      {} as Request,
      response.response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
  });
});
