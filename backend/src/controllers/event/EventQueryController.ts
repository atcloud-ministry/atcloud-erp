/**
 * EventQueryController
 *
 * Handles read-only event query operations (getAllEvents, getEventById).
 * Extracted from eventController.ts for better modularity.
 */

import { Request, Response } from "express";
import mongoose from "mongoose";
import { Event } from "../../models";
import { ResponseBuilderService } from "../../services/ResponseBuilderService";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import { CachePatterns } from "../../services/infrastructure/CacheService";
import { EventController } from "../eventController";

const EVENT_LIST_PROJECTION = [
  "title",
  "type",
  "date",
  "endDate",
  "time",
  "endTime",
  "timeZone",
  "location",
  "organizer",
  "organizerDetails",
  "hostedBy",
  "format",
  "roles",
  "status",
  "createdBy",
  "createdAt",
  "publish",
  "publishedAt",
  "publicSlug",
  "youtubeUrl",
  "programLabels",
].join(" ");
const EVENT_LIST_SORT_FIELDS = new Set([
  "date",
  "title",
  "organizer",
  "type",
]);

function applyQueryMethod(
  value: unknown,
  method: string,
  ...args: unknown[]
): unknown {
  if (!value || typeof value !== "object") return value;
  const candidate = (value as Record<string, unknown>)[method];
  return typeof candidate === "function"
    ? (candidate as (...methodArgs: unknown[]) => unknown).apply(value, args)
    : value;
}

export class EventQueryController {
  private static async queryEventListPage(
    filter: Record<string, unknown>,
    sort: Record<string, 1 | -1>,
    skip: number,
    limit: number,
    useCaseInsensitiveCollation: boolean,
  ): Promise<Array<{ _id: mongoose.Types.ObjectId }>> {
    let query: unknown = Event.find(filter);
    query = applyQueryMethod(query, "select", EVENT_LIST_PROJECTION);
    query = applyQueryMethod(
      query,
      "populate",
      "createdBy",
      "username firstName lastName avatar role roleInAtCloud",
    );
    if (useCaseInsensitiveCollation) {
      query = applyQueryMethod(query, "collation", {
        locale: "en",
        strength: 2,
      });
    }
    query = applyQueryMethod(query, "sort", sort);
    query = applyQueryMethod(query, "skip", skip);
    query = applyQueryMethod(query, "limit", limit);
    query = applyQueryMethod(query, "lean");

    return ((await query) || []) as Array<{
      _id: mongoose.Types.ObjectId;
    }>;
  }

  // Get all events with filtering and pagination
  static async getAllEvents(req: Request, res: Response): Promise<void> {
    try {
      const {
        page = 1,
        limit = 10,
        status, // single status (legacy)
        statuses, // new: comma-separated list of statuses
        type,
        programId,
        search,
        sortBy = "date",
        sortOrder = "asc",
        minParticipants,
        maxParticipants,
        category,
        startDate,
        endDate,
        publish,
      } = req.query;

      const requestedPage = Number.parseInt(String(page), 10);
      const requestedLimit = Number.parseInt(String(limit), 10);
      const pageNumber = requestedPage > 0 ? requestedPage : 1;
      const limitNumber =
        requestedLimit > 0 ? Math.min(requestedLimit, 100) : 10;
      const requestedSortField = String(sortBy);
      const primarySortField = EVENT_LIST_SORT_FIELDS.has(requestedSortField)
        ? requestedSortField
        : "date";
      const primaryDirection = sortOrder === "desc" ? -1 : 1;

      // Create cache key based on query parameters
      const multiStatuses =
        typeof statuses === "string" && statuses.trim().length > 0
          ? statuses
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;

      const baseFilterDescriptor = {
        status,
        statuses: multiStatuses,
        type,
        programId,
        search,
        sortBy: primarySortField,
        sortOrder: primaryDirection === -1 ? "desc" : "asc",
        minParticipants,
        maxParticipants,
        category,
        startDate,
        endDate,
        publish,
      };
      const pageCacheKey = `events-list:v2:${JSON.stringify({
        ...baseFilterDescriptor,
        page: pageNumber,
        limit: limitNumber,
      })}`;

      const result = await CachePatterns.getEventListing(
        pageCacheKey,
        async () => {
          const skip = (pageNumber - 1) * limitNumber;

          // Build filter object
          const filter: Record<string, unknown> & {
            date?: { $gte?: string; $lte?: string };
            totalSlots?: { $gte?: number; $lte?: number };
          } = {};

          // Publish filter (exact boolean match)
          if (publish === "true") {
            filter.publish = true;
          } else if (publish === "false") {
            filter.publish = { $ne: true };
          }

          // For non-status filters, apply them directly
          if (type) {
            filter.type = type;
          }

          if (programId && typeof programId === "string") {
            // Query programLabels array: find events where programLabels contains this programId
            filter.programLabels = programId;
          }

          if (category) {
            filter.category = category;
          }

          // Date range filtering
          if (startDate || endDate) {
            filter.date = {};
            if (startDate) {
              filter.date.$gte = String(startDate);
            }
            if (endDate) {
              filter.date.$lte = String(endDate);
            }
          }

          // Participant capacity filtering
          if (minParticipants) {
            filter.totalSlots = { $gte: parseInt(minParticipants as string) };
          }
          if (maxParticipants) {
            if (filter.totalSlots) {
              filter.totalSlots.$lte = parseInt(maxParticipants as string);
            } else {
              filter.totalSlots = { $lte: parseInt(maxParticipants as string) };
            }
          }

          // Text search
          if (search) {
            filter.$text = { $search: search as string };
          }

          // Build sort object with deterministic tie-breakers.
          // Primary: user-selected field (date | title | organizer | type)
          // Secondary rules:
          //   - date: tie-break by time (same direction)
          //   - title: tie-break by date asc, then time asc for stability
          //   - organizer: tie-break by title asc, then date asc, then time asc
          //   - type: tie-break by title asc, then date asc, then time asc
          const sort: Record<string, 1 | -1> = {};
          sort[primarySortField] = primaryDirection;
          if (primarySortField === "date") {
            sort["time"] = primaryDirection; // same-direction to keep chronological grouping
          } else if (primarySortField === "title") {
            // Deterministic stable ordering when titles equal (rare) across pages
            sort["date"] = 1;
            sort["time"] = 1;
          } else if (primarySortField === "organizer") {
            // Group by organizer (case-insensitive via collation below) then consistent ordering
            sort["title"] = 1;
            sort["date"] = 1;
            sort["time"] = 1;
          } else if (primarySortField === "type") {
            // Group by type, then ensure stable grouping across pages
            sort["title"] = 1;
            sort["date"] = 1;
            sort["time"] = 1;
          }
          sort["_id"] = 1;

          if (multiStatuses) {
            filter.status = { $in: multiStatuses } as { $in: string[] };
          } else if (status) {
            filter.status = status;
          }

          const useCaseInsensitiveCollation =
            primarySortField === "title" ||
            primarySortField === "organizer" ||
            primarySortField === "type";
          const [events, totalEvents] = await Promise.all([
            EventQueryController.queryEventListPage(
              filter,
              sort,
              skip,
              limitNumber,
              useCaseInsensitiveCollation,
            ),
            Event.countDocuments(filter),
          ]);
          const totalPages = Math.ceil(totalEvents / limitNumber);

          const eventsWithRegistrations =
            await ResponseBuilderService.buildEventsWithRegistrations(
              events,
            );

          return {
            events: eventsWithRegistrations,
            pagination: {
              currentPage: pageNumber,
              totalPages,
              totalEvents,
              hasNext: pageNumber < totalPages,
              hasPrev: pageNumber > 1,
            },
          };
        },
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      console.error("Get events error:", error);
      CorrelatedLogger.fromRequest(req, "EventController").error(
        "getAllEvents failed",
        error as Error,
      );
      res.status(500).json({
        success: false,
        message: "Failed to retrieve events.",
      });
    }
  }

  // Get single event by ID with registration data
  static async getEventById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid event ID.",
        });
        return;
      }

      const viewerId = req.user
        ? EventController.toIdString(req.user._id)
        : undefined;
      const viewerRole = (req.user as { role?: string } | undefined)?.role;
      const eventWithRegistrations =
        await ResponseBuilderService.buildEventWithRegistrations(
          id,
          viewerId,
          viewerRole,
        );

      if (!eventWithRegistrations) {
        res.status(404).json({
          success: false,
          message: "Event not found.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: { event: eventWithRegistrations },
      });
    } catch (error: unknown) {
      console.error("Get event error:", error);
      CorrelatedLogger.fromRequest(req, "EventController").error(
        "getEventById failed",
        error as Error,
        undefined,
        { eventId: req.params?.id },
      );
      res.status(500).json({
        success: false,
        message: "Failed to retrieve event.",
      });
    }
  }
}
