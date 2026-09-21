import mongoose from "mongoose";
import RefundRequest, {
  type IRefundRequest,
  type RefundRequestSource,
  type RefundRequestUserDecision,
} from "../models/RefundRequest";
import Purchase, { type IPurchase } from "../models/Purchase";
import User, { type IUser } from "../models/User";
import { EmailService } from "./infrastructure/EmailServiceFacade";
import { UnifiedMessageController } from "../controllers/unifiedMessageController";
import { lockService } from "./LockService";
import { processRefund } from "./stripeService";
import {
  applyPurchaseItemSnapshot,
  calculateRefundEligibility,
  getPurchaseItemDetails,
  persistPurchaseUnenrollment,
} from "./PurchaseRefundService";

const ADMIN_ROLES = ["Super Admin", "Administrator"];
const PENDING_REQUEST_DAYS = 20;
const FINISHED_CLEANUP_DAYS = 7;

type RequestDocument = IRefundRequest;
type AutomaticRefundSource = "purchase_history" | "program_unenroll";

type PopulatedUser = {
  _id: mongoose.Types.ObjectId;
  firstName?: string;
  lastName?: string;
  email: string;
  role: string;
  roleInAtCloud?: string;
};

type PopulatedPurchase = IPurchase & {
  _id: mongoose.Types.ObjectId;
};

function frontendUrl(path: string): string {
  const base = (process.env.FRONTEND_URL || "http://localhost:5173").replace(
    /\/$/,
    "",
  );
  return `${base}${path}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatCurrency(amount: number): string {
  return `$${(amount / 100).toFixed(2)}`;
}

function fullName(user: {
  firstName?: string;
  lastName?: string;
  username?: string;
  email?: string;
}): string {
  return (
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.username ||
    user.email ||
    "User"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getReferenceId(value: unknown): unknown {
  if (isRecord(value) && "_id" in value) {
    return value._id;
  }
  return value;
}

function getReferenceIdText(value: unknown): string | undefined {
  const id = getReferenceId(value);
  return id ? String(id) : undefined;
}

function itemDetailPath(purchase: IPurchase): string | undefined {
  if (purchase.purchaseType === "event" && purchase.eventId) {
    return `/dashboard/event/${getReferenceIdText(purchase.eventId)}`;
  }
  if (purchase.purchaseType === "membership" && purchase.membershipId) {
    return `/dashboard/annual-memberships/${getReferenceIdText(
      purchase.membershipId,
    )}`;
  }
  if (purchase.programId) {
    return `/dashboard/programs/${getReferenceIdText(purchase.programId)}`;
  }
  return undefined;
}

function actorDisplay(user: {
  firstName?: string;
  lastName?: string;
  role?: string;
  roleInAtCloud?: string;
}): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const pieces = [user.role, name].filter(Boolean).join(" ");
  return user.roleInAtCloud ? `${pieces}, ${user.roleInAtCloud}` : pieces;
}

function systemCreator(user: IUser) {
  return {
    id: String(user._id),
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    username: user.username || user.email,
    avatar: user.avatar,
    gender: user.gender || "male",
    authLevel: user.role,
    roleInAtCloud: user.roleInAtCloud,
  };
}

async function getRequestWithDetails(requestId: string) {
  return RefundRequest.findById(requestId)
    .populate<{ userId: PopulatedUser }>(
      "userId",
      "firstName lastName email role roleInAtCloud",
    )
    .populate<{ decidedBy: PopulatedUser }>(
      "decidedBy",
      "firstName lastName email role roleInAtCloud",
    )
    .populate<{ purchaseId: PopulatedPurchase }>("purchaseId")
    .lean();
}

async function getAdmins(): Promise<IUser[]> {
  return User.find({
    role: { $in: ADMIN_ROLES },
    isActive: true,
    isVerified: true,
  });
}

async function createSystemMessage(params: {
  recipients: string[];
  title: string;
  content: string;
  priority: "low" | "medium" | "high";
  metadata: Record<string, unknown>;
  creator?: IUser;
}): Promise<void> {
  await UnifiedMessageController.createTargetedSystemMessage(
    {
      title: params.title,
      content: params.content,
      type: params.priority === "high" ? "warning" : "announcement",
      priority: params.priority,
      hideCreator: !params.creator,
      metadata: params.metadata,
    },
    params.recipients,
    params.creator ? systemCreator(params.creator) : undefined,
  );
}

async function sendEmail(params: {
  to: string;
  subject: string;
  heading: string;
  body: string;
  ctaUrl?: string;
  ctaLabel?: string;
}): Promise<void> {
  const cta = params.ctaUrl
    ? `<p style="margin:24px 0;"><a href="${params.ctaUrl}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;display:inline-block;font-weight:600;">${params.ctaLabel || "Open Request"}</a></p>`
    : "";

  await EmailService.sendEmail({
    to: params.to,
    subject: params.subject,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;max-width:640px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;color:#111827;">${params.heading}</h2>
        <div style="white-space:pre-line;">${params.body}</div>
        ${cta}
        <p style="font-size:13px;color:#6b7280;margin-top:28px;">@Cloud Ministry</p>
      </div>
    `,
    text: `${params.heading}\n\n${params.body}${
      params.ctaUrl ? `\n\n${params.ctaLabel || "Open Request"}: ${params.ctaUrl}` : ""
    }`,
  });
}

export class RefundRequestService {
  static async notifyAdminsOfAutomaticRefund(params: {
    purchase: IPurchase;
    requester: IUser;
    source: AutomaticRefundSource;
    refundId: string;
  }): Promise<void> {
    const admins = await getAdmins();
    if (admins.length === 0) return;

    const { itemTitle, itemLabel } = getPurchaseItemDetails(params.purchase);
    const requesterName = fullName(params.requester);
    const roleText = params.purchase.isClassRep
      ? "class representative"
      : params.purchase.purchaseType === "event"
        ? "event participant"
        : params.purchase.purchaseType === "membership"
          ? "annual member"
          : "mentee";
    const sourceText =
      params.source === "program_unenroll"
        ? `Program detail unenrollment as ${roleText}`
        : "Purchase History refund request";
    const body =
      `${requesterName} (${params.requester.email}) submitted an automatic refund within the 30-day refund window.\n\n` +
      `${itemLabel}: ${itemTitle}\n` +
      `Order Number: ${params.purchase.orderNumber}\n` +
      `Amount: ${formatCurrency(params.purchase.finalPrice)}\n` +
      `Purchase Date: ${new Date(params.purchase.purchaseDate).toLocaleDateString("en-US")}\n` +
      `Refund ID: ${params.refundId}\n` +
      `Source: ${sourceText}\n\n` +
      "The user has been unenrolled immediately and the refund has been submitted to Stripe.";

    await Promise.all(
      admins.map((admin) =>
        sendEmail({
          to: admin.email,
          subject: `Automatic Refund Submitted - ${itemTitle}`,
          heading: "Automatic Refund Submitted",
          body,
          ctaUrl: frontendUrl("/dashboard/income-history"),
          ctaLabel: "View Income History",
        }),
      ),
    );

    await createSystemMessage({
      recipients: admins.map((admin) => String(admin._id)),
      title: "Automatic Refund Submitted",
      content: body,
      priority: "medium",
      creator: params.requester,
      metadata: {
        purchaseId: String(params.purchase._id),
        refundId: params.refundId,
        source: params.source,
        ctaUrl: "/dashboard/income-history",
        ctaLabel: "View Income History",
      },
    });
  }

  static async createApprovalRequest(params: {
    purchase: IPurchase;
    requester: IUser;
    source: RefundRequestSource;
    reason?: string;
  }): Promise<{ request: IRefundRequest; created: boolean }> {
    const now = new Date();
    const existing = await RefundRequest.findOne({
      userId: params.requester._id,
      purchaseId: params.purchase._id,
      status: "pending",
      requestExpiresAt: { $gt: now },
    });

    if (existing) {
      return { request: existing, created: false };
    }

    const snapshotChanged = applyPurchaseItemSnapshot(params.purchase);
    if (snapshotChanged) {
      await params.purchase.save();
    }

    const { itemTitle } = getPurchaseItemDetails(params.purchase);
    const request = await RefundRequest.create({
      userId: params.requester._id,
      purchaseId: params.purchase._id,
      purchaseType: params.purchase.purchaseType,
      programId:
        params.purchase.purchaseType === "program"
          ? getReferenceId(params.purchase.programId)
          : undefined,
      eventId:
        params.purchase.purchaseType === "event"
          ? getReferenceId(params.purchase.eventId)
          : undefined,
      membershipId:
        params.purchase.purchaseType === "membership"
          ? getReferenceId(params.purchase.membershipId)
          : undefined,
      source: params.source,
      status: "pending",
      reason: params.reason,
      refundAmount: params.purchase.finalPrice,
      itemTitle,
      requestedAt: now,
      requestExpiresAt: addDays(now, PENDING_REQUEST_DAYS),
    });

    await this.notifyAdminsOfRequest(request, params.purchase, params.requester);

    return { request, created: true };
  }

  static async getRequestForUser(requestId: string, user: IUser) {
    if (!mongoose.Types.ObjectId.isValid(requestId)) return null;

    let request = await getRequestWithDetails(requestId);
    if (!request) return null;

    const isAdmin = ADMIN_ROLES.includes(user.role);
    const isOwner = String(request.userId?._id || request.userId) === String(user._id);
    if (!isAdmin && !isOwner) return null;

    if (
      request.status === "pending" &&
      new Date(request.requestExpiresAt) <= new Date()
    ) {
      const requestDocument = await RefundRequest.findById(requestId);
      if (requestDocument) {
        await this.expireRequest(requestDocument as RequestDocument);
        request = await getRequestWithDetails(requestId);
        if (!request) return null;
      }
    }

    return this.formatRequest(request);
  }

  static async approve(requestId: string, admin: IUser) {
    return lockService.withLock(`refund-request:${requestId}`, async () => {
      const request = await RefundRequest.findById(requestId);
      if (!request) {
        return { ok: false as const, reason: "not_found" as const };
      }
      if (request.status !== "pending") {
        return {
          ok: false as const,
          reason: "already_decided" as const,
          request: await this.getRequestForUser(requestId, admin),
        };
      }
      if (request.requestExpiresAt <= new Date()) {
        await this.expireRequest(request);
        return {
          ok: false as const,
          reason: "expired" as const,
          request: await this.getRequestForUser(requestId, admin),
        };
      }

      const purchase = await Purchase.findById(request.purchaseId)
        .populate("programId", "title programType")
        .populate("eventId", "title")
        .populate("membershipId", "title");
      if (!purchase) {
        return { ok: false as const, reason: "purchase_missing" as const };
      }

      const eligibility = calculateRefundEligibility(purchase);
      if (!eligibility.requiresApproval && !eligibility.isEligible) {
        return {
          ok: false as const,
          reason: "not_refundable" as const,
          message: eligibility.reason,
        };
      }

      const refund = await processRefund({
        paymentIntentId: purchase.stripePaymentIntentId!,
        amount: purchase.finalPrice,
        reason: "requested_by_customer",
        metadata: {
          purchaseId: String(purchase._id),
          refundRequestId: String(request._id),
          orderNumber: purchase.orderNumber,
          userId: String(request.userId),
          source: "admin_approval",
        },
      });

      purchase.status = "refund_processing";
      purchase.refundInitiatedAt = new Date();
      purchase.refundFailureReason = undefined;
      purchase.stripeRefundId = refund.id;
      await persistPurchaseUnenrollment(purchase, "refund_requested");

      request.status = "approved";
      request.decidedAt = new Date();
      request.decidedBy = admin._id as mongoose.Types.ObjectId;
      request.stripeRefundId = refund.id;
      request.cleanupAfter = addDays(new Date(), FINISHED_CLEANUP_DAYS);
      await request.save();

      await this.notifyUserApproved(request, purchase, admin);

      return {
        ok: true as const,
        request: await this.getRequestForUser(requestId, admin),
      };
    });
  }

  static async reject(requestId: string, admin: IUser, note?: string) {
    return lockService.withLock(`refund-request:${requestId}`, async () => {
      const request = await RefundRequest.findById(requestId);
      if (!request) {
        return { ok: false as const, reason: "not_found" as const };
      }
      if (request.status !== "pending") {
        return {
          ok: false as const,
          reason: "already_decided" as const,
          request: await this.getRequestForUser(requestId, admin),
        };
      }
      if (request.requestExpiresAt <= new Date()) {
        await this.expireRequest(request);
        return {
          ok: false as const,
          reason: "expired" as const,
          request: await this.getRequestForUser(requestId, admin),
        };
      }

      request.status = "rejected";
      request.decidedAt = new Date();
      request.decidedBy = admin._id as mongoose.Types.ObjectId;
      request.decisionNote = note;
      await request.save();

      await this.notifyUserRejected(request, admin);

      return {
        ok: true as const,
        request: await this.getRequestForUser(requestId, admin),
      };
    });
  }

  static async recordUserDecision(
    requestId: string,
    user: IUser,
    decision: RefundRequestUserDecision,
  ) {
    return lockService.withLock(`refund-request:${requestId}`, async () => {
      const request = await RefundRequest.findById(requestId);
      if (!request) {
        return { ok: false as const, reason: "not_found" as const };
      }
      if (String(request.userId) !== String(user._id)) {
        return { ok: false as const, reason: "forbidden" as const };
      }
      if (request.status !== "rejected") {
        return {
          ok: false as const,
          reason: "not_waiting_for_user" as const,
          request: await this.getRequestForUser(requestId, user),
        };
      }
      if (request.userDecision) {
        return {
          ok: false as const,
          reason: "already_decided" as const,
          request: await this.getRequestForUser(requestId, user),
        };
      }

      if (decision === "unenroll_without_refund") {
        const purchase = await Purchase.findById(request.purchaseId)
          .populate("programId", "title")
          .populate("eventId", "title")
          .populate("membershipId", "title");
        if (purchase) {
          await persistPurchaseUnenrollment(
            purchase,
            "self_unenroll_no_refund",
          );
        }
      }

      request.userDecision = decision;
      request.userDecidedAt = new Date();
      request.cleanupAfter = addDays(new Date(), FINISHED_CLEANUP_DAYS);
      await request.save();

      return {
        ok: true as const,
        request: await this.getRequestForUser(requestId, user),
      };
    });
  }

  static async runCleanup(): Promise<{
    expiredNotified: number;
    deletedFinished: number;
  }> {
    const now = new Date();
    const expiredPending = await RefundRequest.find({
      status: "pending",
      requestExpiresAt: { $lte: now },
    }).limit(100);

    let expiredNotified = 0;
    for (const request of expiredPending) {
      await this.expireRequest(request);
      await RefundRequest.deleteOne({ _id: request._id });
      expiredNotified++;
    }

    const deleteResult = await RefundRequest.deleteMany({
      status: { $in: ["approved", "expired"] },
      cleanupAfter: { $lte: now },
    });

    const rejectedDoneDelete = await RefundRequest.deleteMany({
      status: "rejected",
      userDecision: { $exists: true },
      cleanupAfter: { $lte: now },
    });

    return {
      expiredNotified,
      deletedFinished:
        deleteResult.deletedCount + rejectedDoneDelete.deletedCount,
    };
  }

  private static async expireRequest(request: RequestDocument): Promise<void> {
    if (request.status !== "pending") return;

    request.status = "expired";
    request.cleanupAfter = new Date();
    await request.save();
    await this.notifyUserExpired(request);
  }

  private static async notifyAdminsOfRequest(
    request: IRefundRequest,
    purchase: IPurchase,
    requester: IUser,
  ): Promise<void> {
    const admins = await getAdmins();
    if (admins.length === 0) return;

    const url = frontendUrl(`/dashboard/refund-requests/${request._id}/approval`);
    const requesterName = fullName(requester);
    const roleText = purchase.isClassRep
      ? "class representative"
      : purchase.purchaseType === "event"
        ? "event participant"
        : purchase.purchaseType === "membership"
          ? "annual member"
          : "mentee";
    const body =
      `${requesterName} (${requester.email}) requested a refund after the 30-day refund window.\n\n` +
      `Purchase: ${request.itemTitle}\n` +
      `Order Number: ${purchase.orderNumber}\n` +
      `Amount: ${formatCurrency(request.refundAmount)}\n` +
      `Request source: ${
        request.source === "program_unenroll"
          ? `Program unenrollment as ${roleText}`
          : "Purchase History refund request"
      }\n\n` +
      `Please review this request. The request expires in ${PENDING_REQUEST_DAYS} days if no administrator responds.`;

    await Promise.all(
      admins.map((admin) =>
        sendEmail({
          to: admin.email,
          subject: `Refund Approval Needed - ${request.itemTitle}`,
          heading: "Refund Approval Needed",
          body,
          ctaUrl: url,
          ctaLabel: "Review Refund Request",
        }),
      ),
    );

    await createSystemMessage({
      recipients: admins.map((admin) => String(admin._id)),
      title: "Refund Approval Needed",
      content: body,
      priority: "high",
      metadata: {
        refundRequestId: String(request._id),
        ctaUrl: `/dashboard/refund-requests/${request._id}/approval`,
        ctaLabel: "Review Refund Request",
        purchaseId: String(purchase._id),
      },
    });
  }

  private static async notifyUserApproved(
    request: IRefundRequest,
    purchase: IPurchase,
    admin: IUser,
  ): Promise<void> {
    const requester = await User.findById(request.userId);
    if (!requester) return;

    const adminText = actorDisplay(admin);
    const body =
      `Your refund request for ${request.itemTitle} was approved by ${adminText}.\n\n` +
      `You have been unenrolled immediately. A refund of ${formatCurrency(
        request.refundAmount,
      )} has been submitted to your original payment method.`;

    await sendEmail({
      to: requester.email,
      subject: `Refund Approved - ${request.itemTitle}`,
      heading: "Refund Approved",
      body,
      ctaUrl: itemDetailPath(purchase)
        ? frontendUrl(itemDetailPath(purchase)!)
        : undefined,
      ctaLabel: "View Details",
    });

    await createSystemMessage({
      recipients: [String(request.userId)],
      title: "Refund Approved",
      content: body,
      priority: "high",
      creator: admin,
      metadata: {
        refundRequestId: String(request._id),
        purchaseId: String(purchase._id),
      },
    });
  }

  private static async notifyUserRejected(
    request: IRefundRequest,
    admin: IUser,
  ): Promise<void> {
    const requester = await User.findById(request.userId);
    if (!requester) return;

    const adminText = actorDisplay(admin);
    const decisionUrl = `/dashboard/refund-requests/${request._id}/decision`;
    const body =
      `Your refund request for ${request.itemTitle} was rejected by ${adminText}.\n\n` +
      `You will remain enrolled for now. Do you still want to unenroll without a refund?`;

    await sendEmail({
      to: requester.email,
      subject: `Refund Request Rejected - ${request.itemTitle}`,
      heading: "Refund Request Rejected",
      body,
      ctaUrl: frontendUrl(decisionUrl),
      ctaLabel: "Choose What Happens Next",
    });

    await createSystemMessage({
      recipients: [String(request.userId)],
      title: "Refund Request Rejected",
      content: body,
      priority: "high",
      creator: admin,
      metadata: {
        refundRequestId: String(request._id),
        ctaUrl: decisionUrl,
        ctaLabel: "Choose What Happens Next",
      },
    });
  }

  private static async notifyUserExpired(
    request: IRefundRequest,
  ): Promise<void> {
    const requester = await User.findById(request.userId);
    if (!requester) return;

    const body =
      `Your refund approval request for ${request.itemTitle} has expired because no administrator responded within ${PENDING_REQUEST_DAYS} days.\n\n` +
      "Please try to unenroll or request a refund again if you still want to proceed.";

    await sendEmail({
      to: requester.email,
      subject: `Refund Request Expired - ${request.itemTitle}`,
      heading: "Refund Request Expired",
      body,
      ctaUrl: frontendUrl("/dashboard/purchase-history"),
      ctaLabel: "Open Purchase History",
    });

    await createSystemMessage({
      recipients: [String(request.userId)],
      title: "Refund Request Expired",
      content: body,
      priority: "medium",
      metadata: {
        purchaseId: String(request.purchaseId),
        ctaUrl: "/dashboard/purchase-history",
        ctaLabel: "Open Purchase History",
      },
    });
  }

  private static formatRequest(request: Record<string, unknown>) {
    const requester = isRecord(request.userId) ? request.userId : null;
    const decidedBy = isRecord(request.decidedBy) ? request.decidedBy : null;
    const purchase = isRecord(request.purchaseId) ? request.purchaseId : null;
    const requesterName = requester
      ? fullName({
          firstName: readString(requester, "firstName"),
          lastName: readString(requester, "lastName"),
          username: readString(requester, "username"),
          email: readString(requester, "email"),
        })
      : "User";
    const decidedByName = decidedBy
      ? fullName({
          firstName: readString(decidedBy, "firstName"),
          lastName: readString(decidedBy, "lastName"),
          username: readString(decidedBy, "username"),
          email: readString(decidedBy, "email"),
        })
      : undefined;
    const decidedByDisplay = decidedBy
      ? actorDisplay({
          firstName: readString(decidedBy, "firstName"),
          lastName: readString(decidedBy, "lastName"),
          role: readString(decidedBy, "role"),
          roleInAtCloud: readString(decidedBy, "roleInAtCloud"),
        })
      : undefined;

    return {
      id: String(request._id || request.id),
      status: request.status,
      source: request.source,
      purchaseType: request.purchaseType,
      itemTitle: request.itemTitle,
      refundAmount: request.refundAmount,
      reason: request.reason,
      requestedAt: request.requestedAt,
      requestExpiresAt: request.requestExpiresAt,
      decidedAt: request.decidedAt,
      decisionNote: request.decisionNote,
      userDecision: request.userDecision,
      userDecidedAt: request.userDecidedAt,
      requester: requester
        ? {
            id: String(requester._id || request.userId),
            name: requesterName,
            email: readString(requester, "email"),
            role: readString(requester, "role"),
            roleInAtCloud: readString(requester, "roleInAtCloud"),
          }
        : undefined,
      decidedBy: decidedBy
        ? {
            id: String(decidedBy._id || request.decidedBy),
            name: decidedByName,
            email: readString(decidedBy, "email"),
            role: readString(decidedBy, "role"),
            roleInAtCloud: readString(decidedBy, "roleInAtCloud"),
            display: decidedByDisplay,
          }
        : undefined,
      purchase: purchase
        ? {
            id: String(purchase._id || request.purchaseId),
            orderNumber: purchase.orderNumber,
            purchaseDate: purchase.purchaseDate,
            status: purchase.status,
            finalPrice: purchase.finalPrice,
            isClassRep: purchase.isClassRep,
          }
        : undefined,
    };
  }
}
