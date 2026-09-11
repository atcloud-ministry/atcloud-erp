import * as XLSX from "xlsx";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../../src/app";
import AuditLog from "../../../src/models/AuditLog";
import User from "../../../src/models/User";
import {
  buildTestRegistrationPayload,
  createAndLoginTestUser,
} from "../../test-utils/createTestUser";
import { ensureIntegrationDB } from "../setup/connect";

const FORMULA_COMPANY = "=SUM(1,1)";
const FORMULA_OCCUPATION = "+Engineer";
const FORMULA_CITY = "@Seattle";
const PRIVATE_PHONE_SENTINEL = "+14155550199";

function expectNoExactPrivateFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoExactPrivateFields);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  expect(record).not.toHaveProperty("phone");
  expect(record).not.toHaveProperty("birthYear");
  Object.values(record).forEach(expectNoExactPrivateFields);
}

describe("Registration profile KPI analytics and export", () => {
  beforeEach(async () => {
    await ensureIntegrationDB();
    await Promise.all([User.deleteMany({}), AuditLog.deleteMany({})]);
  });

  afterEach(async () => {
    await Promise.all([User.deleteMany({}), AuditLog.deleteMany({})]);
  });

  it("suppresses groups below five across the API and every export format", async () => {
    const admin = await createAndLoginTestUser({
      role: "Administrator",
      residenceCity: FORMULA_CITY,
      company: FORMULA_COMPANY,
      occupation: FORMULA_OCCUPATION,
    });

    for (let index = 0; index < 4; index += 1) {
      const payload = buildTestRegistrationPayload({
        username: `kpi_visible_${index}`,
        email: `kpi_visible_${index}@example.com`,
        residenceCity: FORMULA_CITY,
        company: FORMULA_COMPANY,
        occupation: FORMULA_OCCUPATION,
      });
      await request(app).post("/api/auth/register").send(payload).expect(201);
    }

    const rare = await createAndLoginTestUser({
      username: "kpi_rare_user",
      email: "kpi_rare_user@example.com",
      phone: PRIVATE_PHONE_SENTINEL,
      birthYear: 1984,
      residenceCountryCode: "CA",
      residenceRegion: "CA-ON",
      residenceCity: "Toronto",
      company: "Rare Company",
      occupation: "Rare Occupation",
    });

    const analyticsResponse = await request(app)
      .get("/api/analytics/users?includeRegistrationProfileKpis=1")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(analyticsResponse.headers["cache-control"]).toBe("no-store");
    const kpis = analyticsResponse.body.data.registrationProfileKpis;

    expect(kpis.minimumGroupSize).toBe(5);
    expect(kpis.birthYearDecades.buckets).toContainEqual({
      startYear: 1990,
      endYear: 1999,
      count: 5,
    });
    expect(kpis.birthYearDecades.buckets).not.toContainEqual(
      expect.objectContaining({ startYear: 1980 }),
    );
    expect(kpis.residenceCountries.buckets).toEqual([
      { countryCode: "US", count: 5 },
    ]);
    expect(kpis.residenceCountries.suppressionApplied).toBe(true);
    expect(kpis.residenceCities.buckets).toEqual([
      {
        countryCode: "US",
        regionCode: "US-WA",
        city: FORMULA_CITY,
        count: 5,
      },
    ]);
    expect(kpis.companies.buckets).toEqual([
      { company: FORMULA_COMPANY, count: 5 },
    ]);
    expect(kpis.occupations.buckets).toEqual([
      { occupation: FORMULA_OCCUPATION, count: 5 },
    ]);
    expect(JSON.stringify(kpis)).not.toContain("Rare Company");
    expect(JSON.stringify(kpis)).not.toContain("Rare Occupation");
    expect(JSON.stringify(kpis)).not.toContain("Toronto");
    expect(JSON.stringify(kpis)).not.toContain(PRIVATE_PHONE_SENTINEL);
    expectNoExactPrivateFields(kpis);

    expect(analyticsResponse.body.data.usersByOccupation).toEqual([
      { _id: FORMULA_OCCUPATION, count: 5 },
    ]);
    expect(
      analyticsResponse.body.data.demographics.occupationAnalytics,
    ).toEqual({
      occupationStats: { [FORMULA_OCCUPATION]: 5 },
      usersWithOccupation: 5,
      usersWithoutOccupation: 0,
      totalOccupationTypes: 1,
      topOccupations: [{ occupation: FORMULA_OCCUPATION, count: 5 }],
      occupationCompletionRate: 0,
    });

    const legacyAnalyticsResponse = await request(app)
      .get("/api/analytics/users")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(legacyAnalyticsResponse.body.data).not.toHaveProperty(
      "registrationProfileKpis",
    );
    expect(legacyAnalyticsResponse.body.data.usersByOccupation).toEqual([
      { _id: FORMULA_OCCUPATION, count: 5 },
    ]);
    expect(
      legacyAnalyticsResponse.body.data.demographics.occupationAnalytics,
    ).toEqual(analyticsResponse.body.data.demographics.occupationAnalytics);

    const jsonResponse = await request(app)
      .get("/api/analytics/registration-profile-kpis/export?format=json")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(jsonResponse.headers["cache-control"]).toBe("no-store");
    expect(jsonResponse.body).toEqual(kpis);
    expect(JSON.stringify(jsonResponse.body)).not.toContain(
      PRIVATE_PHONE_SENTINEL,
    );
    expectNoExactPrivateFields(jsonResponse.body);

    const csvResponse = await request(app)
      .get("/api/analytics/registration-profile-kpis/export?format=csv")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(csvResponse.text).toContain(`"'${FORMULA_COMPANY}"`);
    expect(csvResponse.text).toContain(`"'${FORMULA_OCCUPATION}"`);
    expect(csvResponse.text).toContain(`"'${FORMULA_CITY} / US-WA / US"`);
    expect(csvResponse.text).not.toContain("Rare Company");
    expect(csvResponse.text).not.toContain("Toronto");
    expect(csvResponse.text).not.toContain(PRIVATE_PHONE_SENTINEL);

    const xlsxResponse = await request(app)
      .get("/api/analytics/registration-profile-kpis/export?format=xlsx")
      .set("Authorization", `Bearer ${admin.token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", (error: Error) => callback(error, null));
      })
      .expect(200);
    const workbook = XLSX.read(xlsxResponse.body, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(
      workbook.Sheets["KPI Buckets"],
      { header: 1 },
    );
    const serializedRows = JSON.stringify(rows);
    expect(serializedRows).toContain(`'${FORMULA_COMPANY}`);
    expect(serializedRows).toContain(`'${FORMULA_OCCUPATION}`);
    expect(serializedRows).toContain(`'${FORMULA_CITY}`);
    expect(serializedRows).not.toContain("Rare Company");
    expect(serializedRows).not.toContain("Toronto");
    expect(serializedRows).not.toContain(PRIVATE_PHONE_SENTINEL);

    const invalidFormatResponse = await request(app)
      .get(
        "/api/analytics/registration-profile-kpis/export?format=private%40example.invalid",
      )
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(400);

    const exportAuditLogs = await AuditLog.find({
      action: "analytics.registration_profile_kpis_export",
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(exportAuditLogs).toHaveLength(4);
    expect(exportAuditLogs.map((entry) => entry.outcome)).toEqual([
      "success",
      "success",
      "success",
      "failure",
    ]);
    expect(exportAuditLogs.map((entry) => entry.details)).toEqual([
      { format: "json", scope: "registration_profile_kpis" },
      { format: "csv", scope: "registration_profile_kpis" },
      { format: "xlsx", scope: "registration_profile_kpis" },
      { format: "unsupported", scope: "registration_profile_kpis" },
    ]);
    expect(
      exportAuditLogs.every(
        (entry) =>
          typeof entry.correlationId === "string" &&
          entry.correlationId.length > 0,
      ),
    ).toBe(true);
    const serializedAuditLogs = JSON.stringify(exportAuditLogs);
    expect(serializedAuditLogs).not.toContain(PRIVATE_PHONE_SENTINEL);
    expect(serializedAuditLogs).not.toContain("private@example.invalid");
    expect(invalidFormatResponse.body.message).not.toContain(
      "private@example.invalid",
    );

    await request(app)
      .get("/api/analytics/registration-profile-kpis/export?format=json")
      .set("Authorization", `Bearer ${rare.token}`)
      .expect(403);
  });
});
