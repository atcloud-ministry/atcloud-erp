import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ permissionCheck: vi.fn() }));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    const token = req.get("Authorization");
    if (!token) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    req.userId = "507f1f77bcf86cd799439011";
    req.userRole = token === "Bearer super-admin" ? "Super Admin" : "Participant";
    next();
  },
  authorizePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      authMocks.permissionCheck(permission);
      if (req.get("Authorization") !== "Bearer super-admin") {
        res.status(403).json({ success: false, message: "Access denied." });
        return;
      }
      next();
    },
}));

import runtimeConfigRoutes from "../../../src/routes/runtimeConfig";
import featureControlRoutes from "../../../src/routes/admin/featureControls";
import { CasConflictError } from "../../../src/services/reliability/CasService";
import { featureControlService } from "../../../src/services/runtime/FeatureControlService";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

const onDTO = {
  success: true as const,
  data: {
    version: 1 as const,
    revision: 4,
    alumniNetwork: { mode: "on" as const, readable: true, writable: true },
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/runtime-config", runtimeConfigRoutes);
  app.use("/admin/feature-controls", featureControlRoutes);
  return app;
}

describe("feature control HTTP contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authMocks.permissionCheck.mockClear();
  });

  it("serves the exact public DTO without authentication or caching", async () => {
    vi.spyOn(featureControlService, "getRuntimeConfig").mockResolvedValue(onDTO);
    const response = await request(buildApp()).get("/runtime-config");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual(onDTO);
    expect(Object.keys(response.body)).toEqual(["success", "data"]);
    expect(Object.keys(response.body.data)).toEqual([
      "version",
      "revision",
      "alumniNetwork",
    ]);
    expect(Object.keys(response.body.data.alumniNetwork)).toEqual([
      "mode",
      "readable",
      "writable",
    ]);
  });

  it("fails a public read closed with a non-cacheable off DTO", async () => {
    vi.spyOn(featureControlService, "getRuntimeConfig").mockRejectedValue(
      new Error("mongodb credentials"),
    );
    const response = await request(buildApp()).get("/runtime-config");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: {
        version: 1,
        revision: 0,
        alumniNetwork: { mode: "off", readable: false, writable: false },
      },
    });
    expect(response.text).not.toContain("mongodb credentials");
  });

  it("requires MANAGE_SYSTEM_SETTINGS on both admin endpoints", async () => {
    const app = buildApp();
    const anonymousGet = await request(app).get("/admin/feature-controls");
    expect(anonymousGet.status).toBe(401);
    expect(anonymousGet.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await request(app)
          .patch("/admin/feature-controls/alumni-network")
          .send({ mode: "on", expectedRevision: 0 })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/admin/feature-controls")
          .set("Authorization", "Bearer participant")
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/admin/feature-controls/alumni-network")
          .set("Authorization", "Bearer participant")
          .send({ mode: "on", expectedRevision: 0 })
      ).status,
    ).toBe(403);
    expect(authMocks.permissionCheck).toHaveBeenCalledWith(
      PERMISSIONS.MANAGE_SYSTEM_SETTINGS,
    );
  });

  it("returns the same exact DTO from authorized GET and PATCH", async () => {
    vi.spyOn(
      featureControlService,
      "getOperationalRuntimeConfig",
    ).mockResolvedValue(onDTO);
    const update = vi
      .spyOn(featureControlService, "updateAlumniNetworkMode")
      .mockResolvedValue(onDTO);
    const app = buildApp();

    const getResponse = await request(app)
      .get("/admin/feature-controls")
      .set("Authorization", "Bearer super-admin");
    const patchResponse = await request(app)
      .patch("/admin/feature-controls/alumni-network")
      .set("Authorization", "Bearer super-admin")
      .send({ mode: "on", expectedRevision: 3 });

    expect(getResponse.status).toBe(200);
    expect(patchResponse.status).toBe(200);
    expect(getResponse.headers["cache-control"]).toBe("no-store");
    expect(patchResponse.headers["cache-control"]).toBe("no-store");
    expect(getResponse.body).toEqual(onDTO);
    expect(patchResponse.body).toEqual(onDTO);
    expect(update).toHaveBeenCalledWith({
      mode: "on",
      expectedRevision: 3,
      actorId: "507f1f77bcf86cd799439011",
      actorRole: "Super Admin",
    });
  });

  it("fails the authorized control read closed when storage is unavailable", async () => {
    vi.spyOn(
      featureControlService,
      "getOperationalRuntimeConfig",
    ).mockRejectedValue(new Error("private storage failure"));

    const response = await request(buildApp())
      .get("/admin/feature-controls")
      .set("Authorization", "Bearer super-admin")
      .expect(503);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.code).toBe("FEATURE_CONTROL_UNAVAILABLE");
    expect(response.text).not.toContain("private storage failure");
  });

  it("rejects unknown PATCH fields before invoking the service", async () => {
    const update = vi.spyOn(featureControlService, "updateAlumniNetworkMode");
    const response = await request(buildApp())
      .patch("/admin/feature-controls/alumni-network")
      .set("Authorization", "Bearer super-admin")
      .send({ mode: "on", expectedRevision: 0, reason: "not accepted" });

    expect(response.status).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(update).not.toHaveBeenCalled();
  });

  it("maps CAS conflicts without exposing internals", async () => {
    vi.spyOn(featureControlService, "updateAlumniNetworkMode").mockRejectedValue(
      new CasConflictError(2, 3, "revision_mismatch"),
    );
    const response = await request(buildApp())
      .patch("/admin/feature-controls/alumni-network")
      .set("Authorization", "Bearer super-admin")
      .send({ mode: "read_only", expectedRevision: 2 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("FEATURE_CONTROL_REVISION_CONFLICT");
    expect(response.text).not.toContain("current revision");
  });
});
