import type { Request, Response } from "express";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistrationProfileKpisDTO } from "../../../../src/contracts/registrationProfileKpiContracts";
import RegistrationProfileKpiExportController from "../../../../src/controllers/analytics/RegistrationProfileKpiExportController";

vi.mock(
  "../../../../src/services/RegistrationProfileKpiAnalyticsService",
  () => ({
    default: {
      getRegistrationProfileKpis: vi.fn(),
    },
  }),
);

vi.mock("../../../../src/services/AuditLogService", () => ({
  AuditLogService: {
    record: vi.fn(),
  },
}));

vi.mock("../../../../src/utils/roleUtils", () => ({
  hasPermission: vi.fn(),
  PERMISSIONS: {
    VIEW_SYSTEM_ANALYTICS: "view_system_analytics",
  },
}));

import { AuditLogService } from "../../../../src/services/AuditLogService";
import RegistrationProfileKpiAnalyticsService from "../../../../src/services/RegistrationProfileKpiAnalyticsService";
import { hasPermission } from "../../../../src/utils/roleUtils";

const KPI_FIXTURE: RegistrationProfileKpisDTO = {
  minimumGroupSize: 5,
  birthYearDecades: {
    buckets: [{ startYear: 1980, endYear: 1989, count: 8 }],
    suppressionApplied: true,
  },
  residenceCountries: {
    buckets: [{ countryCode: "US", count: 8 }],
    suppressionApplied: false,
  },
  residenceRegions: {
    buckets: [{ countryCode: "US", regionCode: "US-WA", count: 8 }],
    suppressionApplied: false,
  },
  residenceCities: {
    buckets: [
      {
        countryCode: "US",
        regionCode: "US-WA",
        city: "@malicious-city",
        count: 8,
      },
    ],
    suppressionApplied: false,
  },
  employmentStatuses: {
    buckets: [{ employmentStatus: "employed", count: 8 }],
    suppressionApplied: false,
  },
  companies: {
    buckets: [{ company: "=HYPERLINK(\"https://example.invalid\")", count: 8 }],
    suppressionApplied: true,
  },
  occupations: {
    buckets: [{ occupation: "+SUM(1,1)", count: 8 }],
    suppressionApplied: false,
  },
};

describe("RegistrationProfileKpiExportController", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let setHeader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    status = vi.fn();
    json = vi.fn();
    send = vi.fn();
    setHeader = vi.fn();
    res = { status, json, send, setHeader } as unknown as Partial<Response>;
    status.mockReturnValue(res);
    req = {
      query: {},
      correlationId: "kpi-export-correlation-id",
      user: {
        _id: "507f1f77bcf86cd799439011",
        role: "Administrator",
      },
    } as unknown as Partial<Request>;

    vi.mocked(hasPermission).mockReturnValue(true);
    vi.mocked(
      RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis,
    ).mockResolvedValue(KPI_FIXTURE);
    vi.mocked(AuditLogService.record).mockResolvedValue(true);
  });

  async function run(): Promise<void> {
    await RegistrationProfileKpiExportController.exportRegistrationProfileKpis(
      req as Request,
      res as Response,
    );
  }

  it("rejects an unauthenticated direct controller call", async () => {
    req.user = undefined;

    await run();

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Authentication required.",
    });
    expect(
      RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis,
    ).not.toHaveBeenCalled();
    expect(AuditLogService.record).not.toHaveBeenCalled();
  });

  it("rejects a caller without analytics permission", async () => {
    vi.mocked(hasPermission).mockReturnValue(false);

    await run();

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message:
        "Insufficient permissions to export registration profile KPIs.",
    });
    expect(
      RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis,
    ).not.toHaveBeenCalled();
  });

  it("rejects an unsupported format without echoing it into the audit log", async () => {
    req.query = { format: "private@example.invalid" };

    await run();

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Unsupported format. Use 'json', 'csv', or 'xlsx'.",
    });
    expect(
      RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis,
    ).not.toHaveBeenCalled();
    expect(AuditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        details: {
          format: "unsupported",
          scope: "registration_profile_kpis",
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(AuditLogService.record).mock.calls)).not.toContain(
      "private@example.invalid",
    );
  });

  it("exports JSON as the exact suppressed aggregate DTO and audits safe metadata", async () => {
    req.query = { format: "json" };

    await run();

    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "attachment; filename=registration-profile-kpis.json",
    );
    expect(setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json; charset=utf-8",
    );
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toEqual(KPI_FIXTURE);
    expect(AuditLogService.record).toHaveBeenCalledWith({
      action: "analytics.registration_profile_kpis_export",
      actor: {
        type: "user",
        id: "507f1f77bcf86cd799439011",
        role: "Administrator",
      },
      source: "http",
      outcome: "success",
      correlationId: "kpi-export-correlation-id",
      details: {
        format: "json",
        scope: "registration_profile_kpis",
      },
    });

    const serialized = String(send.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("private@example.invalid");
    expect(serialized).not.toContain('"phone"');
  });

  it("defaults to a JSON attachment", async () => {
    await run();

    expect(setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "attachment; filename=registration-profile-kpis.json",
    );
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toEqual(KPI_FIXTURE);
  });

  it("exports CSV metadata and buckets with formula-safe user-controlled labels", async () => {
    req.query = { format: "csv" };

    await run();

    const csv = String(send.mock.calls[0]?.[0]);
    expect(setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "attachment; filename=registration-profile-kpis.csv",
    );
    expect(csv).toContain('"Minimum Group Size","5"');
    expect(csv).toContain('"birth_year_decade","1980-1989","8"');
    expect(csv).toContain(
      '"company","\'=HYPERLINK(""https://example.invalid"")","8"',
    );
    expect(csv).toContain('"occupation","\'+SUM(1,1)","8"');
    expect(csv).toContain(
      '"residence_city","\'@malicious-city / US-WA / US","8"',
    );
    expect(csv).not.toMatch(/"(?:=|\+|@)malicious/u);
  });

  it("exports XLSX sheets with formula-safe user-controlled labels", async () => {
    req.query = { format: "xlsx" };

    await run();

    const payload = send.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect(setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "attachment; filename=registration-profile-kpis.xlsx",
    );
    const workbook = XLSX.read(payload as Buffer, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(
      workbook.Sheets["KPI Buckets"],
      { header: 1 },
    );
    const cells = rows.flat().map(String);
    expect(cells).toContain("'=HYPERLINK(\"https://example.invalid\")");
    expect(cells).toContain("'+SUM(1,1)");
    expect(cells).toContain("'@malicious-city / US-WA / US");
    expect(cells).not.toContain("private@example.invalid");
  });

  it("returns a generic 500 and audits failure when KPI generation fails", async () => {
    req.query = { format: "csv" };
    vi.mocked(
      RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis,
    ).mockRejectedValue(new Error("private database failure"));

    await run();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Failed to export registration profile KPIs.",
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain(
      "private database failure",
    );
    expect(AuditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        details: {
          format: "csv",
          scope: "registration_profile_kpis",
        },
      }),
    );
  });

  it("keeps a successful export available when best-effort auditing fails", async () => {
    vi.mocked(AuditLogService.record).mockRejectedValue(
      new Error("audit unavailable"),
    );

    await run();

    expect(status).not.toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledOnce();
  });
});
