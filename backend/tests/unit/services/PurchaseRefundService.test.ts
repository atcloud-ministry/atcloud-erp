import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/infrastructure/SocketService", () => ({
  socketService: {
    disconnectUser: vi.fn(),
  },
}));

import {
  applyPurchaseItemSnapshot,
  getPurchaseItemDetails,
  persistPurchaseUnenrollment,
} from "../../../src/services/PurchaseRefundService";
import { socketService } from "../../../src/services/infrastructure/SocketService";

describe("PurchaseRefundService item snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the stored item title when the linked event is unavailable", () => {
    const details = getPurchaseItemDetails({
      purchaseType: "event",
      itemTitle: "Spring Retreat",
      itemLabel: "Event",
    });

    expect(details).toEqual({
      itemType: "event",
      itemLabel: "Event",
      itemTitle: "Spring Retreat",
    });
  });

  it("captures the linked membership title before refund flows detach access", () => {
    const purchase = {
      purchaseType: "membership" as const,
      membershipId: { title: "2026-2027 NextGen Annual Membership" },
    };

    const changed = applyPurchaseItemSnapshot(purchase);

    expect(changed).toBe(true);
    expect(purchase.itemTitle).toBe("2026-2027 NextGen Annual Membership");
    expect(purchase.itemLabel).toBe("Annual Membership");
  });

  it("falls back to the type label when no title can be recovered", () => {
    const purchase = {
      purchaseType: "program" as const,
    };

    applyPurchaseItemSnapshot(purchase);

    expect(purchase.itemTitle).toBe("Program");
    expect(purchase.itemLabel).toBe("Program");
  });
});

describe("persistPurchaseUnenrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects live sockets only after the revocation is persisted", async () => {
    const userId = "507f1f77bcf86cd799439011";
    const purchase = {
      userId,
      purchaseType: "event",
      eventId: "507f1f77bcf86cd799439012",
      save: vi.fn().mockResolvedValue(undefined),
    } as any;

    await persistPurchaseUnenrollment(purchase, "refund_requested");

    expect(purchase.unenrolledAt).toBeInstanceOf(Date);
    expect(purchase.save).toHaveBeenCalledOnce();
    expect(socketService.disconnectUser).toHaveBeenCalledWith(userId);
    expect(purchase.save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(socketService.disconnectUser).mock.invocationCallOrder[0],
    );
  });

  it("keeps the live authorization unchanged when persistence fails", async () => {
    const purchase = {
      userId: "507f1f77bcf86cd799439011",
      purchaseType: "event",
      save: vi.fn().mockRejectedValue(new Error("write failed")),
    } as any;

    await expect(
      persistPurchaseUnenrollment(purchase, "refund_requested"),
    ).rejects.toThrow("write failed");
    expect(socketService.disconnectUser).not.toHaveBeenCalled();
  });
});
