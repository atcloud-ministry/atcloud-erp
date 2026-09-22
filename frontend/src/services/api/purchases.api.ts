import { BaseApiClient } from "./common";

export type ProgramAccessReason =
  | "admin"
  | "creator"
  | "mentor"
  | "class_rep"
  | "free"
  | "membership"
  | "purchased"
  | "not_purchased";

export interface ProgramAccessResult {
  hasAccess: boolean;
  reason: ProgramAccessReason;
}

/**
 * Purchases API Service
 * Handles purchase/payment operations, checkout sessions, and admin purchase management
 */
class PurchasesApiClient extends BaseApiClient {
  // ========== User Purchase Operations ==========

  async createCheckoutSession(params: {
    programId: string;
    studentRoleId?: string;
    isClassRep?: boolean;
    promoCode?: string;
  }): Promise<{
    sessionId: string | null;
    sessionUrl: string | null;
    orderId?: string;
    isFree?: boolean;
  }> {
    const res = await this.request<{
      sessionId: string | null;
      sessionUrl: string | null;
      orderId?: string;
      isFree?: boolean;
    }>(`/purchases/create-checkout-session`, {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (
      res.data || {
        sessionId: null,
        sessionUrl: null,
        orderId: "",
        isFree: false,
      }
    );
  }

  async getMyPurchases(): Promise<unknown[]> {
    const res = await this.request<unknown[]>(`/purchases/my-purchases`);
    return res.data || [];
  }

  async getMyPendingPurchases(): Promise<unknown[]> {
    const res = await this.request<unknown[]>(
      `/purchases/my-pending-purchases`,
    );
    return res.data || [];
  }

  async retryPurchase(
    purchaseId: string,
  ): Promise<{ sessionId: string; sessionUrl: string }> {
    const res = await this.request<{ sessionId: string; sessionUrl: string }>(
      `/purchases/retry/${purchaseId}`,
      {
        method: "POST",
      },
    );
    return res.data || { sessionId: "", sessionUrl: "" };
  }

  async cancelPendingPurchase(purchaseId: string): Promise<void> {
    await this.request(`/purchases/${purchaseId}`, {
      method: "DELETE",
    });
  }

  async verifySession(sessionId: string): Promise<unknown> {
    const res = await this.request<unknown>(
      `/purchases/verify-session/${sessionId}`,
    );
    return res.data;
  }

  async getPurchaseById(id: string): Promise<unknown> {
    const res = await this.request<unknown>(`/purchases/${id}`);
    return res.data;
  }

  async getPurchaseReceipt(id: string): Promise<unknown> {
    const res = await this.request<unknown>(`/purchases/${id}/receipt`);
    return res.data;
  }

  async checkProgramAccess(programId: string): Promise<ProgramAccessResult> {
    const res = await this.request<ProgramAccessResult>(
      `/purchases/check-access/${programId}`,
    );
    return res.data || { hasAccess: false, reason: "not_purchased" };
  }

  async checkProgramsAccess(
    programIds: string[],
  ): Promise<Record<string, ProgramAccessResult>> {
    if (programIds.length === 0) return {};

    const res = await this.request<{
      access: Array<ProgramAccessResult & { programId: string }>;
    }>("/purchases/check-access/batch", {
      method: "POST",
      body: JSON.stringify({ programIds }),
    });

    return Object.fromEntries(
      (res.data?.access || []).map(({ programId, hasAccess, reason }) => [
        programId,
        { hasAccess, reason },
      ]),
    );
  }

  // ========== Refund Operations ==========

  async checkRefundEligibility(purchaseId: string): Promise<{
    isEligible: boolean;
    requiresApproval: boolean;
    reason?: string;
    daysRemaining?: number;
    purchaseDate: string;
    refundDeadline: string;
    refundWindowExpired?: boolean;
  }> {
    const res = await this.request<{
      isEligible: boolean;
      requiresApproval: boolean;
      reason?: string;
      daysRemaining?: number;
      purchaseDate: string;
      refundDeadline: string;
      refundWindowExpired?: boolean;
    }>(`/purchases/refund-eligibility/${purchaseId}`);
    return (
      res.data || {
        isEligible: false,
        requiresApproval: false,
        reason: "Unknown error",
        purchaseDate: "",
        refundDeadline: "",
      }
    );
  }

  async initiateRefund(purchaseId: string): Promise<{
    purchaseId: string;
    orderNumber: string;
    refundId?: string;
    refundRequestId?: string;
    status: string;
    approvalRequired?: boolean;
    existingRequest?: boolean;
  }> {
    const res = await this.request<{
      purchaseId: string;
      orderNumber: string;
      refundId?: string;
      refundRequestId?: string;
      status: string;
      approvalRequired?: boolean;
      existingRequest?: boolean;
    }>(`/purchases/refund`, {
      method: "POST",
      body: JSON.stringify({ purchaseId }),
    });
    return (
      res.data || {
        purchaseId: "",
        orderNumber: "",
        status: "",
      }
    );
  }

  // ========== Admin Purchase Management ==========

  /**
   * Get all purchases for admin dashboard (Admin only)
   * @param params Query parameters for pagination, search, and filtering
   */
  async getAllPurchasesAdmin(params: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    purchaseType?: string;
  }): Promise<{
    purchases: unknown[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const queryParams = new URLSearchParams();
    if (params.page) queryParams.append("page", params.page.toString());
    if (params.limit) queryParams.append("limit", params.limit.toString());
    if (params.search) queryParams.append("search", params.search);
    if (params.status) queryParams.append("status", params.status);
    if (params.purchaseType)
      queryParams.append("purchaseType", params.purchaseType);

    const res = await this.request<{
      purchases: unknown[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }>(`/admin/purchases?${queryParams.toString()}`);
    return (
      res.data || {
        purchases: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      }
    );
  }

  /**
   * Get payment statistics for admin dashboard (Admin only)
   */
  async getPaymentStats(): Promise<{
    stats: {
      totalRevenue: number;
      totalPurchases: number;
      pendingPurchases: number;
      failedPurchases: number;
      pendingRevenue: number;
      failedRevenue: number;
      refundedPurchases: number;
      refundedRevenue: number;
      uniqueBuyers: number;
      classRepPurchases: number;
      promoCodeUsage: number;
      last30Days: {
        purchases: number;
        revenue: number;
        refunds: number;
        refundedRevenue: number;
      };
    };
  }> {
    const res = await this.request<{
      stats: {
        totalRevenue: number;
        totalPurchases: number;
        pendingPurchases: number;
        failedPurchases: number;
        pendingRevenue: number;
        failedRevenue: number;
        refundedPurchases: number;
        refundedRevenue: number;
        uniqueBuyers: number;
        classRepPurchases: number;
        promoCodeUsage: number;
        last30Days: {
          purchases: number;
          revenue: number;
          refunds: number;
          refundedRevenue: number;
        };
      };
    }>(`/admin/purchases/stats`);
    return (
      res.data || {
        stats: {
          totalRevenue: 0,
          totalPurchases: 0,
          pendingPurchases: 0,
          failedPurchases: 0,
          pendingRevenue: 0,
          failedRevenue: 0,
          refundedPurchases: 0,
          refundedRevenue: 0,
          uniqueBuyers: 0,
          classRepPurchases: 0,
          promoCodeUsage: 0,
          last30Days: {
            purchases: 0,
            revenue: 0,
            refunds: 0,
            refundedRevenue: 0,
          },
        },
      }
    );
  }
}

// Export singleton instance
const purchasesApiClient = new PurchasesApiClient();

// Export service methods
export const purchasesService = {
  // User operations
  createCheckoutSession: (
    params: Parameters<typeof purchasesApiClient.createCheckoutSession>[0],
  ) => purchasesApiClient.createCheckoutSession(params),
  getMyPurchases: () => purchasesApiClient.getMyPurchases(),
  getMyPendingPurchases: () => purchasesApiClient.getMyPendingPurchases(),
  retryPurchase: (purchaseId: string) =>
    purchasesApiClient.retryPurchase(purchaseId),
  cancelPendingPurchase: (purchaseId: string) =>
    purchasesApiClient.cancelPendingPurchase(purchaseId),
  verifySession: (sessionId: string) =>
    purchasesApiClient.verifySession(sessionId),
  getPurchaseById: (id: string) => purchasesApiClient.getPurchaseById(id),
  getPurchaseReceipt: (id: string) => purchasesApiClient.getPurchaseReceipt(id),
  checkProgramAccess: (programId: string) =>
    purchasesApiClient.checkProgramAccess(programId),
  checkProgramsAccess: (programIds: string[]) =>
    purchasesApiClient.checkProgramsAccess(programIds),

  // Refund operations
  checkRefundEligibility: (purchaseId: string) =>
    purchasesApiClient.checkRefundEligibility(purchaseId),
  initiateRefund: (purchaseId: string) =>
    purchasesApiClient.initiateRefund(purchaseId),

  // Admin operations
  getAllPurchasesAdmin: (
    params: Parameters<typeof purchasesApiClient.getAllPurchasesAdmin>[0],
  ) => purchasesApiClient.getAllPurchasesAdmin(params),
  getPaymentStats: () => purchasesApiClient.getPaymentStats(),
};

// Legacy export for backward compatibility
export const purchaseService = purchasesService;

// Additional legacy export for admin-specific operations
export const adminPurchaseService = {
  getAllPurchases: (params: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    purchaseType?: string;
  }) => purchasesApiClient.getAllPurchasesAdmin(params),
  getPaymentStats: () => purchasesApiClient.getPaymentStats(),
};
