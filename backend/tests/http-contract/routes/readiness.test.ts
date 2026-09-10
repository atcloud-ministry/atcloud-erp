import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
}));

vi.mock(
  "../../../src/services/operations/ApplicationReadinessService",
  () => ({
    applicationReadinessService: {
      getSnapshot: mocks.getSnapshot,
    },
  }),
);

import readinessRoutes from "../../../src/routes/readiness";

function buildApp() {
  const app = express();
  app.use("/api/readiness", readinessRoutes);
  return app;
}

function expectPublicProbeShape(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(
    ["status", "success", "timestamp", "version"].sort(),
  );
  expect(body.version).toBe(1);
  expect(typeof body.timestamp).toBe("string");
  expect(Number.isNaN(Date.parse(body.timestamp as string))).toBe(false);

  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("components");
  expect(serialized).not.toContain("database");
  expect(serialized).not.toContain("reliability");
  expect(serialized).not.toContain("feature_control");
  expect(serialized).not.toContain("alumniNetworkMode");
  expect(serialized).not.toContain("private-component-detail");
}

describe("readiness probe routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a non-cacheable 200 without internal components when ready", async () => {
    mocks.getSnapshot.mockResolvedValue({
      ready: true,
      components: {
        database: true,
        reliability: true,
        feature_control: true,
        private_component_detail: "private-component-detail",
      },
      alumniNetworkMode: "on",
    });

    const response = await request(buildApp())
      .get("/api/readiness")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe("ready");
    expectPublicProbeShape(response.body);
  });

  it("returns a non-cacheable 503 without internal components when not ready", async () => {
    mocks.getSnapshot.mockResolvedValue({
      ready: false,
      components: {
        database: false,
        reliability: false,
        feature_control: false,
        private_component_detail: "private-component-detail",
      },
      alumniNetworkMode: "off",
    });

    const response = await request(buildApp())
      .get("/api/readiness")
      .expect(503);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.success).toBe(false);
    expect(response.body.status).toBe("not_ready");
    expectPublicProbeShape(response.body);
  });

  it("fails closed with the same minimal response when snapshot evaluation rejects", async () => {
    mocks.getSnapshot.mockRejectedValue(
      new Error("private dependency failure"),
    );

    const response = await request(buildApp())
      .get("/api/readiness")
      .expect(503);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.success).toBe(false);
    expect(response.body.status).toBe("not_ready");
    expectPublicProbeShape(response.body);
    expect(response.text).not.toContain("private dependency failure");
  });

  it("keeps the liveness probe independent, successful, and non-cacheable", async () => {
    mocks.getSnapshot.mockRejectedValue(
      new Error("private dependency failure"),
    );

    const response = await request(buildApp())
      .get("/api/readiness/live")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe("alive");
    expectPublicProbeShape(response.body);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });
});
