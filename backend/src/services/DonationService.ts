import Donation, {
  IDonation,
  DonationType,
  DonationFrequency,
} from "../models/Donation";
import DonationTransaction, {
  IDonationTransaction,
} from "../models/DonationTransaction";
import User from "../models/User";
import { addWeeks, addMonths, addYears } from "date-fns";
import mongoose from "mongoose";
import { ValidationError, NotFoundError } from "../utils/errors";
import { normalizeSearchText, toLiteralTextSearch } from "../utils/search";

interface CreateDonationParams {
  userId: string;
  amount: number; // in cents
  type: DonationType;
  frequency?: DonationFrequency;
  giftDate?: Date; // for one-time
  startDate?: Date; // for recurring
  endDate?: Date;
  endAfterOccurrences?: number;
}

interface DonationStats {
  totalAmount: number;
  totalGifts: number;
}

class DonationService {
  /**
   * Create a new donation record
   */
  async createDonation(params: CreateDonationParams): Promise<IDonation> {
    const {
      userId,
      amount,
      type,
      frequency,
      giftDate,
      startDate,
      endDate,
      endAfterOccurrences,
    } = params;

    // Validation
    if (amount < 100 || amount > 99999900) {
      throw new Error("Amount must be between $1.00 and $999,999.00");
    }

    if (type === "one-time" && !giftDate) {
      throw new Error("Gift date is required for one-time donations");
    }

    if (type === "recurring") {
      if (!frequency) {
        throw new Error("Frequency is required for recurring donations");
      }
      if (!startDate) {
        throw new Error("Start date is required for recurring donations");
      }
    }

    // Get or create Stripe customer
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    // For now, we'll set a placeholder - this will be updated when Stripe checkout completes
    const stripeCustomerId = user.stripeCustomerId || "pending";

    // Auto-delete pending donations after 30 days
    const PENDING_TTL_DAYS = 30;
    const pendingExpiresAt = new Date();
    pendingExpiresAt.setDate(pendingExpiresAt.getDate() + PENDING_TTL_DAYS);

    const donationData: Partial<IDonation> = {
      userId: user._id,
      amount,
      type,
      frequency,
      status: "pending", // All donations start as pending until payment is confirmed
      giftDate,
      startDate,
      endDate,
      endAfterOccurrences,
      currentOccurrence: 0,
      stripeCustomerId,
      pendingExpiresAt,
    };

    // Calculate remaining occurrences if specified
    if (type === "recurring" && endAfterOccurrences) {
      donationData.remainingOccurrences = endAfterOccurrences;
    }

    // Set next payment date
    if (type === "recurring" && startDate) {
      donationData.nextPaymentDate = startDate;
    }

    const donation = await Donation.create(donationData);
    return donation;
  }

  /**
   * Get user's donation history (completed transactions)
   */
  async getUserDonationHistory(
    userId: string,
    page: number = 1,
    limit: number = 20,
    sortBy: string = "giftDate",
    sortOrder: string = "desc",
  ): Promise<{
    transactions: IDonationTransaction[];
    pending: IDonation[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const skip = (page - 1) * limit;
    const sortDirection = sortOrder === "asc" ? 1 : -1;
    const sortField = sortBy === "giftDate" ? "giftDate" : "giftDate"; // Default to giftDate

    // Fetch completed transactions
    const [transactions, total] = await Promise.all([
      DonationTransaction.find({
        userId,
        status: "completed",
      })
        .sort({ [sortField]: sortDirection })
        .skip(skip)
        .limit(limit)
        .lean(),
      DonationTransaction.countDocuments({
        userId,
        status: "completed",
      }),
    ]);

    // Fetch pending one-time donations (only on first page)
    const pending =
      page === 1
        ? await Donation.find({
            userId,
            type: "one-time",
            status: "pending",
          })
            .sort({ giftDate: -1 })
            .lean()
        : [];

    return {
      transactions: transactions as unknown as IDonationTransaction[],
      pending: pending as unknown as IDonation[],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get user's scheduled/active donations
   */
  async getUserScheduledDonations(userId: string): Promise<IDonation[]> {
    const donations = await Donation.find({
      userId,
      status: { $in: ["scheduled", "active", "on_hold"] },
    })
      .sort({ nextPaymentDate: 1 })
      .lean();

    return donations as unknown as IDonation[];
  }

  /**
   * Get user's donation stats
   */
  async getUserDonationStats(userId: string): Promise<DonationStats> {
    const result = await DonationTransaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          status: "completed",
        },
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          totalGifts: { $sum: 1 },
        },
      },
    ]);

    if (result.length === 0) {
      return {
        totalAmount: 0,
        totalGifts: 0,
      };
    }

    return {
      totalAmount: result[0].totalAmount,
      totalGifts: result[0].totalGifts,
    };
  }

  /**
   * Update donation (edit scheduled donation)
   */
  async updateDonation(
    donationId: string,
    userId: string,
    updates: Partial<CreateDonationParams>,
  ): Promise<IDonation> {
    const donation = await Donation.findOne({
      _id: donationId,
      userId,
    });

    if (!donation) {
      throw new NotFoundError("Donation not found");
    }

    if (donation.status === "completed" || donation.status === "cancelled") {
      throw new ValidationError("Cannot edit completed or cancelled donation");
    }

    // Update allowed fields
    if (updates.amount !== undefined) {
      if (updates.amount < 100 || updates.amount > 99999900) {
        throw new ValidationError(
          "Amount must be between $1.00 and $999,999.00",
        );
      }
      donation.amount = updates.amount;
    }

    if (updates.frequency) {
      donation.frequency = updates.frequency;
    }

    if (updates.startDate) {
      donation.startDate = updates.startDate;
      donation.nextPaymentDate = updates.startDate;
    }

    if (updates.giftDate) {
      donation.giftDate = updates.giftDate;
    }

    if (updates.endDate !== undefined) {
      donation.endDate = updates.endDate;
    }

    if (updates.endAfterOccurrences !== undefined) {
      donation.endAfterOccurrences = updates.endAfterOccurrences;
      donation.remainingOccurrences = updates.endAfterOccurrences;
    }

    await donation.save();
    return donation;
  }

  /**
   * Place donation on hold
   */
  async holdDonation(donationId: string, userId: string): Promise<IDonation> {
    const donation = await Donation.findOne({
      _id: donationId,
      userId,
    });

    if (!donation) {
      throw new NotFoundError("Donation not found");
    }

    if (donation.type === "one-time") {
      throw new ValidationError("Cannot hold one-time donations");
    }

    if (donation.status !== "active") {
      throw new ValidationError("Can only hold active donations");
    }

    donation.status = "on_hold";
    await donation.save();

    return donation;
  }

  /**
   * Resume donation from hold
   */
  async resumeDonation(donationId: string, userId: string): Promise<IDonation> {
    const donation = await Donation.findOne({
      _id: donationId,
      userId,
    });

    if (!donation) {
      throw new NotFoundError("Donation not found");
    }

    if (donation.status !== "on_hold") {
      throw new ValidationError("Can only resume donations that are on hold");
    }

    donation.status = "active";
    await donation.save();

    return donation;
  }

  /**
   * Cancel donation
   */
  async cancelDonation(donationId: string, userId: string): Promise<IDonation> {
    const donation = await Donation.findOne({
      _id: donationId,
      userId,
    });

    if (!donation) {
      throw new NotFoundError("Donation not found");
    }

    if (donation.status === "completed") {
      throw new ValidationError("Cannot cancel completed donation");
    }

    if (donation.status === "cancelled") {
      throw new ValidationError("Donation is already cancelled");
    }

    donation.status = "cancelled";
    await donation.save();

    return donation;
  }

  /**
   * Record a successful donation transaction (called from webhook)
   */
  async recordTransaction(data: {
    donationId: string;
    userId: string;
    amount: number;
    type: DonationType;
    stripePaymentIntentId: string;
    paymentMethod?: {
      cardBrand?: string;
      last4?: string;
    };
  }): Promise<IDonationTransaction> {
    const transaction = await DonationTransaction.create({
      donationId: data.donationId,
      userId: data.userId,
      amount: data.amount,
      type: data.type,
      status: "completed",
      giftDate: new Date(),
      stripePaymentIntentId: data.stripePaymentIntentId,
      paymentMethod: data.paymentMethod,
    });

    // Update donation record
    const donation = await Donation.findById(data.donationId);
    if (donation) {
      // Update payment method if provided
      if (data.paymentMethod) {
        donation.paymentMethod = {
          type: "card",
          ...data.paymentMethod,
        };
      }

      // For recurring donations, update occurrence counts
      if (donation.type === "recurring") {
        donation.currentOccurrence = (donation.currentOccurrence || 0) + 1;

        if (donation.remainingOccurrences !== undefined) {
          donation.remainingOccurrences = Math.max(
            0,
            donation.remainingOccurrences - 1,
          );
        }

        // Calculate next payment date
        if (donation.frequency && donation.nextPaymentDate) {
          donation.nextPaymentDate = this.calculateNextPaymentDate(
            donation.nextPaymentDate,
            donation.frequency,
          );
        }

        // Check if completed
        if (
          donation.endAfterOccurrences &&
          donation.currentOccurrence >= donation.endAfterOccurrences
        ) {
          donation.status = "completed";
          donation.lastGiftDate = new Date();
        }
      } else if (donation.type === "one-time") {
        // One-time donation completed
        donation.status = "completed";
      }

      await donation.save();
    }

    return transaction;
  }

  /**
   * Calculate next payment date based on frequency
   */
  private calculateNextPaymentDate(
    currentDate: Date,
    frequency: DonationFrequency,
  ): Date {
    switch (frequency) {
      case "weekly":
        return addWeeks(currentDate, 1);
      case "biweekly":
        return addWeeks(currentDate, 2);
      case "monthly":
        return addMonths(currentDate, 1);
      case "quarterly":
        return addMonths(currentDate, 3);
      case "annually":
        return addYears(currentDate, 1);
      default:
        return addMonths(currentDate, 1);
    }
  }

  /**
   * Calculate total amount for recurring donation with end condition
   */
  calculateTotalAmount(
    amount: number,
    frequency: DonationFrequency,
    startDate: Date,
    endCondition:
      | { type: "date"; endDate: Date }
      | { type: "occurrences"; count: number },
  ): { totalGifts: number; totalAmount: number; endDate: Date } {
    if (endCondition.type === "occurrences") {
      return {
        totalGifts: endCondition.count,
        totalAmount: amount * endCondition.count,
        endDate: this.calculateEndDateFromOccurrences(
          startDate,
          frequency,
          endCondition.count,
        ),
      };
    } else {
      const gifts = this.calculateOccurrencesBetweenDates(
        startDate,
        endCondition.endDate,
        frequency,
      );
      return {
        totalGifts: gifts,
        totalAmount: amount * gifts,
        endDate: endCondition.endDate,
      };
    }
  }

  /**
   * Calculate end date from number of occurrences
   */
  private calculateEndDateFromOccurrences(
    startDate: Date,
    frequency: DonationFrequency,
    occurrences: number,
  ): Date {
    let endDate = new Date(startDate);

    switch (frequency) {
      case "weekly":
        endDate = addWeeks(startDate, occurrences);
        break;
      case "biweekly":
        endDate = addWeeks(startDate, occurrences * 2);
        break;
      case "monthly":
        endDate = addMonths(startDate, occurrences);
        break;
      case "quarterly":
        endDate = addMonths(startDate, occurrences * 3);
        break;
      case "annually":
        endDate = addYears(startDate, occurrences);
        break;
    }

    return endDate;
  }

  /**
   * Calculate number of occurrences between two dates
   */
  private calculateOccurrencesBetweenDates(
    startDate: Date,
    endDate: Date,
    frequency: DonationFrequency,
  ): number {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const diffMs = end - start;

    if (diffMs <= 0) return 0;

    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    switch (frequency) {
      case "weekly":
        return Math.floor(diffDays / 7);
      case "biweekly":
        return Math.floor(diffDays / 14);
      case "monthly":
        return Math.floor(diffDays / 30); // Approximate
      case "quarterly":
        return Math.floor(diffDays / 91); // Approximate
      case "annually":
        return Math.floor(diffDays / 365);
      default:
        return 0;
    }
  }

  /**
   * Get all donations for admin (with pagination and filters)
   * ADMIN ONLY
   */
  async getAllDonations(
    page: number = 1,
    limit: number = 20,
    search: string = "",
    statusFilter: string = "all",
  ): Promise<{
    donations: Array<{
      _id: string;
      giftDate: Date;
      user: {
        firstName: string;
        lastName: string;
        email: string;
      };
      type: DonationType;
      status: string;
      amount: number;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const skip = (page - 1) * limit;

    // Build filter query
    const filterQuery: Record<string, unknown> = {};

    if (statusFilter !== "all") {
      filterQuery.status = statusFilter;
    }

    // Build search query - search both donations and transactions
    let searchQuery: Record<string, unknown> = {};
    if (search) {
      const normalizedSearch = normalizeSearchText(search);
      if (normalizedSearch) {
        // Get user IDs through the existing User text index.
        const matchingUsers = await User.find({
          $text: { $search: toLiteralTextSearch(normalizedSearch) },
        })
          .select("_id")
          .lean();

        const userIds = matchingUsers.map((u) => u._id);

        searchQuery = {
          userId: { $in: userIds },
        };
      }
    }

    // Combine filters
    const query = { ...filterQuery, ...searchQuery };

    // Get donations from DonationTransaction (completed gifts)
    const [transactions, totalTransactions] = await Promise.all([
      DonationTransaction.find(query)
        .populate("userId", "firstName lastName email")
        .sort({ giftDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DonationTransaction.countDocuments(query),
    ]);

    // Map transactions to unified format
    const donations = transactions.map((txn) => {
      const user = txn.userId as unknown as {
        firstName?: string;
        lastName?: string;
        email?: string;
      };

      return {
        _id: txn._id.toString(),
        giftDate: txn.giftDate,
        user: {
          firstName: user.firstName || "Unknown",
          lastName: user.lastName || "User",
          email: user.email || "N/A",
        },
        type: txn.type,
        status: txn.status,
        amount: txn.amount,
      };
    });

    return {
      donations,
      pagination: {
        page,
        limit,
        total: totalTransactions,
        totalPages: Math.ceil(totalTransactions / limit),
      },
    };
  }

  /**
   * Get donation stats for admin
   * ADMIN ONLY
   */
  async getAdminDonationStats(): Promise<{
    totalRevenue: number;
    totalDonations: number;
    uniqueDonors: number;
    activeRecurringRevenue: number;
    last30Days: {
      donations: number;
      revenue: number;
    };
  }> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [allStats, last30Stats, uniqueDonors] = await Promise.all([
      // All time stats
      DonationTransaction.aggregate([
        {
          $match: {
            status: "completed",
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$amount" },
            totalDonations: { $sum: 1 },
          },
        },
      ]),
      // Last 30 days stats
      DonationTransaction.aggregate([
        {
          $match: {
            status: "completed",
            giftDate: { $gte: thirtyDaysAgo },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$amount" },
            donations: { $sum: 1 },
          },
        },
      ]),
      // Unique donors count
      DonationTransaction.distinct("userId", { status: "completed" }),
    ]);

    // Calculate active recurring monthly revenue
    const activeDonations = await Donation.find({
      type: "recurring",
      status: "active",
    }).lean();

    const frequencyMultipliers: Record<string, number> = {
      weekly: 52 / 12, // ~4.33 weeks per month
      biweekly: 26 / 12, // ~2.17 bi-weeks per month
      monthly: 1,
      quarterly: 1 / 3, // ~0.33 months per quarter
      annually: 1 / 12, // ~0.08 months per year
    };

    const activeRecurringRevenue = activeDonations.reduce((sum, donation) => {
      const frequency = donation.frequency || "monthly";
      const multiplier = frequencyMultipliers[frequency] || 1;
      return sum + donation.amount * multiplier;
    }, 0);

    return {
      totalRevenue: allStats[0]?.totalRevenue || 0,
      totalDonations: allStats[0]?.totalDonations || 0,
      uniqueDonors: uniqueDonors.length,
      activeRecurringRevenue, // in cents - monthly equivalent
      last30Days: {
        donations: last30Stats[0]?.donations || 0,
        revenue: last30Stats[0]?.revenue || 0,
      },
    };
  }
}

export default new DonationService();
