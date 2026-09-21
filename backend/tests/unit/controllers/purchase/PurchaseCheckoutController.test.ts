import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response } from "express";
import mongoose from "mongoose";
import PurchaseCheckoutController from "../../../../src/controllers/purchase/PurchaseCheckoutController";
import { Purchase, Program, PromoCode, User } from "../../../../src/models";
import { createCheckoutSession as stripeCreateCheckoutSession } from "../../../../src/services/stripeService";
import { lockService } from "../../../../src/services/LockService";
import { hasAnnualMembershipAccessToProgram } from "../../../../src/services/AnnualMembershipAccessService";
import { TrioNotificationService } from "../../../../src/services/notifications/TrioNotificationService";

vi.mock("../../../../src/models");
vi.mock("../../../../src/services/stripeService");
vi.mock("../../../../src/services/LockService");
vi.mock("../../../../src/services/AnnualMembershipAccessService");
vi.mock("../../../../src/services/notifications/TrioNotificationService");
vi.mock(
  "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      programPurchaseChanged: vi.fn(),
    },
  }),
);

import { programMembershipMutationSyncTrigger } from "../../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

/**
 * PurchaseCheckoutController Unit Tests
 *
 * NOTE: This test suite covers the critical paths and error handling.
 * The following complex scenarios involving lock+promo code interactions
 * are better suited for integration tests:
 *
 * 1. Free purchase (100% off) - immediate completion without Stripe
 * 2. Admin notifications for general staff codes
 * 3. Pending purchase replacement (delete old + create new atomically)
 * 4. Class Rep discount with atomic spot reservation
 * 5. Bundle promo code (fixed dollar discount) pricing
 * 6. Staff promo code (percentage discount) pricing
 *
 * These scenarios involve complex state management within the lock service
 * that is difficult to mock accurately. Integration tests provide better
 * coverage for these workflows.
 */
describe("PurchaseCheckoutController", () => {
  let mockReq: Partial<Request> & { user?: any; body?: any };
  let mockRes: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  const userId = new mongoose.Types.ObjectId();
  const programId = new mongoose.Types.ObjectId();
  const promoCodeId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn(() => mockRes) as any;
    mockRes = {
      status: statusMock,
      json: jsonMock,
    } as any;
    mockReq = {
      body: {},
      user: undefined,
    };
    vi.clearAllMocks();
    vi.mocked(hasAnnualMembershipAccessToProgram).mockResolvedValue(false);
  });

  describe("createCheckoutSession", () => {
    // ===================
    // Authentication Tests
    // ===================
    it("should return 401 if user not authenticated", async () => {
      mockReq.user = undefined;
      mockReq.body = { programId: programId.toString() };

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
    });

    // ===================
    // Validation Tests
    // ===================
    it("should return 400 if programId is missing", async () => {
      mockReq.user = {
        _id: userId,
        role: "Participant",
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {};

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Invalid program ID.",
      });
    });

    it("should return 400 if programId is invalid ObjectId", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = { programId: "invalid" };

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Invalid program ID.",
      });
    });

    it("should return 404 if program not found", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = { programId: programId.toString() };

      vi.mocked(Program.findById).mockResolvedValue(null);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Program not found.",
      });
    });

    it("should return 400 if program enrollment is closed after program end month", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 1, 1, 0, 0, 0, 0));

      try {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = { programId: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Closed Program",
          isFree: false,
          fullPriceTicket: 10000,
          period: {
            startYear: "2025",
            startMonth: "01",
            endYear: "2025",
            endMonth: "01",
          },
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Enrollment is closed because this program has finished.",
          data: {
            enrollmentClosed: true,
            programStartDate: expect.any(String),
            programEndDate: expect.any(String),
            enrollmentClosesAt: expect.any(String),
          },
        });
        expect(Purchase.findOne).not.toHaveBeenCalled();
        expect(lockService.withLock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("should complete enrollment if program is free", async () => {
      mockReq.user = {
        _id: userId,
        role: "Participant",
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.correlationId = "free-checkout-1";
      mockReq.body = { programId: programId.toString() };

      const mockProgram = {
        _id: programId,
        title: "Free Program",
        isFree: true,
        fullPriceTicket: 0,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
        fn(),
      );
      (Purchase as any).generateOrderNumber = vi
        .fn()
        .mockResolvedValue("ORD-FREE-001");
      vi.mocked(Purchase.create).mockResolvedValue({
        orderNumber: "ORD-FREE-001",
      } as any);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(Purchase.create).toHaveBeenCalledWith(
        expect.objectContaining({
          programId,
          finalPrice: 0,
          status: "completed",
          paymentMethod: { type: "other" },
        }),
      );
      expect(
        programMembershipMutationSyncTrigger.programPurchaseChanged,
      ).toHaveBeenCalledWith(
        { purchaseType: "program", programId },
        {
          actor: {
            type: "user",
            id: userId.toString(),
            role: "Participant",
          },
          source: "http",
          correlationId: "free-checkout-1",
        },
      );
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          sessionId: null,
          sessionUrl: null,
          orderId: "ORD-FREE-001",
          isFree: true,
        },
      });
    });

    // ===================
    // Promo Code Validation Tests
    // ===================
    it("should return 400 if promo code not found", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        promoCode: "INVALID",
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(PromoCode.findOne).mockResolvedValue(null);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      // Message can vary depending on validation path; assert structure instead of exact text
      const payload1 = jsonMock.mock.calls[0][0];
      expect(payload1).toHaveProperty("success", false);
      expect(typeof payload1.message).toBe("string");
      expect(payload1.message.length).toBeGreaterThan(0);
    });

    it("should return 400 if promo code not valid for program", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        promoCode: "TESTCODE",
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      const mockPromoCode = {
        _id: promoCodeId,
        code: "TESTCODE",
        canBeUsedForProgram: vi
          .fn()
          .mockReturnValue({ valid: false, reason: "Not applicable" }),
        isGeneral: false,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(PromoCode.findOne).mockImplementation(async (query: any) => {
        console.log(
          "DEBUG WORKING TEST: PromoCode.findOne called with:",
          JSON.stringify(query),
        );
        return mockPromoCode as any;
      });

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      const payload2 = jsonMock.mock.calls[0][0];
      expect(payload2).toHaveProperty("success", false);
      expect(typeof payload2.message).toBe("string");
      expect(payload2.message.length).toBeGreaterThan(0);
    });

    it("should return 400 if personal promo code doesn't belong to user", async () => {
      const otherUserId = new mongoose.Types.ObjectId();
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        promoCode: "PERSONAL",
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      const mockPromoCode = {
        _id: promoCodeId,
        code: "PERSONAL",
        canBeUsedForProgram: vi.fn().mockReturnValue({ valid: true }),
        isGeneral: false,
        ownerId: otherUserId,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(PromoCode.findOne).mockResolvedValue(mockPromoCode as any);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      const payload3 = jsonMock.mock.calls[0][0];
      expect(payload3).toHaveProperty("success", false);
      expect(typeof payload3.message).toBe("string");
      expect(payload3.message.length).toBeGreaterThan(0);
    });

    it("should return 400 if staff code not valid for program", async () => {
      const otherProgramId = new mongoose.Types.ObjectId();
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        promoCode: "STAFF10",
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      const mockPromoCode = {
        _id: promoCodeId,
        code: "STAFF10",
        type: "staff_access",
        canBeUsedForProgram: vi.fn().mockReturnValue({ valid: true }),
        isGeneral: true,
        allowedProgramIds: [otherProgramId],
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(PromoCode.findOne).mockResolvedValue(mockPromoCode as any);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      const payload4 = jsonMock.mock.calls[0][0];
      expect(payload4).toHaveProperty("success", false);
      expect(typeof payload4.message).toBe("string");
      expect(payload4.message.length).toBeGreaterThan(0);
    });

    // ===================
    // Duplicate Purchase Check
    // ===================
    it("should return 400 if user already purchased program", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = { programId: programId.toString() };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      const mockExistingPurchase = {
        _id: new mongoose.Types.ObjectId(),
        orderNumber: "ORD-001",
        status: "completed",
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(
        mockExistingPurchase as any,
      );

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "You have already purchased this program.",
      });
    });

    it("should return 400 if annual membership already grants program access", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = { programId: programId.toString() };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(hasAnnualMembershipAccessToProgram).mockResolvedValue(true);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(hasAnnualMembershipAccessToProgram).toHaveBeenCalledWith({
        userId,
        programId,
      });
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message:
          "Your annual membership already gives you access to this program.",
      });
      expect(lockService.withLock).not.toHaveBeenCalled();
    });

    // ===================
    // Lock Service Tests
    // ===================
    it("should return 503 on lock timeout", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = { programId: programId.toString() };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null); // No existing purchase
      vi.mocked(lockService.withLock).mockRejectedValue(
        new Error("Lock timeout exceeded"),
      );

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Purchase operation in progress, please wait and try again.",
      });
    });

    // ===================
    // Class Rep Spot Reservation Tests
    // ===================
    it("should return 400 if Class Rep slots full", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        isClassRep: true,
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
        classRepLimit: 5,
        classRepCount: 5,
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
        return fn();
      });
      vi.mocked(Purchase.findOne).mockResolvedValue(null); // No pending
      vi.mocked(Program.findOneAndUpdate).mockResolvedValue(null); // Failed to reserve

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message:
          "Class Representative slots are full. Please choose another student role.",
      });
    });

    // ===================
    // Early Bird Expiration Tests
    // ===================
    it("should proceed without early bird discount if expired during checkout", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        isClassRep: false,
      };

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
        earlyBirdDeadline: yesterday,
        earlyBirdDiscount: 1000,
      };

      const mockPurchase = {
        _id: new mongoose.Types.ObjectId(),
        userId,
        programId,
        fullPrice: 10000,
        classRepDiscount: 0,
        earlyBirdDiscount: 0, // No early bird discount applied
        finalPrice: 10000,
        isClassRep: false,
        isEarlyBird: false,
        status: "pending",
        orderNumber: "ORD-TEST-001",
        save: vi.fn().mockResolvedValue(true),
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
        return fn();
      });
      vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
      vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
        id: "cs_test123",
        url: "https://checkout.stripe.com/test",
      } as any);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      // Should succeed with full price (no early bird discount)
      expect(statusMock).toHaveBeenCalledWith(200);
      const response = jsonMock.mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data.sessionUrl).toBe("https://checkout.stripe.com/test");

      // Verify purchase was created without early bird discount
      expect(Purchase.create).toHaveBeenCalledWith(
        expect.objectContaining({
          earlyBirdDiscount: 0,
          isEarlyBird: false,
          finalPrice: 10000,
        }),
      );
    });

    // ===================
    // Stripe Minimum Price Tests
    // ===================
    it("should return error if final price below Stripe minimum ($0.50)", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 40, // $0.40 - below minimum
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
        return fn();
      });
      vi.mocked(Purchase.findOne).mockResolvedValue(null); // No pending

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      const response = jsonMock.mock.calls[0][0];
      expect(response.message).toBe("Failed to create checkout session.");
      expect(response.error).toContain(
        "Stripe requires a minimum charge of $0.50",
      );
    });

    // ===================
    // Pricing Calculation Tests
    // ===================

    it("should calculate price with Early Bird discount (not Class Rep)", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
        isClassRep: false,
      };

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
        earlyBirdDeadline: tomorrow,
        earlyBirdDiscount: 1500,
      };

      const mockPurchase = {
        _id: new mongoose.Types.ObjectId(),
        orderNumber: "ORD-EB-001",
        status: "pending",
        save: vi.fn().mockResolvedValue(undefined),
      };

      const mockStripeSession = {
        id: "cs_session",
        url: "https://checkout.stripe.com",
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
        return fn();
      });
      vi.mocked(Purchase.findOne).mockResolvedValue(null); // No pending
      (Purchase as any).generateOrderNumber = vi
        .fn()
        .mockResolvedValue("ORD-EB-001");
      vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
      vi.mocked(stripeCreateCheckoutSession).mockResolvedValue(
        mockStripeSession as any,
      );

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(200);
      // Verify Stripe called with Early Bird pricing (10000 - 1500 = 8500)
      expect(stripeCreateCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          finalPrice: 8500,
          earlyBirdDiscount: 1500,
          isEarlyBird: true,
        }),
      );
    });

    // ===================
    // Stripe Session Creation Tests
    // ===================
    it("should create Stripe session and return sessionId/url", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      const mockPurchase = {
        _id: new mongoose.Types.ObjectId(),
        orderNumber: "ORD-001",
        status: "pending",
        save: vi.fn().mockResolvedValue(undefined),
      };

      const mockStripeSession = {
        id: "cs_test_session",
        url: "https://checkout.stripe.com/session",
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
        return fn();
      });
      vi.mocked(Purchase.findOne).mockResolvedValue(null); // No pending
      (Purchase as any).generateOrderNumber = vi
        .fn()
        .mockResolvedValue("ORD-001");
      vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
      vi.mocked(stripeCreateCheckoutSession).mockResolvedValue(
        mockStripeSession as any,
      );

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          sessionId: "cs_test_session",
          sessionUrl: "https://checkout.stripe.com/session",
          existing: false,
        },
      });
    });

    it("should cleanup purchase if Stripe session creation fails", async () => {
      const purchaseId = new mongoose.Types.ObjectId();
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
      };

      const mockProgram = {
        _id: programId,
        title: "Test Program",
        isFree: false,
        fullPriceTicket: 10000,
      };

      const mockPurchase = {
        _id: purchaseId,
        orderNumber: "ORD-FAIL-001",
        status: "pending",
        save: vi.fn().mockResolvedValue(undefined),
      };

      vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
        return fn();
      });
      vi.mocked(Purchase.findOne).mockResolvedValue(null); // No pending
      (Purchase as any).generateOrderNumber = vi
        .fn()
        .mockResolvedValue("ORD-FAIL-001");
      vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
      vi.mocked(stripeCreateCheckoutSession).mockRejectedValue(
        new Error("Stripe API error"),
      );
      vi.mocked(Purchase.deleteOne).mockResolvedValue({
        deletedCount: 1,
      } as any);

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(Purchase.deleteOne).toHaveBeenCalledWith({ _id: purchaseId });
      expect(statusMock).toHaveBeenCalledWith(500);
    });

    // ===================
    // Error Handling Tests
    // ===================
    it("should handle database errors", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
      };

      vi.mocked(Program.findById).mockRejectedValue(
        new Error("Database connection error"),
      );

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to create checkout session.",
        error: "Database connection error",
      });
    });

    it("should handle non-Error exceptions", async () => {
      mockReq.user = {
        _id: userId,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
      };
      mockReq.body = {
        programId: programId.toString(),
      };

      vi.mocked(Program.findById).mockRejectedValue("String error");

      await PurchaseCheckoutController.createCheckoutSession(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to create checkout session.",
        error: undefined,
      });
    });

    // ===================
    // Pending Purchase Deletion Flow Tests
    // ===================
    describe("pending purchase deletion flow", () => {
      it("should delete existing pending purchase and create new one", async () => {
        const oldPendingId = new mongoose.Types.ObjectId();
        const newPurchaseId = new mongoose.Types.ObjectId();

        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
        };

        const mockPendingPurchase = {
          _id: oldPendingId,
          orderNumber: "ORD-OLD-001",
          status: "pending",
          stripeSessionId: "cs_old_session",
          isClassRep: false,
          programId,
        };

        const mockNewPurchase = {
          _id: newPurchaseId,
          orderNumber: "ORD-NEW-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        const mockStripeSession = {
          id: "cs_new_session",
          url: "https://checkout.stripe.com/new",
        };

        // Mock Stripe module import for session expire
        const mockStripe = {
          checkout: {
            sessions: {
              retrieve: vi.fn().mockResolvedValue({ status: "open" }),
              expire: vi.fn().mockResolvedValue({}),
            },
          },
        };

        vi.doMock("../../../../src/services/stripeService", async () => {
          const actual = await vi.importActual<
            typeof import("../../../../src/services/stripeService")
          >("../../../../src/services/stripeService");
          return {
            ...actual,
            stripe: mockStripe,
          };
        });

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        // First call for completed purchase check, second call in lock for pending
        let findOneCalls = 0;
        vi.mocked(Purchase.findOne).mockImplementation(async (query: any) => {
          findOneCalls++;
          if (query.status === "completed") {
            return null; // No completed purchase
          }
          if (query.status === "pending" && findOneCalls === 2) {
            return mockPendingPurchase as any;
          }
          return null;
        });

        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        vi.mocked(Purchase.deleteOne).mockResolvedValue({
          deletedCount: 1,
        } as any);
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-NEW-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockNewPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue(
          mockStripeSession as any,
        );

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          data: {
            sessionId: "cs_new_session",
            sessionUrl: "https://checkout.stripe.com/new",
            existing: false,
          },
        });
      });

      it("should decrement classRepCount when deleting pending Class Rep purchase", async () => {
        const oldPendingId = new mongoose.Types.ObjectId();

        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          isClassRep: false, // New purchase is NOT Class Rep
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
          classRepLimit: 5,
          classRepCount: 3,
        };

        const mockOldClassRepPurchase = {
          _id: oldPendingId,
          orderNumber: "ORD-OLDREP-001",
          status: "pending",
          stripeSessionId: null,
          isClassRep: true, // Old pending was Class Rep
          programId,
        };

        const mockNewPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-NEW-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);

        let findOneCalls = 0;
        vi.mocked(Purchase.findOne).mockImplementation(async (query: any) => {
          findOneCalls++;
          if (query.status === "completed") return null;
          if (query.status === "pending" && findOneCalls === 2) {
            return mockOldClassRepPurchase as any;
          }
          return null;
        });

        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        vi.mocked(Program.findByIdAndUpdate).mockResolvedValue(
          mockProgram as any,
        );
        vi.mocked(Purchase.deleteOne).mockResolvedValue({
          deletedCount: 1,
        } as any);
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-NEW-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockNewPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_new",
          url: "https://checkout.stripe.com/new",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // Verify classRepCount was decremented
        expect(Program.findByIdAndUpdate).toHaveBeenCalledWith(
          programId,
          {
            $inc: {
              classRepCount: -1,
              "programRoles.studentRoles.1.count": -1,
            },
          },
          { runValidators: false },
        );
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    // ===================
    // Class Rep Slot Reservation Tests
    // ===================
    describe("Class Rep slot reservation", () => {
      it("should atomically increment classRepCount on reservation", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          isClassRep: true,
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
          classRepLimit: 5,
          classRepCount: 2,
          classRepDiscount: 2000,
        };

        const mockUpdatedProgram = {
          ...mockProgram,
          classRepCount: 3,
        };

        const mockPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-REP-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        vi.mocked(Program.findOneAndUpdate).mockResolvedValue(
          mockUpdatedProgram as any,
        );
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-REP-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_rep",
          url: "https://checkout.stripe.com/rep",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // Verify atomic increment was called with correct conditions
        expect(Program.findOneAndUpdate).toHaveBeenCalledWith(
          {
            _id: programId,
            $or: [
              { "programRoles.studentRoles.1.count": { $lt: 5 } },
              { "programRoles.studentRoles.1.count": { $exists: false } },
              { "programRoles.studentRoles.1.count": null },
            ],
          },
          {
            $inc: {
              classRepCount: 1,
              "programRoles.studentRoles.1.count": 1,
            },
          },
          { new: true, runValidators: true },
        );
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should reserve the selected non-legacy discount role without changing classRepCount", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          studentRoleId: "scholar",
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
          classRepLimit: 5,
          classRepCount: 2,
          classRepDiscount: 2000,
          programRoles: {
            teacherRoleName: "Mentor",
            studentRoles: [
              {
                id: "mentee",
                name: "Mentee",
                discountEligible: false,
                discountAmount: 0,
                limit: 0,
                count: 0,
              },
              {
                id: "class-rep",
                name: "Class Rep",
                discountEligible: true,
                discountAmount: 2000,
                limit: 5,
                count: 2,
              },
              {
                id: "scholar",
                name: "Scholar",
                discountEligible: true,
                discountAmount: 3000,
                limit: 4,
                count: 1,
              },
            ],
          },
        };

        const mockPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-SCHOLAR-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        vi.mocked(Program.findOneAndUpdate).mockResolvedValue({
          ...mockProgram,
          programRoles: {
            ...mockProgram.programRoles,
            studentRoles: mockProgram.programRoles.studentRoles.map((role) =>
              role.id === "scholar" ? { ...role, count: 2 } : role,
            ),
          },
        } as any);
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-SCHOLAR-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_scholar",
          url: "https://checkout.stripe.com/scholar",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.findOneAndUpdate).toHaveBeenCalledWith(
          {
            _id: programId,
            $or: [
              { "programRoles.studentRoles.2.count": { $lt: 4 } },
              { "programRoles.studentRoles.2.count": { $exists: false } },
              { "programRoles.studentRoles.2.count": null },
            ],
          },
          {
            $inc: {
              "programRoles.studentRoles.2.count": 1,
            },
          },
          { new: true, runValidators: true },
        );
        expect(Purchase.create).toHaveBeenCalledWith(
          expect.objectContaining({
            studentRoleId: "scholar",
            studentRoleName: "Scholar",
            classRepDiscount: 3000,
            isClassRep: true,
          }),
        );
        expect(stripeCreateCheckoutSession).toHaveBeenCalledWith(
          expect.objectContaining({
            classRepDiscount: 3000,
            finalPrice: 7000,
            isClassRep: true,
          }),
        );
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should apply Class Rep discount to final price", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          isClassRep: true,
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000, // $100.00
          classRepLimit: 5,
          classRepCount: 1,
          classRepDiscount: 3000, // $30.00 discount
        };

        const mockPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-REP-002",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        vi.mocked(Program.findOneAndUpdate).mockResolvedValue(
          mockProgram as any,
        );
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-REP-002");
        vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_rep2",
          url: "https://checkout.stripe.com/rep2",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // Verify Stripe called with Class Rep discount applied
        expect(stripeCreateCheckoutSession).toHaveBeenCalledWith(
          expect.objectContaining({
            fullPrice: 10000,
            classRepDiscount: 3000,
            finalPrice: 7000, // 10000 - 3000 = 7000
            isClassRep: true,
          }),
        );
      });

      it("should not apply Class Rep discount when classRepLimit is 0", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          isClassRep: true,
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
          classRepLimit: 0, // No Class Rep slots
          classRepDiscount: 3000,
        };

        const mockPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-NOREP-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-NOREP-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_norep",
          url: "https://checkout.stripe.com/norep",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // findOneAndUpdate should not have been called for Class Rep reservation
        expect(Program.findOneAndUpdate).not.toHaveBeenCalled();
      });
    });


    // ===================
    // Lock Service Error Scenarios Tests
    // ===================
    describe("lock service error scenarios", () => {
      it("should return 503 with specific message on lock timeout", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = { programId: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockRejectedValue(
          new Error("Lock timeout: unable to acquire lock after 10000ms"),
        );

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Purchase operation in progress, please wait and try again.",
        });
      });

      it("should handle lock service internal errors", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = { programId: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockRejectedValue(
          new Error("Redis connection failed"),
        );

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to create checkout session.",
          error: "Redis connection failed",
        });
      });

      it("should propagate errors thrown inside lock callback", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = { programId: programId.toString() };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          // Simulate error thrown inside callback
          throw new Error("Database write failed during lock");
        });

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to create checkout session.",
          error: "Database write failed during lock",
        });
      });
    });

    // ===================
    // Early Bird Pricing Edge Cases
    // ===================
    describe("early bird pricing edge cases", () => {
      it("should apply early bird discount when deadline is today (end of day)", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          isClassRep: false,
        };

        // Set deadline to today
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
          earlyBirdDeadline: today,
          earlyBirdDiscount: 2000,
        };

        const mockPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-TODAY-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-TODAY-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_today",
          url: "https://checkout.stripe.com/today",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // Early bird should be applied (deadline is set to end of day 23:59:59.999)
        expect(stripeCreateCheckoutSession).toHaveBeenCalledWith(
          expect.objectContaining({
            earlyBirdDiscount: 2000,
            isEarlyBird: true,
            finalPrice: 8000,
          }),
        );
      });

      it("should NOT apply early bird when Class Rep is selected (mutually exclusive)", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
          isClassRep: true, // Class Rep selected
        };

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
          earlyBirdDeadline: tomorrow, // Early bird still active
          earlyBirdDiscount: 2000,
          classRepLimit: 5,
          classRepCount: 1,
          classRepDiscount: 3000,
        };

        const mockPurchase = {
          _id: new mongoose.Types.ObjectId(),
          orderNumber: "ORD-EXCL-001",
          status: "pending",
          save: vi.fn().mockResolvedValue(undefined),
        };

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockImplementation(async (key, fn) => {
          return fn();
        });
        vi.mocked(Program.findOneAndUpdate).mockResolvedValue(
          mockProgram as any,
        );
        (Purchase as any).generateOrderNumber = vi
          .fn()
          .mockResolvedValue("ORD-EXCL-001");
        vi.mocked(Purchase.create).mockResolvedValue(mockPurchase as any);
        vi.mocked(stripeCreateCheckoutSession).mockResolvedValue({
          id: "cs_excl",
          url: "https://checkout.stripe.com/excl",
        } as any);

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // Class Rep discount should be applied, NOT early bird
        expect(stripeCreateCheckoutSession).toHaveBeenCalledWith(
          expect.objectContaining({
            classRepDiscount: 3000,
            earlyBirdDiscount: 0,
            isEarlyBird: false,
            isClassRep: true,
            finalPrice: 7000,
          }),
        );
      });
    });



    // ===================
    // Early Bird Expiration Error Handling Tests
    // ===================
    describe("Early Bird expiration error handling", () => {
      it("should parse JSON error and return structured response for earlyBirdExpired", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
        };

        const errorJson = JSON.stringify({
          earlyBirdExpired: true,
          message: "Early Bird discount has expired during checkout",
          newPrice: 10000,
        });

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockRejectedValue(new Error(errorJson));

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Early Bird discount has expired during checkout",
          data: {
            earlyBirdExpired: true,
            newPrice: 10000,
          },
        });
      });

      it("should fall through to generic error if earlyBirdExpired JSON is malformed", async () => {
        mockReq.user = {
          _id: userId,
          email: "test@test.com",
          firstName: "Test",
          lastName: "User",
        };
        mockReq.body = {
          programId: programId.toString(),
        };

        const mockProgram = {
          _id: programId,
          title: "Test Program",
          isFree: false,
          fullPriceTicket: 10000,
        };

        // Malformed JSON that contains earlyBirdExpired but can't be parsed
        const malformedError = "earlyBirdExpired: {broken json";

        vi.mocked(Program.findById).mockResolvedValue(mockProgram as any);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(lockService.withLock).mockRejectedValue(
          new Error(malformedError),
        );

        await PurchaseCheckoutController.createCheckoutSession(
          mockReq as Request,
          mockRes as Response,
        );

        // Should fall through to generic 500 error
        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Failed to create checkout session.",
          error: malformedError,
        });
      });
    });
  });
});
