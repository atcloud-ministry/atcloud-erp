import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Response } from "express";
import mongoose from "mongoose";
import SelfUnenrollController from "../../../../src/controllers/programs/SelfUnenrollController";

vi.mock("../../../../src/models", () => ({
  AuditLog: {
    create: vi.fn(),
  },
  Program: {
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
  Purchase: {
    findOne: vi.fn(),
  },
}));

vi.mock("../../../../src/services/stripeService", () => ({
  processRefund: vi.fn(),
}));

vi.mock("../../../../src/services/email/domains/PurchaseEmailService", () => ({
  PurchaseEmailService: {
    sendRefundInitiatedEmail: vi.fn(),
    sendRefundFailedEmail: vi.fn(),
  },
}));

vi.mock("../../../../src/services/RefundRequestService", () => ({
  RefundRequestService: {
    createApprovalRequest: vi.fn(),
    notifyAdminsOfAutomaticRefund: vi.fn(),
  },
}));

vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    disconnectUser: vi.fn(),
  },
}));

import { AuditLog, Program, Purchase } from "../../../../src/models";
import { processRefund } from "../../../../src/services/stripeService";
import { PurchaseEmailService } from "../../../../src/services/email/domains/PurchaseEmailService";
import { RefundRequestService } from "../../../../src/services/RefundRequestService";
import { socketService } from "../../../../src/services/infrastructure/SocketService";

describe("SelfUnenrollController", () => {
  const programId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let mockRes: Partial<Response>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function mockPurchaseFindOneResult(result: unknown) {
    const populate = vi.fn().mockResolvedValue(result);
    const sort = vi.fn().mockReturnValue({ populate });
    vi.mocked(Purchase.findOne).mockReturnValue({ sort } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    vi.mocked(AuditLog.create).mockResolvedValue({} as any);
    vi.mocked(PurchaseEmailService.sendRefundInitiatedEmail).mockResolvedValue(
      true,
    );
    vi.mocked(processRefund).mockResolvedValue({ id: "re_unenroll_123" } as any);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("immediately unenrolls within 30 days, submits refund, and notifies admins", async () => {
    const program: any = {
      _id: programId,
      title: "Test Program",
      adminEnrollments: {
        mentees: [],
        classReps: [],
      },
      save: vi.fn().mockResolvedValue(undefined),
    };
    const purchase: any = {
      _id: new mongoose.Types.ObjectId(),
      userId,
      purchaseType: "program",
      programId: { _id: programId, title: "Test Program" },
      status: "completed",
      purchaseDate: new Date(),
      finalPrice: 10000,
      stripePaymentIntentId: "pi_program_123",
      orderNumber: "ORD-PROGRAM-1",
      isClassRep: false,
      billingInfo: { email: "user@test.com", fullName: "Test User" },
      save: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(Program.findById).mockResolvedValue(program as any);
    mockPurchaseFindOneResult(purchase);

    const req = {
      params: { id: programId.toString() },
      user: {
        _id: userId,
        id: userId.toString(),
        role: "Participant",
        email: "user@test.com",
        firstName: "Test",
        lastName: "User",
        username: "testuser",
      },
      ip: "127.0.0.1",
      get: vi.fn().mockReturnValue("vitest"),
    };

    await SelfUnenrollController.unenroll(req as any, mockRes as Response);

    expect(statusMock).toHaveBeenCalledWith(200);
    const response = jsonMock.mock.calls[0][0];
    expect(response.data.refundStatus).toBe("processing");
    expect(purchase.unenrolledAt).toBeInstanceOf(Date);
    expect(purchase.unenrollReason).toBe("self_unenroll_refund");
    expect(socketService.disconnectUser).toHaveBeenCalledWith(
      userId.toString(),
    );
    expect(purchase.save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[0],
    );
    expect(processRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_program_123",
        amount: 10000,
      }),
    );
    expect(
      RefundRequestService.notifyAdminsOfAutomaticRefund,
    ).toHaveBeenCalledWith({
      purchase,
      requester: req.user,
      source: "program_unenroll",
      refundId: "re_unenroll_123",
    });
  });
});
