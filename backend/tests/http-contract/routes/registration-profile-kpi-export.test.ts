import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permissionCheck: vi.fn(),
  exportLimiter: vi.fn(),
  exportRegistrationProfileKpis: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get("Authorization");
    if (!authorization) {
      res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
      return;
    }
    req.user = {
      _id: "507f1f77bcf86cd799439011",
      role:
        authorization === "Bearer participant" ? "Participant" : "Leader",
      isActive: true,
      isVerified: true,
    } as Request["user"];
    next();
  },
  authorizePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      mocks.permissionCheck(permission);
      if (req.user?.role === "Participant") {
        res.status(403).json({
          success: false,
          message: "Insufficient permissions.",
        });
        return;
      }
      next();
    },
}));

vi.mock("../../../src/middleware/rateLimiting", () => ({
  analyticsLimiter: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
  exportLimiter: (req: Request, res: Response, next: NextFunction) => {
    mocks.exportLimiter(req.path);
    next();
  },
}));

vi.mock(
  "../../../src/controllers/analytics/RegistrationProfileKpiExportController",
  () => ({
    default: {
      exportRegistrationProfileKpis:
        mocks.exportRegistrationProfileKpis,
    },
  }),
);

vi.mock("../../../src/controllers/analytics/OverviewAnalyticsController", () => ({
  default: { getAnalytics: vi.fn() },
}));
vi.mock("../../../src/controllers/analytics/UserAnalyticsController", () => ({
  default: { getUserAnalytics: vi.fn() },
}));
vi.mock("../../../src/controllers/analytics/EventAnalyticsController", () => ({
  default: { getEventAnalytics: vi.fn() },
}));
vi.mock(
  "../../../src/controllers/analytics/EngagementAnalyticsController",
  () => ({ default: { getEngagementAnalytics: vi.fn() } }),
);
vi.mock(
  "../../../src/controllers/analytics/AttendanceAnalyticsController",
  () => ({ default: { getAttendanceAnalytics: vi.fn() } }),
);
vi.mock("../../../src/controllers/analytics/ProgramAnalyticsController", () => ({
  default: { getProgramAnalytics: vi.fn() },
}));
vi.mock("../../../src/controllers/analytics/DonationAnalyticsController", () => ({
  default: { getDonationAnalytics: vi.fn() },
}));
vi.mock(
  "../../../src/controllers/analytics/FinancialAnalyticsController",
  () => ({ default: { getFinancialSummary: vi.fn() } }),
);
vi.mock("../../../src/controllers/analytics/TrendsAnalyticsController", () => ({
  default: { getTrends: vi.fn() },
}));
vi.mock("../../../src/controllers/analytics/ExportAnalyticsController", () => ({
  default: { exportAnalytics: vi.fn() },
}));

import analyticsRoutes from "../../../src/routes/analytics";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

function buildApp() {
  const app = express();
  app.use("/api/analytics", analyticsRoutes);
  return app;
}

describe("registration profile KPI export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportRegistrationProfileKpis.mockImplementation(
      (_req: Request, res: Response) => {
        res.status(200).json({ success: true, route: "kpi-export" });
      },
    );
  });

  it("requires authentication before running the export", async () => {
    await request(buildApp())
      .get("/api/analytics/registration-profile-kpis/export?format=json")
      .expect(401);

    expect(mocks.exportLimiter).not.toHaveBeenCalled();
    expect(mocks.exportRegistrationProfileKpis).not.toHaveBeenCalled();
  });

  it("requires VIEW_SYSTEM_ANALYTICS before running the export", async () => {
    await request(buildApp())
      .get("/api/analytics/registration-profile-kpis/export?format=csv")
      .set("Authorization", "Bearer participant")
      .expect(403);

    expect(mocks.permissionCheck).toHaveBeenCalledWith(
      PERMISSIONS.VIEW_SYSTEM_ANALYTICS,
    );
    expect(mocks.exportLimiter).not.toHaveBeenCalled();
    expect(mocks.exportRegistrationProfileKpis).not.toHaveBeenCalled();
  });

  it("wires an authorized request through exportLimiter to the KPI controller", async () => {
    const response = await request(buildApp())
      .get("/api/analytics/registration-profile-kpis/export?format=xlsx")
      .set("Authorization", "Bearer leader")
      .expect(200);

    expect(response.body).toEqual({ success: true, route: "kpi-export" });
    expect(mocks.permissionCheck).toHaveBeenCalledWith(
      PERMISSIONS.VIEW_SYSTEM_ANALYTICS,
    );
    expect(mocks.exportLimiter).toHaveBeenCalledWith(
      "/registration-profile-kpis/export",
    );
    expect(mocks.exportRegistrationProfileKpis).toHaveBeenCalledOnce();
  });
});
