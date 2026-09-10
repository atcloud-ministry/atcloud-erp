import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn((req, _res, next) => {
    req.userId = "507f1f77bcf86cd799439011";
    req.user = { role: "Super Admin" };
    next();
  }),
  permissionChecks: vi.fn(),
  authorizePermission: vi.fn(
    (permission) => (_req, _res, next) => {
      mocks.permissionChecks(permission);
      next();
    },
  ),
  getStatusSnapshot: vi.fn(),
  execute: vi.fn(),
  isClientError: vi.fn(),
  isConflict: vi.fn(),
  isCommitUncertain: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: mocks.authenticate,
  authorizePermission: mocks.authorizePermission,
}));

vi.mock("../../../src/services/operations/RecoveryControlService", () => ({
  recoveryControlService: {
    getStatusSnapshot: mocks.getStatusSnapshot,
    executeNotificationOutboxReconciliation: mocks.execute,
  },
  isRecoveryControlClientError: mocks.isClientError,
  isRecoveryControlConflict: mocks.isConflict,
  isRecoveryControlCommitUncertain: mocks.isCommitUncertain,
}));

vi.mock("../../../src/services/CorrelatedLogger", () => ({
  CorrelatedLogger: {
    fromRequest: () => ({ error: mocks.logError, warn: mocks.logWarn }),
  },
}));

import recoveryControlRoutes from "../../../src/routes/recoveryControls";
import { PERMISSIONS } from "../../../src/utils/roleUtils";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = "correlation-1";
    next();
  });
  app.use("/api/system/recovery", recoveryControlRoutes);
  return app;
}

describe("recovery control routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatusSnapshot.mockResolvedValue({
      operation: "notification_outbox_reconcile",
      backlog: { pending: 2, processing: 1, dead: 0 },
      recoverable: { expiredLeases: 1, exhaustedAttempts: 0 },
    });
    mocks.execute.mockResolvedValue({
      operation: "notification_outbox_reconcile",
      recoveredExpiredLeases: 1,
      deadLetteredExhausted: 0,
      receiptId: "507f1f77bcf86cd799439012",
      replayed: false,
    });
    mocks.isClientError.mockReturnValue(false);
    mocks.isConflict.mockReturnValue(false);
    mocks.isCommitUncertain.mockReturnValue(false);
  });

  it("requires system-settings authorization for every route", async () => {
    await request(makeApp()).get("/api/system/recovery").expect(200);
    expect(mocks.permissionChecks).toHaveBeenCalledWith(
      PERMISSIONS.MANAGE_SYSTEM_SETTINGS,
    );
  });

  it("returns the payload-free recovery snapshot with no-store", async () => {
    const response = await request(makeApp())
      .get("/api/system/recovery")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: {
        operation: "notification_outbox_reconcile",
        backlog: { pending: 2, processing: 1, dead: 0 },
        recoverable: { expiredLeases: 1, exhaustedAttempts: 0 },
      },
    });
  });

  it("executes a bounded idempotent reconciliation request", async () => {
    const response = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({ limit: 25 })
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.execute).toHaveBeenCalledWith({
      actor: {
        id: "507f1f77bcf86cd799439011",
        role: "Super Admin",
      },
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      limit: 25,
      correlationId: "correlation-1",
    });
    expect(response.body.data).toMatchObject({
      recoveredExpiredLeases: 1,
      replayed: false,
    });
  });

  it("rejects a write without an idempotency key", async () => {
    const response = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .send({ limit: 25 })
      .expect(400);

    expect(response.body.code).toBe("RECOVERY_CONTROL_INPUT_INVALID");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects unknown request fields before executing recovery", async () => {
    const response = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({ limit: 25, unexpected: true })
      .expect(400);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.code).toBe("RECOVERY_CONTROL_INPUT_INVALID");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps validation and idempotency conflicts without leaking errors", async () => {
    const failure = new Error("private-payload");
    mocks.execute.mockRejectedValue(failure);
    mocks.isClientError.mockReturnValueOnce(true);

    const invalid = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .set("Idempotency-Key", "invalid")
      .send({ limit: 25 })
      .expect(400);
    expect(JSON.stringify(invalid.body)).not.toContain("private-payload");

    mocks.isClientError.mockReturnValueOnce(false);
    mocks.isConflict.mockReturnValueOnce(true);
    const conflict = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({ limit: 25 })
      .expect(409);
    expect(conflict.body.code).toBe("RECOVERY_CONTROL_CONFLICT");
    expect(JSON.stringify(conflict.body)).not.toContain("private-payload");
  });

  it("fails closed when recovery status or execution is unavailable", async () => {
    mocks.getStatusSnapshot.mockRejectedValueOnce(new Error("private-status"));
    const status = await request(makeApp())
      .get("/api/system/recovery")
      .expect(503);
    expect(status.body.code).toBe("RECOVERY_STATUS_UNAVAILABLE");
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(status.body)).not.toContain("private-status");

    mocks.execute.mockRejectedValueOnce(new Error("private-operation"));
    const execution = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({ limit: 25 })
      .expect(503);
    expect(execution.body.code).toBe("RECOVERY_OPERATION_UNAVAILABLE");
    expect(JSON.stringify(execution.body)).not.toContain("private-operation");
  });

  it("instructs operators to replay an uncertain commit with the same key", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("private-commit-result"));
    mocks.isCommitUncertain.mockReturnValueOnce(true);

    const response = await request(makeApp())
      .post("/api/system/recovery/notification-outbox/reconcile")
      .set("Idempotency-Key", "11111111-1111-4111-8111-111111111111")
      .send({ limit: 25 })
      .expect(503);

    expect(response.body).toEqual({
      success: false,
      message:
        "The recovery result is uncertain. Retry with the same Idempotency-Key.",
      code: "RECOVERY_COMMIT_UNCERTAIN",
    });
    expect(JSON.stringify(response.body)).not.toContain("private-commit-result");
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "Recovery operation outcome uncertain",
      "RecoveryControlService",
      {
        failure: {
          name: "Error",
        },
      },
    );
  });
});
