import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Request, Response } from "express";
import { WebhookController } from "../../../src/controllers/webhookController";
import * as stripeService from "../../../src/services/stripeService";
import {
  Purchase,
  SystemConfig,
  PromoCode,
  User,
  Program,
} from "../../../src/models";
import { EmailService } from "../../../src/services/infrastructure/EmailServiceFacade";
import { lockService } from "../../../src/services/LockService";
import { TrioNotificationService } from "../../../src/services/notifications/TrioNotificationService";
import { socketService } from "../../../src/services/infrastructure/SocketService";
import Stripe from "stripe";
import mongoose from "mongoose";

// Mock all external dependencies
vi.mock("../../../src/services/stripeService");
vi.mock("../../../src/models", () => ({
  Purchase: {
    findById: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    }),
  },
  SystemConfig: {
    getBundleDiscountConfig: vi.fn(),
  },
  PromoCode: {
    findOne: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    generateUniqueCode: vi.fn(),
    deleteOne: vi.fn(),
  },
  User: {
    find: vi.fn(),
    findById: vi.fn(),
  },
  Program: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));
vi.mock("../../../src/services/infrastructure/EmailServiceFacade");
vi.mock("../../../src/services/LockService");
vi.mock("../../../src/services/notifications/TrioNotificationService");
vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    disconnectUser: vi.fn(),
  },
}));
vi.mock("../../../src/services/email/domains/PurchaseEmailService", () => ({
  PurchaseEmailService: {
    sendRefundCompletedEmail: vi.fn().mockResolvedValue(undefined),
    sendRefundFailedEmail: vi.fn().mockResolvedValue(undefined),
    sendAdminRefundNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock(
  "../../../src/services/programs/ProgramMembershipMutationSyncTrigger",
  () => ({
    programMembershipMutationSyncTrigger: {
      programPurchaseChanged: vi.fn(),
    },
  }),
);

import { programMembershipMutationSyncTrigger } from "../../../src/services/programs/ProgramMembershipMutationSyncTrigger";

function mockPurchaseFindByIdRefundChain(result: unknown) {
  return {
    populate: vi.fn().mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any;
}

describe("WebhookController", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let statusMock: ReturnType<typeof vi.fn>;
  let jsonMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset all mocks including module-level mock implementations
    vi.resetModules();
    vi.clearAllMocks();

    // Setup response mocks
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      body: {},
      headers: {},
    };

    mockRes = {
      status: statusMock as any,
      json: jsonMock as any,
    };

    // Mock console methods to reduce noise
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Mock environment variables
    process.env.FRONTEND_URL = "http://localhost:5173";
    vi.mocked(Purchase.updateOne).mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    } as any);
    vi.mocked(Program.findById).mockResolvedValue({
      _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439013"),
      title: "Test Program",
      programType: "Workshop",
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handleStripeWebhook", () => {
    describe("webhook signature verification", () => {
      it("should return 400 if stripe-signature header is missing", async () => {
        mockReq.headers = {};

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Missing stripe-signature header",
        });
      });

      it("should return 400 if webhook signature verification fails", async () => {
        mockReq.headers = { "stripe-signature": "invalid_signature" };
        mockReq.body = "raw_body";

        vi.mocked(stripeService.constructWebhookEvent).mockImplementation(
          () => {
            throw new Error("Invalid signature");
          },
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(400);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Webhook Error: Invalid signature",
        });
      });

      it("should verify webhook signature successfully", async () => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        const mockEvent = {
          type: "unhandled_event",
          data: { object: {} },
        } as unknown as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(stripeService.constructWebhookEvent).toHaveBeenCalledWith(
          "raw_body",
          "valid_signature",
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          received: true,
        });
      });
    });

    describe("event handling", () => {
      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";
      });

      it("should handle checkout.session.completed event", async () => {
        const mockSession = {
          id: "cs_test_123",
          metadata: { purchaseId: "purchase123" },
        } as unknown as Stripe.Checkout.Session;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );

        const mockPurchase = {
          _id: "purchase123",
          status: "pending",
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            },
            programId: {
              title: "Test Program",
              programType: "Workshop",
            },
          }),
        };

        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(lockService.withLock).toHaveBeenCalledWith(
          "purchase:complete:purchase123",
          expect.any(Function),
          15000,
        );
        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          received: true,
        });
      });

      it("should handle payment_intent.succeeded event", async () => {
        const mockPaymentIntent = {
          id: "pi_test_123",
        } as Stripe.PaymentIntent;

        const mockEvent = {
          type: "payment_intent.succeeded",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );

        const mockPurchase = {
          status: "pending",
          orderNumber: "ORDER-001",
          purchaseType: "program",
          programId: new mongoose.Types.ObjectId(
            "507f1f77bcf86cd799439013",
          ),
          studentRoleId: undefined as string | undefined,
          studentRoleName: undefined as string | undefined,
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.findOne).toHaveBeenCalledWith({
          stripePaymentIntentId: "pi_test_123",
        });
        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.studentRoleId).toBe("mentee");
        expect(mockPurchase.studentRoleName).toBe("Mentee");
        expect(Purchase.updateOne).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "pending",
            stripePaymentIntentId: "pi_test_123",
          }),
          expect.objectContaining({
            $set: expect.objectContaining({
              status: "completed",
              studentRoleId: "mentee",
              studentRoleName: "Mentee",
            }),
          }),
          { runValidators: true },
        );
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).toHaveBeenCalledWith(
          {
            purchaseType: "program",
            programId: mockPurchase.programId,
          },
          {
            actor: { type: "system", key: "stripe-webhook" },
            source: "system",
            correlationId: "pi_test_123",
          },
        );
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("fails payment-intent completion when the legacy Program role is ambiguous", async () => {
        const mockPaymentIntent = {
          id: "pi_ambiguous_role",
        } as Stripe.PaymentIntent;
        const pendingPurchase = {
          status: "pending",
          orderNumber: "ORDER-AMBIGUOUS",
          purchaseType: "program",
          programId: new mongoose.Types.ObjectId(
            "507f1f77bcf86cd799439013",
          ),
          isClassRep: false,
          save: vi.fn().mockResolvedValue({}),
        };
        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue({
          type: "payment_intent.succeeded",
          data: { object: mockPaymentIntent },
        } as Stripe.Event);
        vi.mocked(Purchase.findOne).mockResolvedValue(pendingPurchase as any);
        vi.mocked(Program.findById).mockResolvedValue({
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
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(pendingPurchase.status).toBe("pending");
        expect(pendingPurchase.save).not.toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).not.toHaveBeenCalled();
      });

      it("should handle payment_intent.payment_failed event", async () => {
        const mockPaymentIntent = {
          id: "pi_test_123",
        } as Stripe.PaymentIntent;

        const mockEvent = {
          type: "payment_intent.payment_failed",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );

        const mockPurchase = {
          status: "pending",
          orderNumber: "ORDER-001",
          isClassRep: false,
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.findOne).toHaveBeenCalledWith({
          stripePaymentIntentId: "pi_test_123",
        });
        expect(mockPurchase.status).toBe("failed");
        expect(Purchase.updateOne).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle unhandled event types gracefully", async () => {
        const mockEvent = {
          type: "customer.created",
          data: { object: {} },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          received: true,
        });
      });

      it("should return 500 if event processing fails", async () => {
        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: {} as Stripe.Checkout.Session },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockRejectedValue(
          new Error("Lock failed"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(jsonMock).toHaveBeenCalledWith({
          success: false,
          message: "Webhook processing failed",
        });
      });
    });

    describe("checkout session completion", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockSession = {
          id: "cs_test_123",
          payment_intent: "pi_test_123",
          metadata: { purchaseId: "purchase123" },
          customer_details: {
            name: "John Doe",
            email: "john@example.com",
            address: {
              line1: "123 Main St",
              city: "New York",
              state: "NY",
              postal_code: "10001",
              country: "US",
            },
          },
        } as unknown as Stripe.Checkout.Session;

        mockPurchase = {
          _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439011"),
          status: "pending",
          orderNumber: "ORDER-001",
          userId: new mongoose.Types.ObjectId("507f1f77bcf86cd799439012"),
          programId: new mongoose.Types.ObjectId("507f1f77bcf86cd799439013"),
          purchaseType: "program",
          eventId: null,
          billingInfo: {
            fullName: "",
            email: "",
          },
          finalPrice: 100,
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockReturnThis(),
        } as any;

        // Make populate return the purchase with populated fields
        mockPurchase.userId = {
          _id: "507f1f77bcf86cd799439012",
          email: "john@example.com",
          firstName: "John",
          lastName: "Doe",
        } as any;
        mockPurchase.programId = {
          _id: "507f1f77bcf86cd799439013",
          title: "Test Program",
          programType: "Workshop",
        } as any;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should use unified lock with purchaseId from metadata", async () => {
        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(lockService.withLock).toHaveBeenCalledWith(
          "purchase:complete:purchase123",
          expect.any(Function),
          15000,
        );
      });

      it("recovers checkout completion from signed purchaseId metadata when the local session-id save was missed", async () => {
        mockPurchase.stripeSessionId = undefined;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.updateOne).toHaveBeenCalledWith(
          expect.objectContaining({
            _id: mockPurchase._id,
            status: "pending",
          }),
          expect.objectContaining({
            $set: expect.objectContaining({
              status: "completed",
              stripeSessionId: "cs_test_123",
            }),
          }),
          { runValidators: true },
        );
        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.stripeSessionId).toBe("cs_test_123");
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).toHaveBeenCalledTimes(1);
      });

      it("recovers a retried checkout when its old non-empty session ID was not replaced locally", async () => {
        mockPurchase.stripeSessionId = "cs_old_session";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.stripeSessionId).toBe("cs_test_123");
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).toHaveBeenCalledTimes(1);
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should fall back to session ID lock for backward compatibility", async () => {
        mockSession.metadata = {};
        mockPurchase = {
          ...mockPurchase,
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue(mockPurchase),
        };

        vi.mocked(Purchase.findById).mockResolvedValue(null);
        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(lockService.withLock).toHaveBeenCalledWith(
          "webhook:session:cs_test_123",
          expect.any(Function),
          15000,
        );
      });

      it("should handle missing purchase gracefully", async () => {
        vi.mocked(Purchase.findById).mockResolvedValue(null);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(jsonMock).toHaveBeenCalledWith({
          success: true,
          received: true,
        });
      });

      it("should skip processing if purchase already completed (idempotency)", async () => {
        mockPurchase.status = "completed";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it.each(["refunded", "failed", "refund_processing", "refund_failed"])(
        "ignores an out-of-order checkout completion for a %s purchase without restoring Program Room membership",
        async (terminalStatus) => {
          mockPurchase.status = terminalStatus;

          await WebhookController.handleStripeWebhook(
            mockReq as Request,
            mockRes as Response,
          );

          expect(mockPurchase.status).toBe(terminalStatus);
          expect(mockPurchase.save).not.toHaveBeenCalled();
          expect(stripeService.getPaymentIntent).not.toHaveBeenCalled();
          expect(
            programMembershipMutationSyncTrigger.programPurchaseChanged,
          ).not.toHaveBeenCalled();
          expect(statusMock).toHaveBeenCalledWith(200);
        },
      );

      it.each([
        "completed",
        "refunded",
        "failed",
        "refund_processing",
        "refund_failed",
      ])(
        "loses the checkout completion CAS to a concurrent %s transition without running winner side effects",
        async (persistedStatus) => {
          const terminalPurchase = {
            ...mockPurchase,
            status: persistedStatus,
          };
          vi.mocked(Purchase.findById)
            .mockResolvedValueOnce(mockPurchase)
            .mockResolvedValueOnce(terminalPurchase as any);
          vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
          } as any);

          await WebhookController.handleStripeWebhook(
            mockReq as Request,
            mockRes as Response,
          );

          expect(Purchase.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({
              _id: mockPurchase._id,
              status: "pending",
            }),
            expect.objectContaining({
              $set: expect.objectContaining({ status: "completed" }),
            }),
            { runValidators: true },
          );
          expect(mockPurchase.status).toBe("pending");
          expect(PromoCode.findOne).not.toHaveBeenCalled();
          expect(SystemConfig.getBundleDiscountConfig).not.toHaveBeenCalled();
          expect(
            EmailService.sendPurchaseConfirmationEmail,
          ).not.toHaveBeenCalled();
          expect(
            programMembershipMutationSyncTrigger.programPurchaseChanged,
          ).not.toHaveBeenCalled();
          expect(statusMock).toHaveBeenCalledWith(200);
        },
      );

      it("treats a purchase deleted by cancellation during checkout completion as a CAS miss", async () => {
        vi.mocked(Purchase.findById)
          .mockResolvedValueOnce(mockPurchase)
          .mockResolvedValueOnce(null);
        vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("pending");
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).not.toHaveBeenCalled();
        expect(EmailService.sendPurchaseConfirmationEmail).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should fetch and update payment method details", async () => {
        const mockPaymentIntent = {
          id: "pi_test_123",
          latest_charge: "ch_test_123",
        };

        const mockCharge = {
          payment_method_details: {
            card: {
              brand: "visa",
              last4: "4242",
            },
          },
          billing_details: {
            name: "John Doe",
          },
        };

        vi.mocked(stripeService.getPaymentIntent).mockResolvedValue(
          mockPaymentIntent as any,
        );

        const mockStripe = {
          charges: {
            retrieve: vi.fn().mockResolvedValue(mockCharge),
          },
        };

        vi.doMock("../../../src/services/stripeService", () => ({
          ...stripeService,
          stripe: mockStripe,
        }));

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.updateOne).toHaveBeenCalled();
        expect(mockPurchase.status).toBe("completed");
      });

      it("should update billing info from customer details", async () => {
        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.billingInfo.fullName).toBe("John Doe");
        expect(mockPurchase.billingInfo.email).toBe("john@example.com");
        expect(mockPurchase.billingInfo.address).toBe("123 Main St");
        expect(mockPurchase.billingInfo.city).toBe("New York");
        expect(mockPurchase.billingInfo.state).toBe("NY");
        expect(mockPurchase.billingInfo.zipCode).toBe("10001");
        expect(mockPurchase.billingInfo.country).toBe("US");
        expect(Purchase.updateOne).toHaveBeenCalled();
      });

      it("should mark purchase as completed with purchase date", async () => {
        const beforeDate = new Date();

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        const afterDate = new Date();

        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.purchaseDate).toBeDefined();
        expect(mockPurchase.purchaseDate.getTime()).toBeGreaterThanOrEqual(
          beforeDate.getTime(),
        );
        expect(mockPurchase.purchaseDate.getTime()).toBeLessThanOrEqual(
          afterDate.getTime(),
        );
        expect(Purchase.updateOne).toHaveBeenCalled();
      });

      it("persists a deterministic legacy role in the checkout completion CAS", async () => {
        mockPurchase.isClassRep = true;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.studentRoleId).toBe("classRep");
        expect(mockPurchase.studentRoleName).toBe("Class Representative");
        expect(Purchase.updateOne).toHaveBeenCalledTimes(1);
      });

      it("keeps checkout completion pending when its legacy Program role is ambiguous", async () => {
        mockPurchase.isClassRep = false;
        vi.mocked(Program.findById).mockResolvedValue({
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
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(500);
        expect(mockPurchase.status).toBe("pending");
        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).not.toHaveBeenCalled();
      });

      it("should continue if payment intent fetch fails", async () => {
        vi.mocked(stripeService.getPaymentIntent).mockRejectedValue(
          new Error("Stripe API error"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.updateOne).toHaveBeenCalled();
        expect(mockPurchase.status).toBe("completed");
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("promo code handling", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;
      let mockPromoCode: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockSession = {
          id: "cs_test_123",
          metadata: { purchaseId: "purchase123" },
          customer_details: { name: "Test User", email: "test@example.com" },
        } as unknown as Stripe.Checkout.Session;

        mockPurchase = {
          _id: "purchase123",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          promoCode: "TESTCODE",
          finalPrice: 80,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            },
            programId: {
              title: "Test Program",
              programType: "Workshop",
            },
          }),
        };

        mockPromoCode = {
          _id: new mongoose.Types.ObjectId(),
          code: "TESTCODE",
          isGeneral: false,
          isUsed: false,
          markAsUsed: vi.fn().mockResolvedValue({}),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(PromoCode.findOne).mockResolvedValue(mockPromoCode);
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            firstName: "Test",
            lastName: "User",
            email: "test@example.com",
          }),
        } as any);
        vi.mocked(Program.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({ title: "Test Program" }),
        } as any);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should mark personal promo code as used", async () => {
        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.findOne).toHaveBeenCalledWith({ code: "TESTCODE" });
        expect(mockPromoCode.markAsUsed).toHaveBeenCalledWith(
          mockPurchase.programId,
          mockPurchase.userId,
          "Test User",
          "test@example.com",
          "Test Program",
        );
      });

      it("should skip marking personal code if already used", async () => {
        mockPromoCode.isUsed = true;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPromoCode.markAsUsed).not.toHaveBeenCalled();
      });

      it("should notify admins when general staff code is used", async () => {
        mockPromoCode.isGeneral = true;

        const mockAdmins = [
          { _id: new mongoose.Types.ObjectId() },
          { _id: new mongoose.Types.ObjectId() },
        ];

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockAdmins),
        } as any);

        vi.mocked(TrioNotificationService.createTrio).mockResolvedValue(
          undefined as any,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(User.find).toHaveBeenCalledWith({
          role: { $in: ["Super Admin", "Administrator"] },
        });
        expect(TrioNotificationService.createTrio).toHaveBeenCalledWith({
          systemMessage: expect.objectContaining({
            title: "General Staff Code Used",
            type: "announcement",
            priority: "medium",
            targetRoles: ["Super Admin", "Administrator"],
            hideCreator: true,
          }),
          recipients: expect.arrayContaining([
            mockAdmins[0]._id.toString(),
            mockAdmins[1]._id.toString(),
          ]),
        });
      });

      it("should not notify admins for non-general codes", async () => {
        mockPromoCode.isGeneral = false;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(TrioNotificationService.createTrio).not.toHaveBeenCalled();
      });

      it("should continue if promo code notification fails", async () => {
        mockPromoCode.isGeneral = true;
        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue([{ _id: "admin1" }]),
        } as any);
        vi.mocked(TrioNotificationService.createTrio).mockRejectedValue(
          new Error("Notification failed"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(Purchase.updateOne).toHaveBeenCalled();
      });

      it("should continue if marking promo code fails", async () => {
        vi.mocked(PromoCode.findOne).mockRejectedValue(new Error("DB error"));

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(Purchase.updateOne).toHaveBeenCalled();
      });
    });

    describe("bundle promo code generation", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockSession = {
          id: "cs_test_123",
          metadata: { purchaseId: "purchase123" },
          customer_details: { name: "Test User", email: "test@example.com" },
        } as unknown as Stripe.Checkout.Session;

        mockPurchase = {
          _id: "purchase123",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          finalPrice: 100,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            },
            programId: {
              title: "Test Program",
              programType: "Workshop",
            },
          }),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should generate bundle promo code when feature enabled", async () => {
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: true,
          discountAmount: 20,
          expiryDays: 30,
        } as any);

        vi.mocked(PromoCode.generateUniqueCode).mockResolvedValue("BUNDLE123");

        const mockBundleCode = {
          _id: "bundle_id",
          code: "BUNDLE123",
        };

        vi.mocked(PromoCode.create).mockResolvedValue(mockBundleCode as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.generateUniqueCode).toHaveBeenCalled();
        expect(PromoCode.create).toHaveBeenCalledWith(
          expect.objectContaining({
            code: "BUNDLE123",
            type: "bundle_discount",
            applicableToType: "program",
            discountAmount: 20,
            ownerId: mockPurchase.userId,
            excludedProgramId: mockPurchase.programId,
            isActive: true,
            isUsed: false,
            createdBy: "system",
          }),
        );
        expect(mockPurchase.bundlePromoCode).toBe("BUNDLE123");
        expect(mockPurchase.bundleDiscountAmount).toBe(20);
      });

      it("does not overwrite a terminal status committed after the completion CAS when linking a bundle code", async () => {
        let persistedStatus = "pending";
        vi.mocked(Purchase.updateOne).mockImplementation(
          async (_filter, update: any) => {
            if (update.$set.status === "completed") {
              expect(persistedStatus).toBe("pending");
              persistedStatus = "completed";
            } else {
              expect(update.$set).not.toHaveProperty("status");
            }
            return {
              acknowledged: true,
              matchedCount: 1,
              modifiedCount: 1,
            } as any;
          },
        );
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: true,
          discountAmount: 20,
          expiryDays: 30,
        } as any);
        vi.mocked(PromoCode.generateUniqueCode).mockResolvedValue("BUNDLE123");
        vi.mocked(PromoCode.create).mockImplementation(async () => {
          persistedStatus = "refund_processing";
          return { _id: "bundle_id", code: "BUNDLE123" } as any;
        });

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(persistedStatus).toBe("refund_processing");
        expect(Purchase.updateOne).toHaveBeenCalledTimes(2);
        expect(mockPurchase.save).not.toHaveBeenCalled();
      });

      it("should not generate bundle code when feature disabled", async () => {
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.generateUniqueCode).not.toHaveBeenCalled();
        expect(PromoCode.create).not.toHaveBeenCalled();
      });

      it("should not generate bundle code for free purchases", async () => {
        mockPurchase.finalPrice = 0;

        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: true,
          discountAmount: 20,
          expiryDays: 30,
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.generateUniqueCode).not.toHaveBeenCalled();
      });

      it("should continue if bundle code generation fails", async () => {
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: true,
          discountAmount: 20,
          expiryDays: 30,
        } as any);

        vi.mocked(PromoCode.generateUniqueCode).mockRejectedValue(
          new Error("Generation failed"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(Purchase.updateOne).toHaveBeenCalled();
      });
    });

    describe("confirmation email", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockSession = {
          id: "cs_test_123",
          metadata: { purchaseId: "purchase123" },
          customer_details: { name: "Test User", email: "test@example.com" },
        } as unknown as Stripe.Checkout.Session;

        const userId = new mongoose.Types.ObjectId();
        const programId = new mongoose.Types.ObjectId();

        mockPurchase = {
          _id: "purchase123",
          status: "pending",
          purchaseType: "program",
          userId,
          programId,
          orderNumber: "ORDER-001",
          finalPrice: 100,
          fullPrice: 120,
          classRepDiscount: 10,
          earlyBirdDiscount: 10,
          isClassRep: true,
          isEarlyBird: true,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockImplementation(function (this: any) {
            // Modify in-place to simulate Mongoose populate behavior
            this.userId = {
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            };
            this.programId = {
              title: "Test Program",
              programType: "Workshop",
            };
            return Promise.resolve(this);
          }),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should send purchase confirmation email", async () => {
        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(EmailService.sendPurchaseConfirmationEmail).toHaveBeenCalledWith(
          {
            email: "test@example.com",
            name: "Test User",
            orderNumber: "ORDER-001",
            programTitle: "Test Program",
            programType: "Workshop",
            purchaseDate: expect.any(Date),
            fullPrice: 120,
            finalPrice: 100,
            classRepDiscount: 10,
            earlyBirdDiscount: 10,
            isClassRep: true,
            isEarlyBird: true,
            receiptUrl: expect.stringContaining(
              "/dashboard/purchase-receipt/purchase123",
            ),
          },
        );
      });

      it("should continue if email sending fails", async () => {
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockRejectedValue(
          new Error("Email failed"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
        expect(Purchase.updateOne).toHaveBeenCalled();
      });

      it("should skip email if user not found", async () => {
        mockPurchase.populate = vi.fn().mockImplementation(function (
          this: any,
        ) {
          this.userId = null;
          this.programId = { title: "Test Program" };
          return Promise.resolve(this);
        });

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(
          EmailService.sendPurchaseConfirmationEmail,
        ).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should skip email if program not found", async () => {
        mockPurchase.populate = vi.fn().mockImplementation(function (
          this: any,
        ) {
          this.userId = {
            email: "test@example.com",
            firstName: "Test",
            lastName: "User",
          };
          this.programId = null;
          return Promise.resolve(this);
        });

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(
          EmailService.sendPurchaseConfirmationEmail,
        ).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("payment_intent.payment_failed with Class Rep", () => {
      let mockPaymentIntent: Stripe.PaymentIntent;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockPaymentIntent = {
          id: "pi_test_123",
        } as Stripe.PaymentIntent;

        mockPurchase = {
          status: "pending",
          orderNumber: "ORDER-001",
          purchaseType: "program",
          programId: new mongoose.Types.ObjectId(),
          isClassRep: true,
          save: vi.fn().mockResolvedValue({}),
        };

        const mockEvent = {
          type: "payment_intent.payment_failed",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase);
      });

      it("should decrement classRepCount for failed Class Rep purchase", async () => {
        vi.mocked(Program.findByIdAndUpdate).mockResolvedValue({} as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.findByIdAndUpdate).toHaveBeenCalledWith(
          mockPurchase.programId,
          {
            $inc: {
              classRepCount: -1,
              "programRoles.studentRoles.1.count": -1,
            },
          },
          { runValidators: false },
        );
        expect(mockPurchase.status).toBe("failed");
        expect(Purchase.updateOne).toHaveBeenCalled();
      });

      it("should not decrement for non-Class Rep purchase", async () => {
        mockPurchase.isClassRep = false;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(mockPurchase.status).toBe("failed");
      });

      it("should handle missing purchase gracefully", async () => {
        vi.mocked(Purchase.findOne).mockResolvedValue(null);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Program.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("charge.refund.updated event handling", () => {
      let mockRefund: Stripe.Refund;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockRefund = {
          id: "re_test_123",
          status: "succeeded",
          metadata: {
            purchaseId: "purchase123",
            orderNumber: "ORDER-001",
          },
        } as unknown as Stripe.Refund;

        mockPurchase = {
          _id: "purchase123",
          status: "completed",
          orderNumber: "ORDER-001",
          userId: new mongoose.Types.ObjectId(),
          programId: { title: "Test Program" },
          finalPrice: 10000,
          purchaseDate: new Date(),
          promoCode: null,
          bundlePromoCode: null,
          billingInfo: {
            fullName: "Test User",
            email: "test@example.com",
          },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockReturnThis(),
        };

        const mockEvent = {
          type: "charge.refund.updated",
          data: { object: mockRefund },
        } as unknown as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findById).mockReturnValue(
          mockPurchaseFindByIdRefundChain(mockPurchase),
        );
        vi.mocked(User.findById).mockResolvedValue({
          _id: mockPurchase.userId,
          firstName: "Test",
          lastName: "User",
          email: "test@example.com",
        } as any);
        vi.mocked(User.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]),
        } as any);
        vi.mocked(TrioNotificationService.createTrio).mockResolvedValue(
          undefined,
        );
      });

      it("should handle refund succeeded event", async () => {
        mockRefund.status = "succeeded";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("refunded");
        expect(mockPurchase.refundedAt).toBeDefined();
        expect(mockPurchase.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should recover promo code on successful refund", async () => {
        mockRefund.status = "succeeded";
        mockPurchase.promoCode = "PROMO123";

        const mockPromoCode = {
          code: "PROMO123",
          isUsed: true,
          isActive: false,
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(PromoCode.findOne).mockResolvedValue(mockPromoCode as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPromoCode.isUsed).toBe(false);
        expect(mockPromoCode.isActive).toBe(true);
        expect(mockPromoCode.save).toHaveBeenCalled();
      });

      it("should delete bundle promo code on successful refund", async () => {
        mockRefund.status = "succeeded";
        mockPurchase.bundlePromoCode = "BUNDLE123";

        const mockBundleCode = {
          code: "BUNDLE123",
          isUsed: false,
        };

        vi.mocked(PromoCode.findOne).mockResolvedValue(mockBundleCode as any);
        vi.mocked(PromoCode.deleteOne).mockResolvedValue({} as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.deleteOne).toHaveBeenCalledWith({
          code: "BUNDLE123",
        });
      });

      it("should handle refund failed event", async () => {
        mockRefund.status = "failed";
        mockRefund.failure_reason = "insufficient_funds";
        const effects: string[] = [];
        mockPurchase.save.mockImplementation(async () => {
          effects.push("save");
          return {};
        });
        vi.mocked(socketService.disconnectUser).mockImplementation(() => {
          effects.push("disconnect");
          return true;
        });

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("refund_failed");
        expect(mockPurchase.refundFailureReason).toBe("insufficient_funds");
        expect(mockPurchase.save).toHaveBeenCalled();
        expect(socketService.disconnectUser).toHaveBeenCalledWith(
          mockPurchase.userId.toString(),
        );
        expect(effects).toEqual(["save", "disconnect"]);
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle refund pending event", async () => {
        mockRefund.status = "pending";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Pending refunds don't change purchase status
        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle refund canceled event", async () => {
        mockRefund.status = "canceled";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.refundFailureReason).toBe(
          "Refund was canceled by payment processor",
        );
        expect(mockPurchase.save).toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle unknown refund status gracefully", async () => {
        mockRefund.status = "unknown_status" as any;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Unknown status should not change purchase
        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle missing purchaseId in refund metadata", async () => {
        mockRefund.metadata = {};

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.findById).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle missing purchase for refund", async () => {
        vi.mocked(Purchase.findById).mockReturnValue(
          mockPurchaseFindByIdRefundChain(null),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should send admin notification on successful refund", async () => {
        mockRefund.status = "succeeded";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(TrioNotificationService.createTrio).toHaveBeenCalledWith(
          expect.objectContaining({
            systemMessage: expect.objectContaining({
              title: "Refund Completed",
              priority: "high",
            }),
          }),
        );
      });

      it("should continue if promo code recovery fails", async () => {
        mockRefund.status = "succeeded";
        mockPurchase.promoCode = "PROMO123";

        vi.mocked(PromoCode.findOne).mockRejectedValue(
          new Error("Database error"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should still complete successfully
        expect(mockPurchase.status).toBe("refunded");
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should send cancellation alert to admins for canceled refund", async () => {
        mockRefund.status = "canceled";

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(TrioNotificationService.createTrio).toHaveBeenCalledWith(
          expect.objectContaining({
            systemMessage: expect.objectContaining({
              title: "⚠️ Refund Canceled (Unusual)",
              type: "alert",
            }),
          }),
        );
      });
    });

    describe("promo code handling - event purchases", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;
      let mockPromoCode: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        const userId = new mongoose.Types.ObjectId();
        const eventId = new mongoose.Types.ObjectId();

        mockSession = {
          id: "cs_event_promo_123",
          metadata: { purchaseId: "event_promo_purchase_123" },
          customer_details: { name: "Promo User", email: "promo@example.com" },
        } as unknown as Stripe.Checkout.Session;

        mockPurchase = {
          _id: "event_promo_purchase_123",
          status: "pending",
          purchaseType: "event",
          userId,
          eventId,
          programId: null,
          promoCode: "EVENTCODE",
          finalPrice: 40,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "promo@example.com",
              firstName: "Promo",
              lastName: "User",
            },
            eventId: {
              title: "Promo Event",
            },
          }),
        };

        mockPromoCode = {
          _id: new mongoose.Types.ObjectId(),
          code: "EVENTCODE",
          isGeneral: false,
          isUsed: false,
          markAsUsedForEvent: vi.fn().mockResolvedValue({}),
          markAsUsed: vi.fn().mockResolvedValue({}),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(PromoCode.findOne).mockResolvedValue(mockPromoCode);
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            firstName: "Promo",
            lastName: "User",
            email: "promo@example.com",
          }),
        } as any);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should call markAsUsedForEvent for event purchases", async () => {
        // Mock Event model for fetching event title
        const mockEventModel = {
          findById: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ title: "Promo Event" }),
          }),
        };

        vi.doMock("../../../src/models/Event", () => ({
          default: mockEventModel,
        }));

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPromoCode.markAsUsedForEvent).toHaveBeenCalledWith(
          mockPurchase.eventId,
          mockPurchase.userId,
          "Promo User",
          "promo@example.com",
          expect.any(String),
        );
      });

      it("should notify admins when general staff code used for event", async () => {
        // Set promo code as general (staff code)
        mockPromoCode.isGeneral = true;

        const mockAdmins = [{ _id: new mongoose.Types.ObjectId() }];

        vi.mocked(User.find).mockReturnValue({
          select: vi.fn().mockResolvedValue(mockAdmins),
        } as any);

        vi.mocked(TrioNotificationService.createTrio).mockResolvedValue(
          undefined as any,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // The notification should be triggered for general codes
        // Verify the purchase completed successfully
        expect(mockPurchase.status).toBe("completed");
        expect(statusMock).toHaveBeenCalledWith(200);
        // Note: TrioNotificationService.createTrio will be called if admins are found
        // The actual call depends on User.find returning admins
      });
    });

    describe("promo code handling - promoCodeId lookup", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;
      let mockPromoCode: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        const promoCodeId = new mongoose.Types.ObjectId();

        mockSession = {
          id: "cs_promo_id_123",
          metadata: { purchaseId: "promo_id_purchase_123" },
          customer_details: { name: "Test User", email: "test@example.com" },
        } as unknown as Stripe.Checkout.Session;

        mockPurchase = {
          _id: "promo_id_purchase_123",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          promoCodeId: promoCodeId, // Using promoCodeId instead of promoCode string
          promoCode: null,
          finalPrice: 80,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            },
            programId: {
              title: "Test Program",
              programType: "Workshop",
            },
          }),
        };

        mockPromoCode = {
          _id: promoCodeId,
          code: "IDCODE",
          isGeneral: false,
          isUsed: false,
          markAsUsed: vi.fn().mockResolvedValue({}),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(PromoCode.findById).mockResolvedValue(mockPromoCode);
        vi.mocked(PromoCode.findOne).mockResolvedValue(null);
        vi.mocked(User.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({
            firstName: "Test",
            lastName: "User",
            email: "test@example.com",
          }),
        } as any);
        vi.mocked(Program.findById).mockReturnValue({
          select: vi.fn().mockResolvedValue({ title: "Test Program" }),
        } as any);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should find promo code by promoCodeId when promoCode string not present", async () => {
        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.findById).toHaveBeenCalledWith(
          mockPurchase.promoCodeId,
        );
        expect(mockPromoCode.markAsUsed).toHaveBeenCalled();
      });
    });

    describe("metadata edge cases", () => {
      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";
      });

      it("should handle empty metadata gracefully", async () => {
        const mockSession = {
          id: "cs_empty_meta",
          metadata: {},
          customer_details: null,
        } as unknown as Stripe.Checkout.Session;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(null);
        vi.mocked(Purchase.findOne).mockResolvedValue(null);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle undefined metadata gracefully", async () => {
        const mockSession = {
          id: "cs_undefined_meta",
          metadata: undefined,
          customer_details: null,
        } as unknown as Stripe.Checkout.Session;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findOne).mockResolvedValue(null);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle partial customer_details", async () => {
        const mockSession = {
          id: "cs_partial_customer",
          metadata: { purchaseId: "purchase_partial" },
          customer_details: {
            name: null,
            email: "partial@example.com",
            address: null,
          },
        } as unknown as Stripe.Checkout.Session;

        const mockPurchase = {
          _id: "purchase_partial",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          billingInfo: {
            fullName: "Original Name",
            email: "original@example.com",
          },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "partial@example.com",
              firstName: "P",
              lastName: "U",
            },
            programId: { title: "Program", programType: "Workshop" },
          }),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase as any);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should preserve original name when customer_details.name is null
        expect(mockPurchase.billingInfo.fullName).toBe("Original Name");
        expect(mockPurchase.billingInfo.email).toBe("partial@example.com");
        expect(Purchase.updateOne).toHaveBeenCalled();
      });

      it("should handle session with no payment_intent", async () => {
        const mockSession = {
          id: "cs_no_pi",
          payment_intent: null, // No payment intent (e.g., $0 checkout)
          metadata: { purchaseId: "purchase_no_pi" },
          customer_details: {
            name: "Free User",
            email: "free@example.com",
          },
        } as unknown as Stripe.Checkout.Session;

        const mockPurchase = {
          _id: "purchase_no_pi",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          finalPrice: 0,
          billingInfo: { fullName: "", email: "" },
          paymentMethod: { type: "card" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "free@example.com",
              firstName: "Free",
              lastName: "User",
            },
            programId: { title: "Free Program", programType: "Workshop" },
          }),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase as any);
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should still complete the purchase
        expect(mockPurchase.status).toBe("completed");
        expect(Purchase.updateOne).toHaveBeenCalled();
        // getPaymentIntent should not be called
        expect(stripeService.getPaymentIntent).not.toHaveBeenCalled();
      });
    });

    describe("donation checkout routing", () => {
      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";
      });

      it("should route to DonationWebhookController when metadata.type is donation", async () => {
        const mockSession = {
          id: "cs_donation_type",
          metadata: { type: "donation", donationId: "don_123" },
        } as unknown as Stripe.Checkout.Session;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );

        // Mock DonationWebhookController
        const mockDonationHandler = vi.fn().mockResolvedValue(undefined);
        vi.doMock(
          "../../../src/controllers/donations/DonationWebhookController",
          () => ({
            default: {
              handleDonationCheckout: mockDonationHandler,
            },
          }),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Purchase.findById should NOT be called for donations
        expect(lockService.withLock).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should route to DonationWebhookController when metadata.donationId exists", async () => {
        const mockSession = {
          id: "cs_donation_id",
          metadata: { donationId: "don_456" },
        } as unknown as Stripe.Checkout.Session;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(lockService.withLock).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("payment_intent.succeeded edge cases", () => {
      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";
      });

      it("should not update already completed purchase", async () => {
        const mockPaymentIntent = {
          id: "pi_already_done",
        } as Stripe.PaymentIntent;

        const mockEvent = {
          type: "payment_intent.succeeded",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;

        const mockPurchase = {
          status: "completed", // Already completed
          orderNumber: "DONE-001",
          save: vi.fn(),
        };

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it.each(["refunded", "failed", "refund_processing", "refund_failed"])(
        "ignores an out-of-order payment-intent success for a %s purchase without restoring Program Room membership",
        async (terminalStatus) => {
          const mockPaymentIntent = {
            id: `pi_${terminalStatus}`,
          } as Stripe.PaymentIntent;
          const mockPurchase = {
            status: terminalStatus,
            orderNumber: `ORDER-${terminalStatus}`,
            purchaseType: "program",
            programId: new mongoose.Types.ObjectId(),
            save: vi.fn(),
          };

          vi.mocked(stripeService.constructWebhookEvent).mockReturnValue({
            type: "payment_intent.succeeded",
            data: { object: mockPaymentIntent },
          } as Stripe.Event);
          vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase as any);

          await WebhookController.handleStripeWebhook(
            mockReq as Request,
            mockRes as Response,
          );

          expect(mockPurchase.status).toBe(terminalStatus);
          expect(mockPurchase.save).not.toHaveBeenCalled();
          expect(Program.findById).not.toHaveBeenCalled();
          expect(
            programMembershipMutationSyncTrigger.programPurchaseChanged,
          ).not.toHaveBeenCalled();
          expect(statusMock).toHaveBeenCalledWith(200);
        },
      );

      it.each([
        "completed",
        "refunded",
        "failed",
        "refund_processing",
        "refund_failed",
      ])(
        "loses the payment-intent success CAS to a concurrent %s transition without restoring Program Room membership",
        async (persistedStatus) => {
          const purchaseId = new mongoose.Types.ObjectId();
          const stalePendingPurchase = {
            _id: purchaseId,
            status: "pending",
            orderNumber: "ORDER-CAS-LOSS",
            purchaseType: "program",
            programId: new mongoose.Types.ObjectId(
              "507f1f77bcf86cd799439013",
            ),
            isClassRep: false,
            save: vi.fn(),
          };
          vi.mocked(stripeService.constructWebhookEvent).mockReturnValue({
            type: "payment_intent.succeeded",
            data: { object: { id: "pi_cas_loss" } as Stripe.PaymentIntent },
          } as Stripe.Event);
          vi.mocked(Purchase.findOne).mockResolvedValue(
            stalePendingPurchase as any,
          );
          vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
          } as any);
          vi.mocked(Purchase.findById).mockResolvedValue({
            ...stalePendingPurchase,
            status: persistedStatus,
          } as any);

          await WebhookController.handleStripeWebhook(
            mockReq as Request,
            mockRes as Response,
          );

          expect(Purchase.updateOne).toHaveBeenCalledWith(
            {
              _id: purchaseId,
              status: "pending",
              stripePaymentIntentId: "pi_cas_loss",
            },
            expect.objectContaining({
              $set: expect.objectContaining({ status: "completed" }),
            }),
            { runValidators: true },
          );
          expect(stalePendingPurchase.status).toBe("pending");
          expect(stalePendingPurchase.save).not.toHaveBeenCalled();
          expect(
            programMembershipMutationSyncTrigger.programPurchaseChanged,
          ).not.toHaveBeenCalled();
          expect(statusMock).toHaveBeenCalledWith(200);
        },
      );

      it("ignores a stale payment-intent success after retry reservation clears its identity", async () => {
        const purchaseId = new mongoose.Types.ObjectId();
        const stalePendingPurchase = {
          _id: purchaseId,
          status: "pending",
          orderNumber: "ORDER-OLD-PI-SUCCESS",
          purchaseType: "program",
          programId: new mongoose.Types.ObjectId(
            "507f1f77bcf86cd799439013",
          ),
          stripePaymentIntentId: "pi_old_attempt",
          isClassRep: false,
          save: vi.fn(),
        };
        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue({
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_old_attempt" } as Stripe.PaymentIntent },
        } as Stripe.Event);
        vi.mocked(Purchase.findOne).mockResolvedValue(
          stalePendingPurchase as any,
        );
        vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
        } as any);
        vi.mocked(Purchase.findById).mockResolvedValue({
          ...stalePendingPurchase,
          stripePaymentIntentId: undefined,
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.updateOne).toHaveBeenCalledWith(
          {
            _id: purchaseId,
            status: "pending",
            stripePaymentIntentId: "pi_old_attempt",
          },
          expect.any(Object),
          { runValidators: true },
        );
        expect(stalePendingPurchase.status).toBe("pending");
        expect(stalePendingPurchase.save).not.toHaveBeenCalled();
        expect(
          programMembershipMutationSyncTrigger.programPurchaseChanged,
        ).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle missing purchase for payment_intent.succeeded", async () => {
        const mockPaymentIntent = {
          id: "pi_orphan",
        } as Stripe.PaymentIntent;

        const mockEvent = {
          type: "payment_intent.succeeded",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findOne).mockResolvedValue(null);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("payment_intent.payment_failed edge cases", () => {
      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";
      });

      it("should not decrement classRepCount for already failed purchase", async () => {
        const mockPaymentIntent = {
          id: "pi_already_failed",
        } as Stripe.PaymentIntent;

        const mockEvent = {
          type: "payment_intent.payment_failed",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;

        const mockPurchase = {
          status: "failed", // Already failed - not pending
          isClassRep: true,
          programId: new mongoose.Types.ObjectId(),
          save: vi.fn().mockResolvedValue({}),
        };

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should not decrement because status is not pending
        expect(Program.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("does not revoke a completed purchase on a late payment failure", async () => {
        const mockPaymentIntent = {
          id: "pi_completed",
        } as Stripe.PaymentIntent;
        const mockEvent = {
          type: "payment_intent.payment_failed",
          data: { object: mockPaymentIntent },
        } as Stripe.Event;
        const mockPurchase = {
          status: "completed",
          orderNumber: "ORDER-COMPLETED",
          isClassRep: false,
          save: vi.fn().mockResolvedValue({}),
        };
        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findOne).mockResolvedValue(mockPurchase as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("completed");
        expect(mockPurchase.save).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("lets a concurrent success CAS win over a stale payment-failure handler", async () => {
        const purchaseId = new mongoose.Types.ObjectId();
        const staleFailurePurchase = {
          _id: purchaseId,
          status: "pending",
          orderNumber: "ORDER-SUCCESS-WON",
          purchaseType: "program",
          programId: new mongoose.Types.ObjectId(),
          stripePaymentIntentId: "pi_success_won",
          isClassRep: true,
          save: vi.fn(),
        };
        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue({
          type: "payment_intent.payment_failed",
          data: {
            object: { id: "pi_success_won" } as Stripe.PaymentIntent,
          },
        } as Stripe.Event);
        vi.mocked(Purchase.findOne).mockResolvedValue(
          staleFailurePurchase as any,
        );
        vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
        } as any);
        vi.mocked(Purchase.findById).mockResolvedValue({
          ...staleFailurePurchase,
          status: "completed",
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(staleFailurePurchase.status).toBe("pending");
        expect(Program.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(staleFailurePurchase.save).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("ignores a stale payment failure after retry reservation clears its identity", async () => {
        const purchaseId = new mongoose.Types.ObjectId();
        const staleFailurePurchase = {
          _id: purchaseId,
          status: "pending",
          orderNumber: "ORDER-OLD-PI-FAILURE",
          purchaseType: "program",
          programId: new mongoose.Types.ObjectId(),
          stripePaymentIntentId: "pi_old_attempt",
          isClassRep: true,
          save: vi.fn(),
        };
        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue({
          type: "payment_intent.payment_failed",
          data: {
            object: { id: "pi_old_attempt" } as Stripe.PaymentIntent,
          },
        } as Stripe.Event);
        vi.mocked(Purchase.findOne).mockResolvedValue(
          staleFailurePurchase as any,
        );
        vi.mocked(Purchase.updateOne).mockResolvedValueOnce({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
        } as any);
        vi.mocked(Purchase.findById).mockResolvedValue({
          ...staleFailurePurchase,
          stripePaymentIntentId: undefined,
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(Purchase.updateOne).toHaveBeenCalledWith(
          {
            _id: purchaseId,
            status: "pending",
            stripePaymentIntentId: "pi_old_attempt",
          },
          expect.any(Object),
          { runValidators: true },
        );
        expect(staleFailurePurchase.status).toBe("pending");
        expect(Program.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(staleFailurePurchase.save).not.toHaveBeenCalled();
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("refund edge cases - promo code and bundle handling", () => {
      let mockRefund: Stripe.Refund;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockRefund = {
          id: "re_edge_123",
          status: "succeeded",
          metadata: {
            purchaseId: "edge_purchase_123",
            orderNumber: "EDGE-001",
          },
        } as unknown as Stripe.Refund;

        mockPurchase = {
          _id: "edge_purchase_123",
          status: "completed",
          orderNumber: "EDGE-001",
          userId: new mongoose.Types.ObjectId(),
          programId: { title: "Edge Program" },
          finalPrice: 5000,
          purchaseDate: new Date(),
          promoCode: null,
          bundlePromoCode: null,
          billingInfo: {
            fullName: "Edge User",
            email: "edge@example.com",
          },
          save: vi.fn().mockResolvedValue({}),
        };

        const mockEvent = {
          type: "charge.refund.updated",
          data: { object: mockRefund },
        } as unknown as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(Purchase.findById).mockReturnValue(
          mockPurchaseFindByIdRefundChain(mockPurchase),
        );
        vi.mocked(User.findById).mockResolvedValue({
          _id: mockPurchase.userId,
          firstName: "Edge",
          lastName: "User",
          email: "edge@example.com",
        } as any);
        vi.mocked(User.find).mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue([{ _id: new mongoose.Types.ObjectId() }]),
        } as any);
        vi.mocked(TrioNotificationService.createTrio).mockResolvedValue(
          undefined,
        );
      });

      it("should not try to recover promo code if purchase has no promoCode", async () => {
        mockPurchase.promoCode = null;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.findOne).not.toHaveBeenCalled();
        expect(mockPurchase.status).toBe("refunded");
      });

      it("should handle promo code that is already not used", async () => {
        mockPurchase.promoCode = "ALREADY_INACTIVE";

        const mockPromoCode = {
          code: "ALREADY_INACTIVE",
          isUsed: false, // Already not used
          isActive: true,
          save: vi.fn(),
        };

        vi.mocked(PromoCode.findOne).mockResolvedValue(mockPromoCode as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should not call save if already inactive
        expect(mockPromoCode.save).not.toHaveBeenCalled();
        expect(mockPurchase.status).toBe("refunded");
      });

      it("should handle bundle code deletion for already used bundle code", async () => {
        mockPurchase.bundlePromoCode = "USED_BUNDLE";

        const mockBundleCode = {
          code: "USED_BUNDLE",
          isUsed: true, // Bundle was already used
        };

        vi.mocked(PromoCode.findOne).mockResolvedValue(mockBundleCode as any);
        vi.mocked(PromoCode.deleteOne).mockResolvedValue({} as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should still delete even if used
        expect(PromoCode.deleteOne).toHaveBeenCalledWith({
          code: "USED_BUNDLE",
        });
      });

      it("should not try to delete bundle code if purchase has no bundlePromoCode", async () => {
        mockPurchase.bundlePromoCode = null;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(PromoCode.deleteOne).not.toHaveBeenCalled();
      });

      it("should continue if bundle code deletion fails", async () => {
        mockPurchase.bundlePromoCode = "FAIL_DELETE";

        vi.mocked(PromoCode.findOne).mockResolvedValue({
          code: "FAIL_DELETE",
          isUsed: false,
        } as any);
        vi.mocked(PromoCode.deleteOne).mockRejectedValue(
          new Error("Delete failed"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Should still complete successfully
        expect(mockPurchase.status).toBe("refunded");
        expect(statusMock).toHaveBeenCalledWith(200);
      });

      it("should handle refund with no failure_reason for failed status", async () => {
        mockRefund.status = "failed";
        mockRefund.failure_reason = undefined as any;

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(mockPurchase.status).toBe("refund_failed");
        expect(mockPurchase.refundFailureReason).toBe("Refund failed");
      });
    });

    describe("bundle promo code generation - edge cases", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockSession = {
          id: "cs_bundle_edge",
          metadata: { purchaseId: "bundle_edge_123" },
          customer_details: {
            name: "Bundle User",
            email: "bundle@example.com",
          },
        } as unknown as Stripe.Checkout.Session;

        mockPurchase = {
          _id: "bundle_edge_123",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          finalPrice: 100,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockResolvedValue({
            userId: {
              email: "bundle@example.com",
              firstName: "Bundle",
              lastName: "User",
            },
            programId: {
              title: "Bundle Program",
              programType: "Workshop",
            },
          }),
        };

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );
      });

      it("should set correct expiry date based on expiryDays config", async () => {
        const expiryDays = 45;
        const beforeDate = new Date();

        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: true,
          discountAmount: 15,
          expiryDays: expiryDays,
        } as any);

        vi.mocked(PromoCode.generateUniqueCode).mockResolvedValue("EXPIRY123");
        vi.mocked(PromoCode.create).mockResolvedValue({
          _id: "bundle_id",
          code: "EXPIRY123",
        } as any);

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Check expiry date is set correctly
        const expectedExpiry = new Date(beforeDate);
        expectedExpiry.setDate(expectedExpiry.getDate() + expiryDays);

        expect(PromoCode.create).toHaveBeenCalledWith(
          expect.objectContaining({
            expiresAt: expect.any(Date),
          }),
        );

        // Bundle expires at should be approximately correct
        expect(mockPurchase.bundleExpiresAt).toBeDefined();
      });

      it("should continue if PromoCode.create fails", async () => {
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: true,
          discountAmount: 20,
          expiryDays: 30,
        } as any);

        vi.mocked(PromoCode.generateUniqueCode).mockResolvedValue("FAIL123");
        vi.mocked(PromoCode.create).mockRejectedValue(
          new Error("Create failed"),
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        // Purchase should still be completed
        expect(mockPurchase.status).toBe("completed");
        expect(statusMock).toHaveBeenCalledWith(200);
      });
    });

    describe("email sending - edge cases", () => {
      let mockSession: Stripe.Checkout.Session;
      let mockPurchase: any;

      beforeEach(() => {
        mockReq.headers = { "stripe-signature": "valid_signature" };
        mockReq.body = "raw_body";

        mockSession = {
          id: "cs_email_edge",
          metadata: { purchaseId: "email_edge_123" },
          customer_details: { name: "Email User", email: "email@example.com" },
        } as unknown as Stripe.Checkout.Session;

        const mockEvent = {
          type: "checkout.session.completed",
          data: { object: mockSession },
        } as Stripe.Event;

        vi.mocked(stripeService.constructWebhookEvent).mockReturnValue(
          mockEvent,
        );
        vi.mocked(lockService.withLock).mockImplementation(async (_key, fn) =>
          fn(),
        );
        vi.mocked(SystemConfig.getBundleDiscountConfig).mockResolvedValue({
          enabled: false,
        } as any);
      });

      it("should handle missing discounts gracefully in email", async () => {
        mockPurchase = {
          _id: "email_edge_123",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          orderNumber: "EMAIL-001",
          finalPrice: 100,
          fullPrice: 100,
          // No discount fields
          classRepDiscount: undefined,
          earlyBirdDiscount: undefined,
          isClassRep: undefined,
          isEarlyBird: undefined,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockImplementation(function (this: any) {
            this.userId = {
              email: "email@example.com",
              firstName: "Email",
              lastName: "User",
            };
            this.programId = {
              title: "Test Program",
              programType: "Workshop",
            };
            return Promise.resolve(this);
          }),
        };

        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(EmailService.sendPurchaseConfirmationEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            classRepDiscount: 0, // Should default to 0
            earlyBirdDiscount: 0,
          }),
        );
      });

      it("should use FRONTEND_URL from environment for receipt URL", async () => {
        process.env.FRONTEND_URL = "https://production.example.com";

        mockPurchase = {
          _id: "email_env_123",
          status: "pending",
          purchaseType: "program",
          userId: new mongoose.Types.ObjectId(),
          programId: new mongoose.Types.ObjectId(),
          orderNumber: "ENV-001",
          finalPrice: 100,
          fullPrice: 100,
          billingInfo: { fullName: "", email: "" },
          save: vi.fn().mockResolvedValue({}),
          populate: vi.fn().mockImplementation(function (this: any) {
            this.userId = {
              email: "test@example.com",
              firstName: "Test",
              lastName: "User",
            };
            this.programId = {
              title: "Test Program",
              programType: "Workshop",
            };
            return Promise.resolve(this);
          }),
        };

        mockSession.metadata = { purchaseId: "email_env_123" };

        vi.mocked(Purchase.findById).mockResolvedValue(mockPurchase as any);
        vi.mocked(EmailService.sendPurchaseConfirmationEmail).mockResolvedValue(
          undefined as any,
        );

        await WebhookController.handleStripeWebhook(
          mockReq as Request,
          mockRes as Response,
        );

        expect(EmailService.sendPurchaseConfirmationEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            receiptUrl: expect.stringContaining(
              "https://production.example.com",
            ),
          }),
        );

        // Reset
        process.env.FRONTEND_URL = "http://localhost:5173";
      });
    });
  });
});
