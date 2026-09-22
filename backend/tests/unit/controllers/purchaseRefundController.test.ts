import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

/**
 * PurchaseRefundController - Unit Tests
 *
 * Tests the refund eligibility logic in isolation without database or HTTP requests.
 * Focuses on:
 * - calculateRefundEligibility() method
 * - 30-day window calculations
 * - Purchase status validation
 * - Edge cases (expired, already refunded, invalid status)
 */

// Import the controller's private method via reflection for testing
// Since calculateRefundEligibility is private, we'll test it through the public interface
// or extract it as a utility function. For now, we'll test the logic patterns.

describe("PurchaseRefundController - Unit Tests", () => {
  describe("Refund Eligibility Logic", () => {
    const REFUND_WINDOW_DAYS = 30;

    /**
     * Helper function that replicates the calculateRefundEligibility logic
     * for unit testing purposes
     */
    function calculateRefundEligibility(purchase: {
      status: string;
      purchaseDate: Date;
    }): {
      isEligible: boolean;
      reason?: string;
      daysRemaining?: number;
      purchaseDate: Date;
      refundDeadline: Date;
    } {
      // Normalize to start of day for consistent date comparisons
      const now = new Date();
      now.setHours(0, 0, 0, 0);

      const purchaseDate = new Date(purchase.purchaseDate);
      purchaseDate.setHours(0, 0, 0, 0);

      const refundDeadline = new Date(purchaseDate);
      refundDeadline.setDate(refundDeadline.getDate() + REFUND_WINDOW_DAYS);
      refundDeadline.setHours(23, 59, 59, 999); // End of the deadline day

      // Use Math.round (not Math.floor) because DST transitions can shift
      // midnight-to-midnight intervals by ±1 hour, making Math.floor off-by-one.
      const daysElapsed = Math.round(
        (now.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      const daysRemaining = REFUND_WINDOW_DAYS - daysElapsed;

      // Check if already refunded
      if (purchase.status === "refunded") {
        return {
          isEligible: false,
          reason: "This purchase has already been refunded.",
          purchaseDate,
          refundDeadline,
        };
      }

      // Check if purchase is completed
      if (
        purchase.status !== "completed" &&
        purchase.status !== "refund_failed"
      ) {
        return {
          isEligible: false,
          reason: `Purchase status is "${purchase.status}". Only completed purchases can be refunded.`,
          purchaseDate,
          refundDeadline,
        };
      }

      // Check if within 30-day window
      if (now > refundDeadline) {
        return {
          isEligible: false,
          reason: `Refund window has expired. Refunds are only available within ${REFUND_WINDOW_DAYS} days of purchase.`,
          daysRemaining: 0,
          purchaseDate,
          refundDeadline,
        };
      }

      // Eligible for refund
      return {
        isEligible: true,
        reason: `You have ${daysRemaining} day${
          daysRemaining !== 1 ? "s" : ""
        } remaining to request a refund.`,
        daysRemaining,
        purchaseDate,
        refundDeadline,
      };
    }

    describe("Status Validation", () => {
      it("should allow refund for 'completed' status", () => {
        const purchase = {
          status: "completed",
          purchaseDate: new Date(), // Today
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(30);
      });

      it("should allow refund for 'refund_failed' status", () => {
        const purchase = {
          status: "refund_failed",
          purchaseDate: new Date(), // Today
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(30);
      });

      it("should reject refund for 'pending' status", () => {
        const purchase = {
          status: "pending",
          purchaseDate: new Date(),
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("pending");
        expect(result.reason).toContain(
          "Only completed purchases can be refunded",
        );
      });

      it("should reject refund for 'failed' status", () => {
        const purchase = {
          status: "failed",
          purchaseDate: new Date(),
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("failed");
      });

      it("should reject refund for 'refund_processing' status", () => {
        const purchase = {
          status: "refund_processing",
          purchaseDate: new Date(),
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("refund_processing");
      });

      it("should reject refund for 'refunded' status", () => {
        const purchase = {
          status: "refunded",
          purchaseDate: new Date(),
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toBe("This purchase has already been refunded.");
      });
    });

    describe("30-Day Window Calculations", () => {
      it("should be eligible on day 1 (purchase date)", () => {
        const purchase = {
          status: "completed",
          purchaseDate: new Date(), // Today
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(30);
      });

      it("should be eligible on day 15 (mid-window)", () => {
        const fifteenDaysAgo = new Date();
        fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

        const purchase = {
          status: "completed",
          purchaseDate: fifteenDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(15);
      });

      it("should be eligible on day 29 (last day)", () => {
        const twentyNineDaysAgo = new Date();
        twentyNineDaysAgo.setDate(twentyNineDaysAgo.getDate() - 29);

        const purchase = {
          status: "completed",
          purchaseDate: twentyNineDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(1);
        expect(result.reason).toContain("1 day remaining");
      });

      it("should be eligible on day 30 (edge of window)", () => {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const purchase = {
          status: "completed",
          purchaseDate: thirtyDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(0);
      });

      it("should NOT be eligible on day 31 (expired)", () => {
        const thirtyOneDaysAgo = new Date();
        thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);

        const purchase = {
          status: "completed",
          purchaseDate: thirtyOneDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("Refund window has expired");
        expect(result.reason).toContain("30 days");
        expect(result.daysRemaining).toBe(0);
      });

      it("should NOT be eligible on day 45 (well past deadline)", () => {
        const fortyFiveDaysAgo = new Date();
        fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45);

        const purchase = {
          status: "completed",
          purchaseDate: fortyFiveDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("expired");
      });

      it("should NOT be eligible on day 90 (far past deadline)", () => {
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        const purchase = {
          status: "completed",
          purchaseDate: ninetyDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.daysRemaining).toBe(0);
      });
    });

    describe("Refund Deadline Calculations", () => {
      it("should calculate correct refund deadline", () => {
        const purchaseDate = new Date(2025, 0, 1, 12);
        const purchase = {
          status: "completed",
          purchaseDate,
        };

        const result = calculateRefundEligibility(purchase);

        // Purchase date normalized to 2025-01-01 00:00:00.000
        // Deadline is 30 days later at end of day: 2025-01-31 23:59:59.999
        const expectedDeadline = new Date(2025, 0, 31, 23, 59, 59, 999);
        expect(result.refundDeadline.toISOString()).toBe(
          expectedDeadline.toISOString(),
        );
      });

      it("should normalize purchase date to start of day", () => {
        const purchaseDate = new Date(2025, 0, 15, 8, 30);
        const purchase = {
          status: "completed",
          purchaseDate,
        };

        const result = calculateRefundEligibility(purchase);

        // Purchase date should be normalized to start of day (00:00:00.000)
        const expectedNormalizedDate = new Date(2025, 0, 15);
        expect(result.purchaseDate.toISOString()).toBe(
          expectedNormalizedDate.toISOString(),
        );
      });

      it("should handle leap year dates correctly", () => {
        const purchaseDate = new Date(2024, 1, 15, 12); // Leap year
        const purchase = {
          status: "completed",
          purchaseDate,
        };

        const result = calculateRefundEligibility(purchase);

        // Check that 30 days are added correctly (Feb 15 + 30 days = Mar 16)
        // Assert the calendar deadline, independent of the runner's UTC offset
        // and any daylight-saving transition between February and March.
        expect(result.refundDeadline).toEqual(
          new Date(2024, 2, 16, 23, 59, 59, 999),
        );
      });
    });

    describe("Reason Message Format", () => {
      it("should use singular 'day' for 1 day remaining", () => {
        const twentyNineDaysAgo = new Date();
        twentyNineDaysAgo.setDate(twentyNineDaysAgo.getDate() - 29);

        const purchase = {
          status: "completed",
          purchaseDate: twentyNineDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.reason).toBe(
          "You have 1 day remaining to request a refund.",
        );
      });

      it("should use plural 'days' for multiple days remaining", () => {
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

        const purchase = {
          status: "completed",
          purchaseDate: tenDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.reason).toBe(
          "You have 20 days remaining to request a refund.",
        );
      });

      it("should use plural 'days' for 30 days remaining", () => {
        const purchase = {
          status: "completed",
          purchaseDate: new Date(),
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.reason).toBe(
          "You have 30 days remaining to request a refund.",
        );
      });
    });

    describe("Edge Cases", () => {
      it("should handle purchase date in the future (clock skew)", () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        const purchase = {
          status: "completed",
          purchaseDate: tomorrow,
        };

        const result = calculateRefundEligibility(purchase);

        // Should still be eligible with more than 30 days
        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBeGreaterThan(30);
      });

      it("should handle midnight boundary correctly", () => {
        // Test purchase made 29 days + 23 hours + 59 minutes ago
        // This should still be within the 30-day window
        const almostThirtyDaysAgo = new Date();
        almostThirtyDaysAgo.setDate(almostThirtyDaysAgo.getDate() - 29);
        almostThirtyDaysAgo.setHours(almostThirtyDaysAgo.getHours() - 23);
        almostThirtyDaysAgo.setMinutes(almostThirtyDaysAgo.getMinutes() - 59);

        const purchase = {
          status: "completed",
          purchaseDate: almostThirtyDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        // Should still be within window (just barely)
        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBeGreaterThanOrEqual(0);
      });

      it("should handle purchases from different timezones", () => {
        // Purchase made at 11 PM UTC (could be different day in local timezone)
        const purchaseDate = new Date("2025-01-01T23:00:00Z");
        const purchase = {
          status: "completed",
          purchaseDate,
        };

        const result = calculateRefundEligibility(purchase);

        // Normalize the incoming instant to the runner's local calendar day;
        // east-of-UTC runners may already be on January 2.
        expect(result.refundDeadline).toEqual(
          new Date(
            purchaseDate.getFullYear(),
            purchaseDate.getMonth(),
            purchaseDate.getDate() + 30,
            23,
            59,
            59,
            999,
          ),
        );
      });

      it("should handle purchases at exactly noon", () => {
        const noon = new Date(2025, 0, 15, 12);
        const purchase = {
          status: "completed",
          purchaseDate: noon,
        };

        const result = calculateRefundEligibility(purchase);

        // Normalized to start of Jan 15, then 30 days to end of Feb 14
        const expectedDeadline = new Date(2025, 1, 14, 23, 59, 59, 999);
        expect(result.refundDeadline.toISOString()).toBe(
          expectedDeadline.toISOString(),
        );
      });
    });

    describe("Combined Status and Window Validation", () => {
      it("should reject 'pending' status even within refund window", () => {
        const purchase = {
          status: "pending",
          purchaseDate: new Date(), // Today
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("pending");
      });

      it("should reject 'refunded' status even within refund window", () => {
        const purchase = {
          status: "refunded",
          purchaseDate: new Date(), // Today
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("already been refunded");
      });

      it("should reject 'completed' status outside refund window", () => {
        const fortyDaysAgo = new Date();
        fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

        const purchase = {
          status: "completed",
          purchaseDate: fortyDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("expired");
      });

      it("should allow 'refund_failed' status to retry within window", () => {
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

        const purchase = {
          status: "refund_failed",
          purchaseDate: tenDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(true);
        expect(result.daysRemaining).toBe(20);
      });

      it("should reject 'refund_failed' status outside window", () => {
        const fortyDaysAgo = new Date();
        fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

        const purchase = {
          status: "refund_failed",
          purchaseDate: fortyDaysAgo,
        };

        const result = calculateRefundEligibility(purchase);

        expect(result.isEligible).toBe(false);
        expect(result.reason).toContain("expired");
      });
    });
  });
});
