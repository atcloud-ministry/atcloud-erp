import Program from "../models/Program";
import type { IPurchase } from "../models/Purchase";
import { buildDiscountRoleCountIncrement } from "../utils/programRoles";
import { socketService } from "./infrastructure/SocketService";

export const REFUND_WINDOW_DAYS = 30;

export type RefundEligibility = {
  isEligible: boolean;
  requiresApproval: boolean;
  reason?: string;
  daysRemaining?: number;
  purchaseDate: Date;
  refundDeadline: Date;
  refundWindowExpired: boolean;
};

export type PurchaseItemDetails = {
  itemTitle: string;
  itemLabel: "Program" | "Event" | "Annual Membership";
  itemType: "program" | "event" | "membership";
};

export type ProgramUnenrollReason =
  | "self_unenroll_refund"
  | "self_unenroll_no_refund"
  | "refund_requested";

function getReferenceId(value: unknown): unknown {
  if (value && typeof value === "object" && "_id" in value) {
    return (value as { _id: unknown })._id;
  }
  return value;
}

export function getPurchaseItemDetails(purchase: {
  purchaseType?: "program" | "event" | "membership";
  programId?: unknown;
  eventId?: unknown;
  membershipId?: unknown;
  itemTitle?: unknown;
  itemLabel?: unknown;
}): PurchaseItemDetails {
  const itemType =
    purchase.purchaseType === "event"
      ? "event"
      : purchase.purchaseType === "membership"
        ? "membership"
        : "program";
  const itemLabel =
    itemType === "event"
      ? "Event"
      : itemType === "membership"
        ? "Annual Membership"
        : "Program";
  const snapshotLabel =
    purchase.itemLabel === "Program" ||
    purchase.itemLabel === "Event" ||
    purchase.itemLabel === "Annual Membership"
      ? purchase.itemLabel
      : itemLabel;
  const linkedItem =
    itemType === "event"
      ? purchase.eventId
      : itemType === "membership"
        ? purchase.membershipId
        : purchase.programId;
  const linkedTitle =
    linkedItem &&
    typeof linkedItem === "object" &&
    "title" in linkedItem &&
    typeof linkedItem.title === "string" &&
    linkedItem.title.trim()
      ? linkedItem.title.trim()
      : undefined;

  const itemTitle =
    typeof purchase.itemTitle === "string" && purchase.itemTitle.trim()
      ? purchase.itemTitle.trim()
      : linkedTitle || snapshotLabel;

  return { itemTitle, itemLabel: snapshotLabel, itemType };
}

export function applyPurchaseItemSnapshot(purchase: {
  purchaseType?: "program" | "event" | "membership";
  programId?: unknown;
  eventId?: unknown;
  membershipId?: unknown;
  itemTitle?: string;
  itemLabel?: unknown;
}): boolean {
  const { itemTitle, itemLabel } = getPurchaseItemDetails(purchase);
  let changed = false;

  if (!purchase.itemTitle?.trim()) {
    purchase.itemTitle = itemTitle;
    changed = true;
  }

  if (purchase.itemLabel !== itemLabel) {
    purchase.itemLabel = itemLabel;
    changed = true;
  }

  return changed;
}

export function calculateRefundEligibility(purchase: {
  status?: string;
  purchaseDate: Date | string;
  finalPrice?: number;
  stripePaymentIntentId?: string;
}): RefundEligibility {
  const now = new Date();
  const purchaseDate = new Date(purchase.purchaseDate);
  const refundDeadline = new Date(purchaseDate);
  refundDeadline.setDate(refundDeadline.getDate() + REFUND_WINDOW_DAYS);
  const refundWindowExpired = now > refundDeadline;

  const daysElapsed = Math.floor(
    (now.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  const daysRemaining = Math.max(0, REFUND_WINDOW_DAYS - daysElapsed);

  if (
    purchase.status !== "completed" &&
    purchase.status !== "refund_failed"
  ) {
    return {
      isEligible: false,
      requiresApproval: false,
      reason: `Purchase status is "${purchase.status}". Only completed purchases can be refunded.`,
      purchaseDate,
      refundDeadline,
      refundWindowExpired,
    };
  }

  if ((purchase.finalPrice || 0) <= 0) {
    return {
      isEligible: false,
      requiresApproval: false,
      reason: "No payment was collected for this purchase, so there is no refund to issue.",
      purchaseDate,
      refundDeadline,
      refundWindowExpired,
    };
  }

  if (!purchase.stripePaymentIntentId) {
    return {
      isEligible: false,
      requiresApproval: false,
      reason: "No card payment was found for this purchase, so an automatic refund is not available.",
      purchaseDate,
      refundDeadline,
      refundWindowExpired,
    };
  }

  if (refundWindowExpired) {
    return {
      isEligible: false,
      requiresApproval: true,
      reason: `Refund window has expired. Refunds are only available within ${REFUND_WINDOW_DAYS} days of purchase.`,
      daysRemaining: 0,
      purchaseDate,
      refundDeadline,
      refundWindowExpired,
    };
  }

  return {
    isEligible: true,
    requiresApproval: false,
    reason: `You have ${daysRemaining} day${
      daysRemaining !== 1 ? "s" : ""
    } remaining to request a refund.`,
    daysRemaining,
    purchaseDate,
    refundDeadline,
    refundWindowExpired,
  };
}

async function markProgramPurchaseUnenrolled(
  purchase: IPurchase,
  reason: ProgramUnenrollReason,
  unenrolledAt = new Date(),
): Promise<boolean> {
  applyPurchaseItemSnapshot(purchase);
  const programId = getReferenceId(purchase.programId);

  if (purchase.unenrolledAt) {
    return false;
  }

  purchase.unenrolledAt = unenrolledAt;
  purchase.unenrollReason = reason;

  if (purchase.purchaseType === "program" && programId && purchase.isClassRep) {
    const program = await Program.findById(programId);

    await Program.findOneAndUpdate(
      {
        _id: programId,
      },
      {
        $inc: buildDiscountRoleCountIncrement(
          program || { classRepCount: 0 },
          -1,
          purchase.studentRoleId,
        ),
      },
      { runValidators: false },
    );
  }

  return true;
}

/**
 * Persist an entitlement revocation, then force every live connection for the
 * purchaser to re-authenticate and rejoin only the resource rooms it can still
 * access. The disconnect deliberately happens after the database write.
 */
export async function persistPurchaseUnenrollment(
  purchase: IPurchase,
  reason: ProgramUnenrollReason,
  unenrolledAt = new Date(),
): Promise<boolean> {
  const changed = await markProgramPurchaseUnenrolled(
    purchase,
    reason,
    unenrolledAt,
  );
  await purchase.save();

  if (purchase.unenrolledAt) {
    const userId = getReferenceId(purchase.userId);
    if (userId) socketService.disconnectUser(String(userId));
  }

  return changed;
}
