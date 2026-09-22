import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const middlewareMocks = vi.hoisted(() => ({
  permission: vi.fn(),
  readableGate: vi.fn(),
  writableGate: vi.fn(),
  uploadLimiter: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get("Authorization");
    if (!authorization) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }
    req.userId = "507f1f77bcf86cd799439011";
    req.userRole = authorization === "Bearer admin" ? "Administrator" : "Participant";
    req.correlationId = req.get("x-correlation-id") ?? undefined;
    next();
  },
  authorizePermission:
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
      middlewareMocks.permission(permission);
      if (req.get("Authorization") !== "Bearer admin") {
        res.status(403).json({ success: false, message: "Access denied." });
        return;
      }
      next();
    },
}));

vi.mock("../../../src/middleware/alumniNetworkFeatureGate", () => ({
  requireAlumniNetworkReadable: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    middlewareMocks.readableGate();
    next();
  },
  requireAlumniNetworkWritable: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    middlewareMocks.writableGate();
    next();
  },
}));

vi.mock("../../../src/middleware/rateLimiting", () => ({
  uploadLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    middlewareMocks.uploadLimiter();
    next();
  },
}));

import adminAlumniImportRoutes from "../../../src/routes/admin/alumniImports";
import adminAlumniInvitationRoutes from "../../../src/routes/admin/alumniInvitations";
import alumniInvitationRoutes from "../../../src/routes/alumniInvitations";
import { alumniImportService } from "../../../src/services/alumni/AlumniImportService";
import { AlumniFlowError } from "../../../src/services/alumni/AlumniFlowErrors";
import { AlumniRosterCsvError } from "../../../src/services/alumni/AlumniRosterCsvParser";
import { alumniInvitationService } from "../../../src/services/alumni/AlumniInvitationService";
import { IdempotencyInProgressError } from "../../../src/services/reliability/IdempotencyService";
import {
  MongoTransactionCommitUncertainError,
  MongoTransactionRetryExhaustedError,
  MongoTransactionUnavailableError,
} from "../../../src/services/reliability/MongoTransactionService";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

const BATCH_ID = "507f191e810c19729de860ea";
const NEW_BATCH_ID = "507f191e810c19729de860eb";
const INVITATION_ID = "507f191e810c19729de860ec";
const PROFILE_ID = "507f191e810c19729de860ed";
const AFFILIATION_ID = "507f191e810c19729de860ee";
const IDEMPOTENCY_KEY = "3f00aa31-36f0-4f05-8f4a-a362bf33a111";
const ROW_KEY = "a".repeat(64);

const COUNTS = Object.freeze({
  totalRows: 2,
  validRows: 2,
  invalidRows: 0,
  matchedRows: 1,
  unmatchedRows: 1,
  ambiguousRows: 0,
  approvedRows: 0,
  rejectedRows: 0,
  appliedRows: 0,
  invitationsCreated: 0,
  affiliationsCreated: 0,
});

const SUMMARY = Object.freeze({
  id: BATCH_ID,
  checksum: "b".repeat(64),
  status: "review_ready" as const,
  counts: COUNTS,
  createdById: "507f1f77bcf86cd799439011",
  rerunOfBatchId: null,
  terminalAt: null,
  rawDataAvailable: true,
  revision: 1,
  createdAt: "2026-09-12T10:00:00.000Z",
  updatedAt: "2026-09-12T10:01:00.000Z",
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/alumni-imports", adminAlumniImportRoutes);
  app.use("/api/admin/alumni-invitations", adminAlumniInvitationRoutes);
  app.use("/api/alumni-invitations", alumniInvitationRoutes);
  return app;
}

function admin(requestBuilder: request.Test): request.Test {
  return requestBuilder
    .set("Authorization", "Bearer admin")
    .set("Idempotency-Key", IDEMPOTENCY_KEY)
    .set("x-correlation-id", "roster-flow-test");
}

describe("alumni roster flow HTTP contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const mock of Object.values(middlewareMocks)) mock.mockClear();
  });

  it("requires authentication, MANAGE_USERS, and the correct feature gate", async () => {
    const app = buildApp();

    await request(app).get("/api/admin/alumni-imports").expect(401);
    await request(app)
      .get("/api/admin/alumni-imports")
      .set("Authorization", "Bearer participant")
      .expect(403);

    vi.spyOn(alumniImportService, "listBatches").mockResolvedValue({
      batches: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
        totalBatches: 0,
      },
    });
    await admin(request(app).get("/api/admin/alumni-imports")).expect(200);

    expect(middlewareMocks.permission).toHaveBeenCalledWith(
      PERMISSIONS.MANAGE_USERS,
    );
    expect(middlewareMocks.readableGate).toHaveBeenCalledOnce();
    expect(middlewareMocks.writableGate).not.toHaveBeenCalled();
  });

  it("lists invitations through the protected explicit paged DTO", async () => {
    const list = vi
      .spyOn(alumniInvitationService, "listInvitations")
      .mockResolvedValue({
        invitations: [
          {
            id: INVITATION_ID,
            status: "active",
            contactEmail: "amy@example.com",
            contactFirstName: "Amy",
            contactLastName: "Chen",
            issueCount: 2,
            tokenExpiresAt: "2026-09-26T12:00:00.000Z",
            lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
            claimedAt: null,
            revision: 1,
          },
        ],
        pagination: {
          currentPage: 2,
          totalPages: 3,
          hasNext: true,
          hasPrev: true,
          totalInvitations: 5,
        },
      });
    const app = buildApp();

    await request(app).get("/api/admin/alumni-invitations").expect(401);
    await request(app)
      .get("/api/admin/alumni-invitations")
      .set("Authorization", "Bearer participant")
      .expect(403);
    const response = await admin(
      request(app).get(
        `/api/admin/alumni-invitations?page=2&limit=2&status=active&batchId=${BATCH_ID}`,
      ),
    ).expect(200);

    expect(list).toHaveBeenCalledWith({
      page: 2,
      limit: 2,
      status: "active",
      batchId: BATCH_ID,
    });
    expect(middlewareMocks.permission).toHaveBeenCalledWith(
      PERMISSIONS.MANAGE_USERS,
    );
    expect(middlewareMocks.readableGate).toHaveBeenCalledOnce();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data.invitations[0]).toEqual({
      id: INVITATION_ID,
      status: "active",
      contactEmail: "amy@example.com",
      contactFirstName: "Amy",
      contactLastName: "Chen",
      issueCount: 2,
      tokenExpiresAt: "2026-09-26T12:00:00.000Z",
      lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
      claimedAt: null,
      revision: 1,
    });
    expect(response.text).not.toContain("tokenHash");
    expect(response.text).not.toContain("sourceImportBatchIds");

    await admin(
      request(app).get("/api/admin/alumni-invitations?unknown=true"),
    ).expect(400);
    expect(list).toHaveBeenCalledOnce();
  });

  it("lists batches and rows through strict paged admin DTOs", async () => {
    const list = vi.spyOn(alumniImportService, "listBatches").mockResolvedValue({
      batches: [SUMMARY],
      pagination: {
        currentPage: 2,
        totalPages: 4,
        hasNext: true,
        hasPrev: true,
        totalBatches: 7,
      },
    });
    const rows = vi.spyOn(alumniImportService, "listRows").mockResolvedValue({
      batchId: BATCH_ID,
      batchRevision: 1,
      rows: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
        totalRows: 0,
      },
    });
    const app = buildApp();

    const listed = await admin(
      request(app).get(
        "/api/admin/alumni-imports?page=2&limit=2&status=review_ready",
      ),
    ).expect(200);
    const rowPage = await admin(
      request(app).get(
        `/api/admin/alumni-imports/${BATCH_ID}/rows?page=1&limit=25`,
      ),
    ).expect(200);

    expect(list).toHaveBeenCalledWith({
      page: 2,
      limit: 2,
      status: "review_ready",
    });
    expect(rows).toHaveBeenCalledWith({ batchId: BATCH_ID, page: 1, limit: 25 });
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.body).toEqual({
      success: true,
      data: {
        batches: [SUMMARY],
        pagination: {
          currentPage: 2,
          totalPages: 4,
          hasNext: true,
          hasPrev: true,
          totalBatches: 7,
        },
      },
    });
    expect(rowPage.body.data).toEqual({
      batchId: BATCH_ID,
      batchRevision: 1,
      rows: [],
      pagination: {
        currentPage: 1,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
        totalRows: 0,
      },
    });
  });

  it("gets one batch and rejects malformed ids and query fields before service calls", async () => {
    const get = vi.spyOn(alumniImportService, "getBatch").mockResolvedValue(SUMMARY);
    const list = vi.spyOn(alumniImportService, "listBatches");
    const app = buildApp();

    const response = await admin(
      request(app).get(`/api/admin/alumni-imports/${BATCH_ID}`),
    ).expect(200);
    expect(response.body).toEqual({ success: true, data: SUMMARY });
    expect(get).toHaveBeenCalledWith(BATCH_ID);

    const invalid = await admin(
      request(app).get("/api/admin/alumni-imports/not-an-object-id"),
    ).expect(400);
    expect(invalid.body.code).toBe("ALUMNI_ROSTER_FLOW_INPUT_INVALID");
    expect(get).toHaveBeenCalledOnce();

    await admin(
      request(app).get("/api/admin/alumni-imports?unknown=true"),
    ).expect(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("accepts exactly one bounded roster CSV and forwards request context", async () => {
    const dryRun = vi.spyOn(alumniImportService, "dryRun").mockResolvedValue({
      replayed: false,
      batchId: BATCH_ID,
      status: "review_ready",
      revision: 0,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      matchedRows: 0,
      unmatchedRows: 1,
      ambiguousRows: 0,
    });
    const csv = Buffer.from("email,programName\nalumni@example.com,EMBA\n");
    const response = await admin(
      request(buildApp())
        .post("/api/admin/alumni-imports/dry-run")
        .attach("roster", csv, {
          filename: "roster.csv",
          contentType: "text/csv",
        }),
    ).expect(201);

    expect(middlewareMocks.uploadLimiter).toHaveBeenCalledOnce();
    expect(middlewareMocks.writableGate).toHaveBeenCalledOnce();
    expect(dryRun).toHaveBeenCalledOnce();
    expect(dryRun.mock.calls[0][0]).toMatchObject({
      actor: { id: "507f1f77bcf86cd799439011", role: "Administrator" },
      idempotencyKey: IDEMPOTENCY_KEY,
      correlationId: "roster-flow-test",
    });
    expect(dryRun.mock.calls[0][0].csv.equals(csv)).toBe(true);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toEqual({
      replayed: false,
      batchId: BATCH_ID,
      status: "review_ready",
      revision: 0,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      matchedRows: 0,
      unmatchedRows: 1,
      ambiguousRows: 0,
    });
  });

  it("rejects invalid uploads and mutation idempotency keys without leaking input", async () => {
    const dryRun = vi.spyOn(alumniImportService, "dryRun");
    const app = buildApp();

    const wrongFile = await admin(
      request(app)
        .post("/api/admin/alumni-imports/dry-run")
        .attach("roster", Buffer.from("private-contact@example.com"), {
          filename: "roster.pdf",
          contentType: "application/pdf",
        }),
    ).expect(415);
    expect(wrongFile.body.code).toBe("ALUMNI_ROSTER_FILE_TYPE_INVALID");
    expect(wrongFile.text).not.toContain("private-contact@example.com");

    const invalidKey = await request(app)
      .post("/api/admin/alumni-imports/dry-run")
      .set("Authorization", "Bearer admin")
      .set("Idempotency-Key", "not-a-uuid")
      .attach(
        "roster",
        Buffer.from("email,programName\nalumni@example.com,EMBA\n"),
        { filename: "roster.csv", contentType: "text/csv" },
      )
      .expect(400);
    expect(invalidKey.body.code).toBe("ALUMNI_ROSTER_FLOW_INPUT_INVALID");
    expect(dryRun).not.toHaveBeenCalled();
  });

  it("reviews, applies, and reruns with revision and idempotency context", async () => {
    const review = vi.spyOn(alumniImportService, "review").mockResolvedValue({
      replayed: false,
      batchId: BATCH_ID,
      status: "review_ready",
      revision: 2,
      approvedRows: 1,
      rejectedRows: 0,
      pendingReviewRows: 0,
    });
    const apply = vi.spyOn(alumniImportService, "apply").mockResolvedValue({
      replayed: false,
      batchId: BATCH_ID,
      status: "completed",
      revision: 3,
      appliedRows: 1,
      invitationsCreated: 1,
      remainingRows: 0,
    });
    const rerun = vi.spyOn(alumniImportService, "rerun").mockResolvedValue({
      replayed: false,
      sourceBatchId: BATCH_ID,
      sourceRevision: 3,
      batchId: NEW_BATCH_ID,
      status: "review_ready",
      revision: 0,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      matchedRows: 1,
      unmatchedRows: 0,
      ambiguousRows: 0,
    });
    const app = buildApp();

    const reviewed = await admin(
      request(app)
        .patch(`/api/admin/alumni-imports/${BATCH_ID}/review`)
        .send({
          expectedRevision: 1,
          decisions: [
            {
              rowNumber: 2,
              rowKey: ROW_KEY,
              eligibilityStatus: "approved",
              resolution: { matchStatus: "unmatched" },
            },
          ],
        }),
    ).expect(200);
    const applied = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 2 }),
    ).expect(200);
    const rerunResponse = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/rerun`)
        .send({ expectedRevision: 3 }),
    ).expect(201);

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: BATCH_ID,
        expectedRevision: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        decisions: [
          {
            rowNumber: 2,
            rowKey: ROW_KEY,
            eligibilityStatus: "approved",
            resolution: { matchStatus: "unmatched" },
          },
        ],
      }),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: BATCH_ID, expectedRevision: 2 }),
    );
    expect(rerun).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: BATCH_ID, expectedRevision: 3 }),
    );
    expect(reviewed.body.data.status).toBe("review_ready");
    expect(applied.body.data.status).toBe("completed");
    expect(rerunResponse.body.data).toMatchObject({
      sourceBatchId: BATCH_ID,
      batchId: NEW_BATCH_ID,
    });
  });

  it("reissues and claims invitations through explicit token-free DTOs", async () => {
    vi.spyOn(alumniInvitationService, "reissue").mockResolvedValue({
      replayed: false,
      invitationId: INVITATION_ID,
      issueCount: 2,
      tokenExpiresAt: "2026-09-26T12:00:00.000Z",
      lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
      revision: 1,
      status: "active",
    });
    vi.spyOn(alumniInvitationService, "claim").mockResolvedValue({
      replayed: false,
      invitationId: INVITATION_ID,
      alumniProfileId: PROFILE_ID,
      affiliationIds: [AFFILIATION_ID],
      claimedAt: "2026-09-12T12:05:00.000Z",
      status: "claimed",
    });
    const app = buildApp();

    const reissued = await admin(
      request(app)
        .post(`/api/admin/alumni-invitations/${INVITATION_ID}/reissue`)
        .send({ expectedRevision: 0 }),
    ).expect(200);
    const claimed = await request(app)
      .post("/api/alumni-invitations/claim")
      .set("Authorization", "Bearer participant")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ token: "A".repeat(42) + "_" })
      .expect(200);

    expect(reissued.body.data).toEqual({
      invitationId: INVITATION_ID,
      status: "active",
      issueCount: 2,
      tokenExpiresAt: "2026-09-26T12:00:00.000Z",
      lastInvitationSentAt: "2026-09-12T12:00:00.000Z",
      revision: 1,
      replayed: false,
    });
    expect(claimed.body.data).toEqual({
      invitationId: INVITATION_ID,
      status: "claimed",
      alumniProfileId: PROFILE_ID,
      affiliationIds: [AFFILIATION_ID],
      claimedAt: "2026-09-12T12:05:00.000Z",
      replayed: false,
    });
    expect(JSON.stringify({ reissued: reissued.body, claimed: claimed.body }))
      .not.toContain("tokenHash");
  });

  it("makes malformed claim tokens indistinguishable from unavailable invitations", async () => {
    const claim = vi.spyOn(alumniInvitationService, "claim");
    const app = buildApp();
    const malformed = await request(app)
      .post("/api/alumni-invitations/claim")
      .set("Authorization", "Bearer participant")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ token: "not-a-token" })
      .expect(404);
    const unknownField = await request(app)
      .post("/api/alumni-invitations/claim")
      .set("Authorization", "Bearer participant")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ token: "not-a-token", email: "private@example.com" })
      .expect(404);

    expect(malformed.body).toEqual({
      success: false,
      message: "The alumni invitation is unavailable.",
      code: "ALUMNI_INVITATION_UNAVAILABLE",
    });
    expect(unknownField.body).toEqual(malformed.body);
    expect(unknownField.text).not.toContain("private@example.com");
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns only numeric CSV structural error context", async () => {
    vi.spyOn(alumniImportService, "dryRun").mockRejectedValue(
      new AlumniRosterCsvError(
        "CSV_UNEXPECTED_QUOTE",
        "private@example.com appeared in a cell",
        { rowNumber: 7, columnNumber: 2, field: "email" },
      ),
    );
    const response = await admin(
      request(buildApp())
        .post("/api/admin/alumni-imports/dry-run")
        .attach(
          "roster",
          Buffer.from("email,programName\nalumni@example.com,EMBA\n"),
          { filename: "roster.csv", contentType: "text/csv" },
        ),
    ).expect(400);

    expect(response.body).toEqual({
      success: false,
      message: "The roster CSV is invalid.",
      code: "CSV_UNEXPECTED_QUOTE",
      context: { rowNumber: 7, columnNumber: 2 },
    });
    expect(response.text).not.toContain("field");
    expect(response.text).not.toContain("email");
  });

  it("maps known conflicts and unknown failures without exposing internals", async () => {
    const apply = vi.spyOn(alumniImportService, "apply");
    apply.mockRejectedValueOnce(
      new AlumniFlowError(
        "ALUMNI_IMPORT_REVISION_CONFLICT",
        409,
        "private current revision 17",
      ),
    );
    const app = buildApp();
    const conflict = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 1 }),
    ).expect(409);
    expect(conflict.body.code).toBe("ALUMNI_IMPORT_REVISION_CONFLICT");
    expect(conflict.text).not.toContain("17");

    apply.mockRejectedValueOnce(
      new IdempotencyInProgressError("private alumni scope"),
    );
    const inProgress = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 1 }),
    ).expect(409);
    expect(inProgress.body.code).toBe("IDEMPOTENCY_OPERATION_IN_PROGRESS");
    expect(inProgress.text).not.toContain("private alumni scope");

    apply.mockRejectedValueOnce(
      new MongoTransactionCommitUncertainError(
        3,
        new Error("private commit detail"),
      ),
    );
    const uncertain = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 1 }),
    ).expect(503);
    expect(uncertain.body.code).toBe("ALUMNI_COMMIT_UNCERTAIN");
    expect(uncertain.text).not.toContain("private commit detail");

    apply.mockRejectedValueOnce(
      new MongoTransactionUnavailableError("private topology detail"),
    );
    const transactionUnavailable = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 1 }),
    ).expect(503);
    expect(transactionUnavailable.body).toEqual({
      success: false,
      message:
        "The alumni operation is temporarily unavailable. Retry with the same Idempotency-Key.",
      code: "ALUMNI_OPERATION_UNAVAILABLE",
    });
    expect(transactionUnavailable.text).not.toContain("topology");

    apply.mockRejectedValueOnce(
      new MongoTransactionRetryExhaustedError(
        3,
        new Error("private retry detail"),
      ),
    );
    const retryExhausted = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 1 }),
    ).expect(503);
    expect(retryExhausted.body).toEqual(transactionUnavailable.body);
    expect(retryExhausted.text).not.toContain("retry detail");

    apply.mockRejectedValueOnce(new Error("raw@example.com secret-token"));
    const unavailable = await admin(
      request(app)
        .post(`/api/admin/alumni-imports/${BATCH_ID}/apply`)
        .send({ expectedRevision: 1 }),
    ).expect(503);
    expect(unavailable.body.code).toBe("ALUMNI_OPERATION_UNAVAILABLE");
    expect(unavailable.text).not.toContain("raw@example.com");
    expect(unavailable.text).not.toContain("secret-token");
  });
});
