import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import apiRoutes from "../../../src/routes";

const app = express();
app.use(express.json());
app.use("/api", apiRoutes);

describe("alumni self-service production entrypoints", () => {
  it.each([
    ["get", "/api/admin/alumni-imports"],
    ["post", "/api/admin/alumni-imports/dry-run"],
    ["get", "/api/admin/alumni-invitations"],
    ["post", "/api/admin/alumni-invitations/507f1f77bcf86cd799439011/reissue"],
    ["post", "/api/alumni-invitations/claim"],
  ] as const)("does not expose retired %s %s", async (method, path) => {
    const response = await request(app)[method](path);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      message: `Route ${path} not found`,
    });
  });

  it("still mounts the self-service Directory", async () => {
    const response = await request(app).get("/api/directory/me");

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.message).not.toMatch(/Route .* not found/);
  });
});
