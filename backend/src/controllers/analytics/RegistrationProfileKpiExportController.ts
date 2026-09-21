import type { Request, Response } from "express";
import * as XLSX from "xlsx";
import type { RegistrationProfileKpisDTO } from "../../contracts/registrationProfileKpiContracts";
import { AuditLogService } from "../../services/AuditLogService";
import RegistrationProfileKpiAnalyticsService from "../../services/RegistrationProfileKpiAnalyticsService";
import { hasPermission, PERMISSIONS } from "../../utils/roleUtils";

const KPI_EXPORT_SCOPE = "registration_profile_kpis" as const;
const KPI_EXPORT_FILENAME = "registration-profile-kpis" as const;

type KpiExportFormat = "json" | "csv" | "xlsx";
type AuditedKpiExportFormat = KpiExportFormat | "unsupported";

interface KpiExportRow {
  dimension: string;
  group: string;
  count: number;
}

interface KpiPrivacyRow {
  dimension: string;
  suppressionApplied: boolean;
}

function parseFormat(value: unknown): KpiExportFormat | null {
  if (value === undefined) return "json";
  if (value === "json" || value === "csv" || value === "xlsx") return value;
  return null;
}

/**
 * Prevent a user-controlled label from becoming a formula when a CSV/XLSX
 * export is opened in spreadsheet software. Leading whitespace is included
 * because some importers ignore it before interpreting a formula prefix.
 */
export function spreadsheetSafeText(value: string): string {
  return /^\s*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)
    ? `'${value}`
    : value;
}

function csvCell(value: string | number | boolean): string {
  const text =
    typeof value === "string" ? spreadsheetSafeText(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function flattenRegistrationProfileKpis(
  kpis: RegistrationProfileKpisDTO,
): KpiExportRow[] {
  const rows: KpiExportRow[] = [];

  for (const bucket of kpis.birthYearDecades.buckets) {
    rows.push({
      dimension: "birth_year_decade",
      group: `${bucket.startYear}-${bucket.endYear}`,
      count: bucket.count,
    });
  }
  for (const bucket of kpis.residenceCountries.buckets) {
    rows.push({
      dimension: "residence_country",
      group: bucket.countryCode,
      count: bucket.count,
    });
  }
  for (const bucket of kpis.residenceRegions.buckets) {
    rows.push({
      dimension: "residence_region",
      group: `${bucket.countryCode} / ${bucket.regionCode}`,
      count: bucket.count,
    });
  }
  for (const bucket of kpis.residenceCities.buckets) {
    rows.push({
      dimension: "residence_city",
      group: [bucket.city, bucket.regionCode, bucket.countryCode]
        .filter((part): part is string => part !== null)
        .join(" / "),
      count: bucket.count,
    });
  }
  for (const bucket of kpis.employmentStatuses.buckets) {
    rows.push({
      dimension: "employment_status",
      group: bucket.employmentStatus,
      count: bucket.count,
    });
  }
  for (const bucket of kpis.companies.buckets) {
    rows.push({
      dimension: "company",
      group: bucket.company,
      count: bucket.count,
    });
  }
  for (const bucket of kpis.occupations.buckets) {
    rows.push({
      dimension: "occupation",
      group: bucket.occupation,
      count: bucket.count,
    });
  }

  return rows;
}

function privacyRows(kpis: RegistrationProfileKpisDTO): KpiPrivacyRow[] {
  return [
    {
      dimension: "birth_year_decade",
      suppressionApplied: kpis.birthYearDecades.suppressionApplied,
    },
    {
      dimension: "residence_country",
      suppressionApplied: kpis.residenceCountries.suppressionApplied,
    },
    {
      dimension: "residence_region",
      suppressionApplied: kpis.residenceRegions.suppressionApplied,
    },
    {
      dimension: "residence_city",
      suppressionApplied: kpis.residenceCities.suppressionApplied,
    },
    {
      dimension: "employment_status",
      suppressionApplied: kpis.employmentStatuses.suppressionApplied,
    },
    {
      dimension: "company",
      suppressionApplied: kpis.companies.suppressionApplied,
    },
    {
      dimension: "occupation",
      suppressionApplied: kpis.occupations.suppressionApplied,
    },
  ];
}

export function buildRegistrationProfileKpiCsv(
  kpis: RegistrationProfileKpisDTO,
): string {
  const lines = [
    ["Minimum Group Size", kpis.minimumGroupSize].map(csvCell).join(","),
    "",
    ["Dimension", "Suppression Applied"].map(csvCell).join(","),
    ...privacyRows(kpis).map((row) =>
      [row.dimension, row.suppressionApplied].map(csvCell).join(","),
    ),
    "",
    ["Dimension", "Group", "Count"].map(csvCell).join(","),
    ...flattenRegistrationProfileKpis(kpis).map((row) =>
      [row.dimension, row.group, row.count].map(csvCell).join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function buildRegistrationProfileKpiWorkbook(
  kpis: RegistrationProfileKpisDTO,
): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const privacySheet = XLSX.utils.aoa_to_sheet([
    ["Minimum Group Size", kpis.minimumGroupSize],
    [],
    ["Dimension", "Suppression Applied"],
    ...privacyRows(kpis).map((row) => [
      row.dimension,
      row.suppressionApplied ? "Yes" : "No",
    ]),
  ]);
  const bucketSheet = XLSX.utils.aoa_to_sheet([
    ["Dimension", "Group", "Count"],
    ...flattenRegistrationProfileKpis(kpis).map((row) => [
      row.dimension,
      spreadsheetSafeText(row.group),
      row.count,
    ]),
  ]);
  XLSX.utils.book_append_sheet(workbook, privacySheet, "Privacy");
  XLSX.utils.book_append_sheet(workbook, bucketSheet, "KPI Buckets");
  return workbook;
}

async function recordExportAudit(
  req: Request,
  format: AuditedKpiExportFormat,
  outcome: "success" | "failure",
): Promise<void> {
  if (!req.user) return;
  try {
    await AuditLogService.record({
      action: "analytics.registration_profile_kpis_export",
      actor: {
        type: "user",
        id: String(req.user._id),
        role: req.user.role,
      },
      source: "http",
      outcome,
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      details: {
        format,
        scope: KPI_EXPORT_SCOPE,
      },
    });
  } catch {
    // Export auditing is deliberately best effort; AuditLogService also
    // records its own write-failure metric without exposing export contents.
  }
}

function setDownloadHeaders(
  res: Response,
  format: KpiExportFormat,
): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${KPI_EXPORT_FILENAME}.${format}`,
  );
  if (format === "json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  } else if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
  } else {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }
}

export default class RegistrationProfileKpiExportController {
  static async exportRegistrationProfileKpis(
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
      return;
    }

    if (!hasPermission(req.user.role, PERMISSIONS.VIEW_SYSTEM_ANALYTICS)) {
      res.status(403).json({
        success: false,
        message: "Insufficient permissions to export registration profile KPIs.",
      });
      return;
    }

    const format = parseFormat(req.query.format);
    if (format === null) {
      await recordExportAudit(req, "unsupported", "failure");
      res.status(400).json({
        success: false,
        message: "Unsupported format. Use 'json', 'csv', or 'xlsx'.",
      });
      return;
    }

    try {
      const kpis =
        await RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis();

      let payload: string | Buffer;
      if (format === "json") {
        payload = JSON.stringify(kpis, null, 2);
      } else if (format === "csv") {
        payload = buildRegistrationProfileKpiCsv(kpis);
      } else {
        payload = XLSX.write(buildRegistrationProfileKpiWorkbook(kpis), {
          type: "buffer",
          bookType: "xlsx",
        }) as Buffer;
      }

      await recordExportAudit(req, format, "success");
      setDownloadHeaders(res, format);
      res.send(payload);
    } catch {
      await recordExportAudit(req, format, "failure");
      res.status(500).json({
        success: false,
        message: "Failed to export registration profile KPIs.",
      });
    }
  }
}
