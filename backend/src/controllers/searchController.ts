import { Request, Response } from "express";
import { User, Event } from "../models";
import { CachePatterns } from "../services/infrastructure/CacheService";
import { createLogger } from "../services/LoggerService";
import {
  escapeRegex,
  normalizeSearchText,
  toLiteralTextSearch,
} from "../utils/search";
import {
  ADMIN_USER_PROJECTION,
  COMMUNITY_MEMBER_PROJECTION,
  serializeAdminUser,
  serializeCommunityMember,
} from "../serializers/userReadSerializers";

const log = createLogger("SearchController");
const EVENT_SEARCH_FIELDS = [
  "title",
  "description",
  "location",
  "organizer",
  "purpose",
  "type",
  "format",
  "date",
  "endDate",
  "time",
  "endTime",
  "status",
  "flyerUrl",
  "publicSlug",
  "createdAt",
].join(" ");

function getPagination(req: Request, defaultLimit: number) {
  const requestedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
  const requestedLimit = Number.parseInt(
    String(req.query.limit ?? defaultLimit),
    10,
  );
  const page = requestedPage > 0 ? requestedPage : 1;
  const limit =
    requestedLimit > 0 ? Math.min(requestedLimit, 100) : defaultLimit;
  return { page, limit, skip: (page - 1) * limit };
}

export class SearchController {
  // Search users
  static async searchUsers(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const { q: query } = req.query;
      const { page, limit, skip } = getPagination(req, 20);

      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) {
        res.status(400).json({
          success: false,
          message: "Search query is required.",
        });
        return;
      }

      const searchCriteria: Record<string, unknown> = {
        isActive: true,
        $text: { $search: toLiteralTextSearch(normalizedQuery)! },
      };

      // Add filters
      if (req.query.role) {
        searchCriteria.role = req.query.role;
      }
      if (req.query.isAtCloudLeader !== undefined) {
        searchCriteria.isAtCloudLeader = req.query.isAtCloudLeader === "true";
      }
      if (req.query.weeklyChurch) {
        const weeklyChurch = normalizeSearchText(req.query.weeklyChurch);
        searchCriteria.weeklyChurch = {
          $regex: escapeRegex(weeklyChurch),
          $options: "i",
        };
      }

      const selectFields = ADMIN_USER_PROJECTION;

      // Create cache key based on search parameters
      const cacheKey = `search-users-${JSON.stringify({
        query: normalizedQuery,
        page,
        limit,
        role: req.query.role,
        isAtCloudLeader: req.query.isAtCloudLeader,
        weeklyChurch: req.query.weeklyChurch,
      })}`;

      // Get cached search results
      const searchResult = await CachePatterns.getSearchResults(
        cacheKey,
        async () => {
          const [users, totalUsers] = await Promise.all([
            User.find(searchCriteria)
              .select(selectFields)
              .sort({ firstName: 1, lastName: 1, _id: 1 })
              .limit(limit)
              .skip(skip)
              .lean(),
            User.countDocuments(searchCriteria),
          ]);

          // Transform _id to id for frontend compatibility (lean() bypasses toJSON transform)
          const transformedUsers = users.map(serializeAdminUser);

          const totalPages = Math.ceil(totalUsers / limit);

          return {
            users: transformedUsers,
            pagination: {
              currentPage: page,
              totalPages,
              totalUsers,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
          };
        }
      );

      res.status(200).json({
        success: true,
        data: searchResult,
      });
    } catch (error) {
      console.error("Search users error:", error);
      // Structured log alongside existing console for tests
      try {
        log.error(
          "Search users failed",
          error as Error | undefined,
          undefined,
          {
            query: req.query?.q,
            page: req.query?.page,
            limit: req.query?.limit,
            role: req.query?.role,
            isAtCloudLeader: req.query?.isAtCloudLeader,
            weeklyChurch: req.query?.weeklyChurch,
            userId: (req as unknown as { user?: { id?: string; _id?: string } })
              .user?.id,
          }
        );
      } catch {
        // no-op: never block response on logging
      }
      res.status(500).json({
        success: false,
        message: "Failed to search users.",
      });
    }
  }

  // Search events
  static async searchEvents(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const { q: query } = req.query;
      const { page, limit, skip } = getPagination(req, 20);

      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) {
        res.status(400).json({
          success: false,
          message: "Search query is required.",
        });
        return;
      }

      // Build search criteria
      const searchRegex = {
        $regex: escapeRegex(normalizedQuery),
        $options: "i",
      };
      const searchCriteria: Record<string, unknown> = {
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { location: searchRegex },
          { organizer: searchRegex },
          { purpose: searchRegex },
          { type: searchRegex },
        ],
      };

      // Add filters
      if (req.query.type) {
        searchCriteria.type = req.query.type;
      }
      if (req.query.format) {
        searchCriteria.format = req.query.format;
      }
      if (req.query.status) {
        const today = new Date().toISOString().slice(0, 10);
        if (req.query.status === "upcoming") {
          searchCriteria.date = { $gte: today };
        } else if (req.query.status === "past") {
          searchCriteria.date = { $lt: today };
        }
      }
      if (req.query.dateFrom) {
        const dateFilter: Record<string, unknown> =
          typeof searchCriteria.date === "object" && searchCriteria.date != null
            ? (searchCriteria.date as Record<string, unknown>)
            : {};
        dateFilter.$gte = String(req.query.dateFrom).slice(0, 10);
        searchCriteria.date = dateFilter;
      }
      if (req.query.dateTo) {
        const dateFilter: Record<string, unknown> =
          typeof searchCriteria.date === "object" && searchCriteria.date != null
            ? (searchCriteria.date as Record<string, unknown>)
            : {};
        dateFilter.$lte = String(req.query.dateTo).slice(0, 10);
        searchCriteria.date = dateFilter;
      }

      // Create cache key based on search parameters
      const cacheKey = `search-events-${JSON.stringify({
        query: normalizedQuery,
        page,
        limit,
        type: req.query.type,
        format: req.query.format,
        status: req.query.status,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
      })}`;

      // Get cached search results
      const searchResult = await CachePatterns.getSearchResults(
        cacheKey,
        async () => {
          const [events, totalEvents] = await Promise.all([
            Event.find(searchCriteria)
              .select(EVENT_SEARCH_FIELDS)
              .sort({ date: -1, time: -1, _id: -1 })
              .limit(limit)
              .skip(skip)
              .lean(),
            Event.countDocuments(searchCriteria),
          ]);

          // Transform _id to id for frontend compatibility (lean() bypasses toJSON transform)
          const transformedEvents = events.map((event) => {
            const { _id, ...rest } = event as Record<string, unknown> & {
              _id: unknown;
            };
            return {
              ...rest,
              id: _id?.toString(),
            };
          });

          const totalPages = Math.ceil(totalEvents / limit);

          return {
            events: transformedEvents,
            pagination: {
              currentPage: page,
              totalPages,
              totalEvents,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
          };
        }
      );

      res.status(200).json({
        success: true,
        data: searchResult,
      });
    } catch (error) {
      console.error("Search events error:", error);
      // Structured log alongside existing console for tests
      try {
        log.error(
          "Search events failed",
          error as Error | undefined,
          undefined,
          {
            query: req.query?.q,
            page: req.query?.page,
            limit: req.query?.limit,
            type: req.query?.type,
            format: req.query?.format,
            status: req.query?.status,
            dateFrom: req.query?.dateFrom,
            dateTo: req.query?.dateTo,
            userId: (req as unknown as { user?: { id?: string; _id?: string } })
              .user?.id,
          }
        );
      } catch {
        // no-op
      }
      res.status(500).json({
        success: false,
        message: "Failed to search events.",
      });
    }
  }

  // Global search (users and events)
  static async globalSearch(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      const { q: query } = req.query;
      const { limit } = getPagination(req, 10);

      const normalizedQuery = normalizeSearchText(query);
      if (!normalizedQuery) {
        res.status(400).json({
          success: false,
          message: "Search query is required.",
        });
        return;
      }

      const visibleMatch = {
        $regex: escapeRegex(normalizedQuery),
        $options: "i",
      };
      const userSearchCriteria: Record<string, unknown> = {
        isActive: true,
        isVerified: true,
        $or: [
          { username: visibleMatch },
          { firstName: visibleMatch },
          { lastName: visibleMatch },
          { roleInAtCloud: visibleMatch },
        ],
      };

      // Search events
      const eventSearchRegex = {
        $regex: escapeRegex(normalizedQuery),
        $options: "i",
      };
      const eventSearchCriteria = {
        $or: [
          { title: eventSearchRegex },
          { description: eventSearchRegex },
          { location: eventSearchRegex },
          { organizer: eventSearchRegex },
          { type: eventSearchRegex },
        ],
      };

      const userSelectFields = COMMUNITY_MEMBER_PROJECTION;

      const [users, events] = await Promise.all([
        User.find(userSearchCriteria)
          .select(userSelectFields)
          .sort({ firstName: 1, lastName: 1, _id: 1 })
          .limit(limit)
          .lean(),
        Event.find(eventSearchCriteria)
          .select(EVENT_SEARCH_FIELDS)
          .sort({ date: -1, time: -1, _id: -1 })
          .limit(limit)
          .lean(),
      ]);

      // Transform _id to id for frontend compatibility (lean() bypasses toJSON transform)
      const transformedUsers = users.map(serializeCommunityMember);

      const transformedEvents = events.map((event) => {
        const { _id, ...rest } = event as Record<string, unknown> & {
          _id: unknown;
        };
        return {
          ...rest,
          id: _id?.toString(),
        };
      });

      res.status(200).json({
        success: true,
        data: {
          users: transformedUsers,
          events: transformedEvents,
          totalResults: transformedUsers.length + transformedEvents.length,
        },
      });
    } catch (error) {
      console.error("Global search error:", error);
      // Structured log alongside existing console for tests
      try {
        log.error(
          "Global search failed",
          error as Error | undefined,
          undefined,
          {
            query: req.query?.q,
            limit: req.query?.limit,
            userId: (req as unknown as { user?: { id?: string; _id?: string } })
              .user?.id,
          }
        );
      } catch {
        // no-op
      }
      res.status(500).json({
        success: false,
        message: "Failed to perform global search.",
      });
    }
  }
}
