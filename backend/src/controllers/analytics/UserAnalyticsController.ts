import { Request, Response } from "express";
import { User } from "../../models";
import { hasPermission, PERMISSIONS } from "../../utils/roleUtils";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { buildUserDemographics } from "../../contracts/userAnalyticsContracts";
import RegistrationProfileKpiAnalyticsService from "../../services/RegistrationProfileKpiAnalyticsService";

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

      // These rows never leave the server. They preserve the existing
      // authorization/church population without exposing individual users.
      const demographicRows = await User.aggregate([
        {
          $project: {
            _id: 0,
            role: 1,
            isActive: 1,
            isAtCloudLeader: 1,
            weeklyChurch: 1,
            churchAddress: 1,
          },
        },
      ]);
      const demographics = buildUserDemographics(demographicRows);
      const activeUsers = demographicRows.filter(
        (row: { isActive?: unknown }) => row.isActive === true,
      ).length;
      const registrationProfileKpis =
        await RegistrationProfileKpiAnalyticsService.getRegistrationProfileKpis();
      const usersByOccupation =
        registrationProfileKpis.occupations.buckets.map(
          ({ occupation, count }) => ({ _id: occupation, count }),
        );
      const reportableOccupationCount = usersByOccupation.reduce(
        (total, bucket) => total + bucket.count,
        0,
      );
      const privacySafeDemographics = {
        ...demographics,
        occupationAnalytics: {
          occupationStats: Object.fromEntries(
            usersByOccupation.map(({ _id, count }) => [_id, count]),
          ),
          usersWithOccupation: reportableOccupationCount,
          // Compatibility fields remain numeric for older frontends, but do
          // not disclose exact missing/suppressed populations or a derived rate.
          usersWithoutOccupation: 0,
          totalOccupationTypes: usersByOccupation.length,
          topOccupations: usersByOccupation.slice(0, 5).map(
            ({ _id, count }) => ({ occupation: _id, count }),
          ),
          occupationCompletionRate: 0,
        },
      };
      // The frontend and backend are deployed as independent Render services.
      // Opt-in keeps the response compatible regardless of which service is
      // deployed first; the new frontend tolerates an old backend omitting it.
      const includeRegistrationProfileKpis =
        req.query.includeRegistrationProfileKpis === "1";
      res.setHeader("Cache-Control", "no-store");
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
          demographics: privacySafeDemographics,
          ...(includeRegistrationProfileKpis
            ? { registrationProfileKpis }
            : {}),
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
