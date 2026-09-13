import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response } from "express";
import PurchaseRetryController from "../../../../src/controllers/purchase/PurchaseRetryController";
import Purchase from "../../../../src/models/Purchase";
import * as stripeService from "../../../../src/services/stripeService";
import mongoose from "mongoose";

// Mock dependencies
vi.mock("../../../../src/models/Purchase");
vi.mock("../../../../src/services/stripeService");
vi.mock("../../../../src/models/Event", () => ({
  default: {
    findById: vi.fn(),
  },
}));

/**
 * Helper to create mock chain for Purchase.findById().populate().populate().populate()
 */
function mockPurchaseFindByIdChain(purchase: any) {
  return {
    populate: vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockResolvedValue(purchase),
      }),
    }),
  } as any;
}

function mockPurchaseFindByIdChainError(error: unknown) {
  return {
    populate: vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockRejectedValue(error),
      }),
    }),
  } as any;
}

describe("PurchaseRetryController", () => {
  let mockReq: Partial<Request> & { user?: any; params?: any };
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup response mocks
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      params: {},
      user: undefined,
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    // Mock console methods
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(Purchase.updateOne).mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    } as any);
  });

  describe("retryPendingPurchase", () => {
    const userId = new mongoose.Types.ObjectId();
    const purchaseId = new mongoose.Types.ObjectId();
    const programId = new mongoose.Types.ObjectId();

    it("should return 401 if user not authenticated", async () => {
      mockReq.user = undefined;
      mockReq.params = { id: purchaseId.toString() };

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Authentication required.",
      });
    });

    it("should return 400 for invalid purchase ID", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: "invalid-id" };

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Invalid purchase ID.",
      });
    });

    it("should return 404 if purchase not found", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(null),
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(Purchase.findById).toHaveBeenCalledWith(purchaseId.toString());
      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Purchase not found.",
      });
    });

    it("should return 403 if user is not purchase owner", async () => {
      const otherUserId = new mongoose.Types.ObjectId();

      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPurchase = {
        _id: purchaseId,
        userId: otherUserId,
        status: "pending",
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPurchase),
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "You can only retry your own purchases.",
      });
    });

    it("should return 400 if purchase is already completed", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPurchase = {
        _id: purchaseId,
        userId,
        status: "completed",
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPurchase),
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Cannot retry a completed purchase.",
      });
    });

    it("should return 400 if purchase is failed", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPurchase = {
        _id: purchaseId,
        userId,
        status: "failed",
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPurchase),
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Cannot retry a failed purchase.",
      });
    });

    it("should return 400 if user already has completed purchase for program", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        programId,
        purchaseType: "program",
        eventId: null,
        status: "pending",
      };

      const mockCompletedPurchase = {
        _id: new mongoose.Types.ObjectId(),
        userId,
        programId,
        purchaseType: "program",
        status: "completed",
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(
        mockCompletedPurchase as any,
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(Purchase.findOne).toHaveBeenCalledWith({
        userId: userId,
        programId: programId,
        purchaseType: "program",
        status: "completed",
        unenrolledAt: { $exists: false },
      });
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message:
          "You have already purchased this program. Check your purchase history.",
      });
    });

    it("should successfully retry pending purchase", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        programId: {
          _id: programId,
          title: "Test Program",
        },
        purchaseType: "program",
        eventId: null,
        status: "pending",
        orderNumber: "ORDER-001",
        fullPrice: 100,
        classRepDiscount: 10,
        earlyBirdDiscount: 5,
        finalPrice: 85,
        studentRoleId: undefined as string | undefined,
        studentRoleName: undefined as string | undefined,
        isClassRep: true,
        isEarlyBird: true,
        stripeSessionId: "old_session_id",
        save: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const mockSession = {
        id: "cs_new_session_123",
        url: "https://checkout.stripe.com/new_session",
      };

      vi.mocked(stripeService.createCheckoutSession).mockResolvedValue(
        mockSession as any,
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith({
        userId: userId.toString(),
        userEmail: "user@example.com",
        programId: programId.toString(),
        programTitle: "Test Program",
        fullPrice: 100,
        classRepDiscount: 10,
        earlyBirdDiscount: 5,
        finalPrice: 85,
        isClassRep: true,
        isEarlyBird: true,
        purchaseId: purchaseId.toString(),
      });

      expect(mockPendingPurchase.stripeSessionId).toBe("cs_new_session_123");
      expect(mockPendingPurchase.studentRoleId).toBe("classRep");
      expect(mockPendingPurchase.studentRoleName).toBe(
        "Class Representative",
      );
      expect(Purchase.updateOne).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(Purchase.updateOne).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(stripeService.createCheckoutSession).mock
          .invocationCallOrder[0]!,
      );
      expect(Purchase.updateOne).toHaveBeenNthCalledWith(
        1,
        {
          _id: purchaseId,
          userId,
          status: "pending",
          __v: 0,
        },
        {
          $unset: {
            stripeSessionId: 1,
            stripePaymentIntentId: 1,
          },
          $inc: { __v: 1 },
          $set: {
            studentRoleId: "classRep",
            studentRoleName: "Class Representative",
          },
        },
        { runValidators: true },
      );
      expect(Purchase.updateOne).toHaveBeenNthCalledWith(
        2,
        {
          _id: purchaseId,
          userId,
          status: "pending",
          __v: 1,
        },
        {
          $set: { stripeSessionId: "cs_new_session_123" },
          $inc: { __v: 1 },
        },
        { runValidators: true },
      );

      expect(console.log).toHaveBeenCalledWith(
        "Created new checkout session for pending purchase ORDER-001",
      );

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          sessionId: "cs_new_session_123",
          sessionUrl: "https://checkout.stripe.com/new_session",
        },
      });
    });

    it("returns 409 before Stripe when another retry already reserved the observed version", async () => {
      mockReq.user = { _id: userId, email: "user@example.com" };
      mockReq.params = { id: purchaseId.toString() };
      const mockPendingPurchase = {
        _id: purchaseId,
        __v: 4,
        userId,
        programId: { _id: programId, title: "Test Program" },
        purchaseType: "program",
        status: "pending",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
      };
      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
      } as any);

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(Purchase.updateOne).toHaveBeenCalledWith(
        {
          _id: purchaseId,
          userId,
          status: "pending",
          __v: 4,
        },
        expect.objectContaining({
          $unset: {
            stripeSessionId: 1,
            stripePaymentIntentId: 1,
          },
          $inc: { __v: 1 },
        }),
        { runValidators: true },
      );
      expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(409);
    });

    it("allows only one of two concurrent retries to create a Stripe session", async () => {
      const makePendingPurchase = () => ({
        _id: purchaseId,
        __v: 0,
        userId,
        programId: { _id: programId, title: "Test Program" },
        purchaseType: "program",
        status: "pending",
        orderNumber: "ORDER-CONCURRENT",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
      });
      vi.mocked(Purchase.findById)
        .mockReturnValueOnce(mockPurchaseFindByIdChain(makePendingPurchase()))
        .mockReturnValueOnce(mockPurchaseFindByIdChain(makePendingPurchase()));
      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      let reservationCalls = 0;
      vi.mocked(Purchase.updateOne).mockImplementation(
        async (_filter, update: any) => {
          if (update.$unset) {
            reservationCalls += 1;
            return {
              acknowledged: true,
              matchedCount: reservationCalls === 1 ? 1 : 0,
              modifiedCount: reservationCalls === 1 ? 1 : 0,
            } as any;
          }
          return {
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: 1,
          } as any;
        },
      );

      let signalCreationStarted!: () => void;
      const creationStarted = new Promise<void>((resolve) => {
        signalCreationStarted = resolve;
      });
      let releaseSession!: (value: any) => void;
      const pendingSession = new Promise<any>((resolve) => {
        releaseSession = resolve;
      });
      vi.mocked(stripeService.createCheckoutSession).mockImplementationOnce(
        async () => {
          signalCreationStarted();
          return pendingSession;
        },
      );

      const makeResponse = () => {
        const json = vi.fn();
        const status = vi.fn().mockReturnValue({ json });
        return { response: { status, json } as any, status };
      };
      const firstResponse = makeResponse();
      const secondResponse = makeResponse();
      const request = {
        params: { id: purchaseId.toString() },
        user: { _id: userId, email: "user@example.com" },
      } as unknown as Request;

      const first = PurchaseRetryController.retryPendingPurchase(
        request,
        firstResponse.response,
      );
      await creationStarted;
      await PurchaseRetryController.retryPendingPurchase(
        request,
        secondResponse.response,
      );
      releaseSession({
        id: "cs_concurrent_winner",
        url: "https://checkout.stripe.com/concurrent",
      });
      await first;

      expect(stripeService.createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(firstResponse.status).toHaveBeenCalledWith(200);
      expect(secondResponse.status).toHaveBeenCalledWith(409);
    });

    it("accepts a bind CAS miss when this exact session completed by webhook in the create-bind window", async () => {
      mockReq.user = { _id: userId, email: "user@example.com" };
      mockReq.params = { id: purchaseId.toString() };
      const mockPendingPurchase = {
        _id: purchaseId,
        __v: 0,
        userId,
        programId: { _id: programId, title: "Test Program" },
        purchaseType: "program",
        status: "pending",
        orderNumber: "ORDER-WEBHOOK-WON",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
      };
      vi.mocked(Purchase.findById)
        .mockReturnValueOnce(mockPurchaseFindByIdChain(mockPendingPurchase))
        .mockResolvedValueOnce({
          ...mockPendingPurchase,
          status: "completed",
          stripeSessionId: "cs_webhook_won",
        } as any);
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(Purchase.updateOne)
        .mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
        } as any)
        .mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
        } as any);
      vi.mocked(stripeService.createCheckoutSession).mockResolvedValue({
        id: "cs_webhook_won",
        url: "https://checkout.stripe.com/webhook-won",
      } as any);
      const expire = vi.fn();
      vi.mocked(stripeService).stripe = {
        checkout: { sessions: { expire } },
      } as any;

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(expire).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it.each([
      "completed",
      "failed",
      "refunded",
      "refund_processing",
      "refund_failed",
      null,
    ])(
      "expires the new session when bind loses to %s",
      async (statusAfterCreate) => {
        mockReq.user = { _id: userId, email: "user@example.com" };
        mockReq.params = { id: purchaseId.toString() };
        const mockPendingPurchase = {
          _id: purchaseId,
          __v: 0,
          userId,
          programId: { _id: programId, title: "Test Program" },
          purchaseType: "program",
          status: "pending",
          orderNumber: "ORDER-BIND-LOST",
          fullPrice: 100,
          classRepDiscount: 0,
          earlyBirdDiscount: 0,
          finalPrice: 100,
          isClassRep: false,
          isEarlyBird: false,
        };
        vi.mocked(Purchase.findById)
          .mockReturnValueOnce(mockPurchaseFindByIdChain(mockPendingPurchase))
          .mockResolvedValueOnce(
            statusAfterCreate == null
              ? null
              : ({
                  ...mockPendingPurchase,
                  status: statusAfterCreate,
                } as any),
          );
        vi.mocked(Purchase.findOne).mockResolvedValue(null);
        vi.mocked(Purchase.updateOne)
          .mockResolvedValueOnce({
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: 1,
          } as any)
          .mockResolvedValueOnce({
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
          } as any);
        vi.mocked(stripeService.createCheckoutSession).mockResolvedValue({
          id: "cs_must_expire",
          url: "https://checkout.stripe.com/must-expire",
        } as any);
        const expire = vi.fn().mockResolvedValue({});
        vi.mocked(stripeService).stripe = {
          checkout: { sessions: { expire } },
        } as any;

        await PurchaseRetryController.retryPendingPurchase(
          mockReq as Request,
          mockRes as Response,
        );

        expect(expire).toHaveBeenCalledWith("cs_must_expire");
        expect(statusMock).toHaveBeenCalledWith(409);
      },
    );

    it("can retry again after Stripe creation fails following a successful reservation", async () => {
      const staleSave = vi.fn();
      const firstPendingPurchase = {
        _id: purchaseId,
        __v: 0,
        userId,
        programId: { _id: programId, title: "Test Program" },
        purchaseType: "program",
        status: "pending",
        orderNumber: "ORDER-CREATE-RETRY",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "cs_old_attempt",
        stripePaymentIntentId: "pi_old_attempt",
        save: staleSave,
      };
      const secondPendingPurchase = {
        ...firstPendingPurchase,
        __v: 1,
        stripeSessionId: undefined,
        stripePaymentIntentId: undefined,
      };
      vi.mocked(Purchase.findById)
        .mockReturnValueOnce(mockPurchaseFindByIdChain(firstPendingPurchase))
        .mockReturnValueOnce(mockPurchaseFindByIdChain(secondPendingPurchase));
      vi.mocked(Purchase.findOne).mockResolvedValue(null);
      vi.mocked(stripeService.createCheckoutSession)
        .mockRejectedValueOnce(new Error("temporary Stripe failure"))
        .mockResolvedValueOnce({
          id: "cs_retry_after_failure",
          url: "https://checkout.stripe.com/retry-after-failure",
        } as any);

      const makeResponse = () => {
        const json = vi.fn();
        const status = vi.fn().mockReturnValue({ json });
        return { response: { status, json } as any, status };
      };
      const firstResponse = makeResponse();
      const secondResponse = makeResponse();
      const request = {
        params: { id: purchaseId.toString() },
        user: { _id: userId, email: "user@example.com" },
      } as unknown as Request;

      await PurchaseRetryController.retryPendingPurchase(
        request,
        firstResponse.response,
      );
      await PurchaseRetryController.retryPendingPurchase(
        request,
        secondResponse.response,
      );

      expect(firstResponse.status).toHaveBeenCalledWith(500);
      expect(secondResponse.status).toHaveBeenCalledWith(200);
      expect(stripeService.createCheckoutSession).toHaveBeenCalledTimes(2);
      expect(firstPendingPurchase.status).toBe("pending");
      expect(firstPendingPurchase.stripeSessionId).toBeUndefined();
      expect(firstPendingPurchase.stripePaymentIntentId).toBeUndefined();
      expect(staleSave).not.toHaveBeenCalled();
      expect(Purchase.updateOne).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          _id: purchaseId,
          status: "pending",
          __v: 0,
        }),
        expect.objectContaining({
          $unset: {
            stripeSessionId: 1,
            stripePaymentIntentId: 1,
          },
          $inc: { __v: 1 },
        }),
        { runValidators: true },
      );
      expect(Purchase.updateOne).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ __v: 1 }),
        expect.objectContaining({
          $unset: {
            stripeSessionId: 1,
            stripePaymentIntentId: 1,
          },
        }),
        { runValidators: true },
      );
    });

    it("should handle retry without discounts", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        programId: {
          _id: programId,
          title: "Test Program",
        },
        purchaseType: "program",
        eventId: null,
        status: "pending",
        orderNumber: "ORDER-002",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
        save: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const mockSession = {
        id: "cs_session_no_discount",
        url: "https://checkout.stripe.com/session",
      };

      vi.mocked(stripeService.createCheckoutSession).mockResolvedValue(
        mockSession as any,
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith({
        userId: userId.toString(),
        userEmail: "user@example.com",
        programId: programId.toString(),
        programTitle: "Test Program",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
        purchaseId: purchaseId.toString(),
      });

      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it("fails closed before Stripe when a legacy pending Program role is ambiguous", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };
      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        programId: {
          _id: programId,
          title: "Ambiguous Program",
          programRoles: {
            teacherRoleName: "Mentor",
            studentRoles: [
              {
                id: "participant",
                name: "Participant",
                discountEligible: false,
              },
              {
                id: "observer",
                name: "Observer",
                discountEligible: false,
              },
            ],
          },
        },
        purchaseType: "program",
        status: "pending",
        isClassRep: false,
        save: vi.fn().mockResolvedValue({}),
      };
      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );
      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "This purchase's Program role needs staff review before retry.",
      });
      expect(mockPendingPurchase.save).not.toHaveBeenCalled();
      expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
    });

    it("should handle userId as ObjectId instance", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId: userId, // Direct ObjectId
        programId: {
          _id: programId,
          title: "Test Program",
        },
        purchaseType: "program",
        eventId: null,
        status: "pending",
        orderNumber: "ORDER-003",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
        save: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const mockSession = {
        id: "cs_session",
        url: "https://checkout.stripe.com/session",
      };

      vi.mocked(stripeService.createCheckoutSession).mockResolvedValue(
        mockSession as any,
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(statusMock).toHaveBeenCalledWith(200);
    });

    it("should handle database error on findById", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const dbError = new Error("Database connection failed");

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChainError(dbError),
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(console.error).toHaveBeenCalledWith(
        "Error retrying purchase:",
        dbError,
      );
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to retry purchase.",
        error: "Database connection failed",
      });
    });

    it("should handle Stripe API error", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        programId: {
          _id: programId,
          title: "Test Program",
        },
        purchaseType: "program",
        eventId: null,
        status: "pending",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
        save: vi.fn().mockResolvedValue({}),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const stripeError = new Error("Stripe API error");
      vi.mocked(stripeService.createCheckoutSession).mockRejectedValue(
        stripeError,
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(console.error).toHaveBeenCalledWith(
        "Error retrying purchase:",
        stripeError,
      );
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to retry purchase.",
        error: "Stripe API error",
      });
    });

    it("should expire the session and report a bind CAS error after creating it", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const saveError = new Error("Save failed");

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        programId: {
          _id: programId,
          title: "Test Program",
        },
        purchaseType: "program",
        eventId: null,
        status: "pending",
        fullPrice: 100,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 100,
        isClassRep: false,
        isEarlyBird: false,
        save: vi.fn(),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const mockSession = {
        id: "cs_session",
        url: "https://checkout.stripe.com/session",
      };

      vi.mocked(stripeService.createCheckoutSession).mockResolvedValue(
        mockSession as any,
      );
      const expire = vi.fn().mockResolvedValue({});
      vi.mocked(stripeService).stripe = {
        checkout: { sessions: { expire } },
      } as any;
      vi.mocked(Purchase.updateOne)
        .mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 1,
          modifiedCount: 1,
        } as any)
        .mockRejectedValueOnce(saveError);

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(console.error).toHaveBeenCalledWith(
        "Error retrying purchase:",
        saveError,
      );
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Failed to retry purchase.",
        error: "Save failed",
      });
      expect(expire).toHaveBeenCalledWith("cs_session");
    });

    it("should handle non-Error exceptions", async () => {
      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChainError("Unexpected string error"),
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(console.error).toHaveBeenCalledWith(
        "Error retrying purchase:",
        "Unexpected string error",
      );
      expect(statusMock).toHaveBeenCalledWith(500);
    });

    it("should return 400 if user already has completed purchase for event", async () => {
      const eventId = new mongoose.Types.ObjectId();

      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        eventId,
        purchaseType: "event",
        programId: null,
        status: "pending",
      };

      const mockCompletedPurchase = {
        _id: new mongoose.Types.ObjectId(),
        userId,
        eventId,
        purchaseType: "event",
        status: "completed",
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(
        mockCompletedPurchase as any,
      );

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(Purchase.findOne).toHaveBeenCalledWith({
        userId: userId,
        eventId: eventId,
        purchaseType: "event",
        status: "completed",
        unenrolledAt: { $exists: false },
      });
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message:
          "You have already purchased this event. Check your purchase history.",
      });
    });

    it("should successfully retry pending event purchase", async () => {
      const eventId = new mongoose.Types.ObjectId();

      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        eventId,
        purchaseType: "event",
        programId: null,
        status: "pending",
        orderNumber: "ORDER-EVENT-001",
        fullPrice: 5000,
        classRepDiscount: 0,
        earlyBirdDiscount: 0,
        finalPrice: 5000,
        isClassRep: false,
        isEarlyBird: false,
        stripeSessionId: "old_event_session",
        save: vi.fn().mockResolvedValue({}),
      };

      const mockEvent = {
        _id: eventId,
        title: "Test Event",
        date: new Date("2025-01-15"),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const EventModel = await import("../../../../src/models/Event");
      vi.mocked(EventModel.default.findById).mockResolvedValue(
        mockEvent as any,
      );

      const mockSession = {
        id: "cs_event_session_123",
        url: "https://checkout.stripe.com/event_session",
      };

      const mockStripe = {
        checkout: {
          sessions: {
            create: vi.fn().mockResolvedValue(mockSession),
          },
        },
      };

      vi.mocked(stripeService).stripe = mockStripe as any;

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(EventModel.default.findById).toHaveBeenCalledWith(eventId);
      expect(mockPendingPurchase.stripeSessionId).toBe("cs_event_session_123");
      expect(Purchase.updateOne).toHaveBeenCalledTimes(2);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: {
          sessionId: "cs_event_session_123",
          sessionUrl: "https://checkout.stripe.com/event_session",
        },
      });
    });

    it("should return 404 when event is not found for event retry", async () => {
      const eventId = new mongoose.Types.ObjectId();

      mockReq.user = {
        _id: userId,
        email: "user@example.com",
      };
      mockReq.params = { id: purchaseId.toString() };

      const mockPendingPurchase = {
        _id: purchaseId,
        userId,
        eventId,
        purchaseType: "event",
        programId: null,
        status: "pending",
        orderNumber: "ORDER-EVENT-002",
        fullPrice: 5000,
        finalPrice: 5000,
        save: vi.fn(),
      };

      vi.mocked(Purchase.findById).mockReturnValue(
        mockPurchaseFindByIdChain(mockPendingPurchase),
      );

      vi.mocked(Purchase.findOne).mockResolvedValue(null);

      const EventModel = await import("../../../../src/models/Event");
      vi.mocked(EventModel.default.findById).mockResolvedValue(null);

      await PurchaseRetryController.retryPendingPurchase(
        mockReq as Request,
        mockRes as Response,
      );

      expect(EventModel.default.findById).toHaveBeenCalledWith(eventId);
      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: "Event not found.",
      });
    });
  });
});
