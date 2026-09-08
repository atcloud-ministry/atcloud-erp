import { Request, Response } from "express";
import { User } from "../../models";
import { hasPermission, PERMISSIONS } from "../../utils/roleUtils";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { buildUserDemographics } from "../../contracts/userAnalyticsContracts";

export default class UserAnalyticsController {
  static async getUserAnalytics(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      if (!hasPermission(req.user.role, PERMISSIONS.VIEW_SYSTEM_ANALYTICS)) {
        res.status(403).json({
          success: false,
          message: "Insufficient permissions to view user analytics.",
        });
        return;
      }

      // User statistics by role
      const usersByRole = await User.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: "$role", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);

      // User statistics by @Cloud co-worker status
      const usersByAtCloudStatus = await User.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: "$isAtCloudLeader", count: { $sum: 1 } } },
      ]);

      // User statistics by church
      const usersByChurch = await User.aggregate([
        {
          $match: {
            isActive: true,
            weeklyChurch: { $type: "string" },
            $expr: { $ne: [{ $trim: { input: "$weeklyChurch" } }, ""] },
          },
        },
        { $group: { _id: "$weeklyChurch", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]);

      // User registration trends (last 12 months)
      const registrationTrends = await User.aggregate([
        {
          $match: {
            createdAt: {
              $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
            },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]);

      // Compatibility distribution used by existing analytics consumers.
      const usersByOccupation = await User.aggregate([
        {
          $match: {
            isActive: true,
            occupation: { $type: "string" },
            $expr: { $ne: [{ $trim: { input: "$occupation" } }, ""] },
          },
        },
        { $group: { _id: "$occupation", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]);

      // These rows never leave the server. They preserve the exact all-account
      // population previously loaded by the People tab without exposing users.
      const demographicRows = await User.aggregate([
        {
          $project: {
            _id: 0,
            role: 1,
            isActive: 1,
            isAtCloudLeader: 1,
            weeklyChurch: 1,
            churchAddress: 1,
            occupation: 1,
          },
        },
      ]);
      const demographics = buildUserDemographics(demographicRows);
      const activeUsers = demographicRows.filter(
        (row: { isActive?: unknown }) => row.isActive === true,
      ).length;

      res.status(200).json({
        success: true,
        data: {
          usersByRole,
          usersByAtCloudStatus,
          usersByChurch,
          registrationTrends,
          usersByOccupation,
          totalUsers: demographicRows.length,
          activeUsers,
          demographics,
        },
      });
    } catch (error: unknown) {
      console.error("Get user analytics error:", error);
      try {
        CorrelatedLogger.fromRequest(req, "AnalyticsController").error(
          "Get user analytics error",
          error as Error,
          "getUserAnalytics",
          { query: req.query }
        );
      } catch {}
      res.status(500).json({
        success: false,
        message: "Failed to retrieve user analytics.",
      });
    }
  }
}
