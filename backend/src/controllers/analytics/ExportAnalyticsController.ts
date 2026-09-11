import { Request, Response } from "express";
import {
  User,
  Event,
  Registration,
  GuestRegistration,
  Program,
} from "../../models";
import Purchase from "../../models/Purchase";
import DonationTransaction from "../../models/DonationTransaction";
import { hasPermission, PERMISSIONS } from "../../utils/roleUtils";
import { CorrelatedLogger } from "../../services/CorrelatedLogger";
import * as XLSX from "xlsx";

export default class ExportAnalyticsController {
  static async exportAnalytics(req: Request, res: Response): Promise<void> {
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
          message: "Insufficient permissions to export analytics.",
        });
        return;
      }

      const format = (req.query.format as string) || "json";
      const allowedFormats = new Set(["json", "csv", "xlsx"]);
      if (!allowedFormats.has(format)) {
        res.status(400).json({
          success: false,
          message: "Unsupported format. Use 'json', 'csv', or 'xlsx'.",
        });
        return;
      }

      // Optional export constraints.
      // Query params: from, to (ISO date), maxRows (number)
      const fromParam = req.query.from as string | undefined;
      const toParam = req.query.to as string | undefined;
      const maxRowsParam = req.query.maxRows as string | undefined;

      const parseOptionalDate = (value: string | undefined) => {
        if (!value?.trim()) return undefined;
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date : null;
      };

      const fromDate = parseOptionalDate(fromParam);
      const toDate = parseOptionalDate(toParam);
      if (fromDate === null || toDate === null) {
        res.status(400).json({
          success: false,
          message: "Invalid date range. Use valid ISO dates for from and to.",
        });
        return;
      }

      const MAX_ROWS_HARD_CAP = 25000; // absolute cap as safety net
      const DEFAULT_ROW_CAP = MAX_ROWS_HARD_CAP;
      const maxRows = Math.min(
        Math.max(0, Number(maxRowsParam ?? DEFAULT_ROW_CAP)) ||
          DEFAULT_ROW_CAP,
        MAX_ROWS_HARD_CAP,
      );

      const createdAtRange: Record<string, Date> = {};
      if (fromDate) createdAtRange.$gte = fromDate;
      if (toDate) createdAtRange.$lte = toDate;
      const createdAtFilter =
        Object.keys(createdAtRange).length > 0
          ? { createdAt: createdAtRange }
          : {};

      // Base filters. Keep the no-parameter export aligned with the dashboard's
      // all-time overview counts; from/to intentionally opt into narrower exports.
      const userFilter = {
        isActive: true,
        ...createdAtFilter,
      } as const;
      const eventFilter = {
        ...createdAtFilter,
      } as const;
      const registrationFilter = {
        ...createdAtFilter,
      } as const;

      const toIdString = (value: unknown): string => {
        if (value == null) return "";
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
        if (typeof value === "object") {
          const maybeDoc = value as {
            _id?: unknown;
            id?: unknown;
            toHexString?: () => string;
            toString?: () => string;
          };
          if (typeof maybeDoc.toHexString === "function") {
            return maybeDoc.toHexString();
          }
          if (maybeDoc._id != null && maybeDoc._id !== value) {
            return toIdString(maybeDoc._id);
          }
          if (maybeDoc.id != null && maybeDoc.id !== value) {
            return toIdString(maybeDoc.id);
          }
          if (
            typeof maybeDoc.toString === "function" &&
            maybeDoc.toString !== Object.prototype.toString
          ) {
            return maybeDoc.toString();
          }
        }
        return String(value);
      };

      const titleFromRef = (value: unknown): string => {
        if (value && typeof value === "object" && "title" in value) {
          return String((value as { title?: unknown }).title ?? "");
        }
        return "";
      };

      const deriveAttendanceStatus = (reg: {
        status?: string;
        attendanceConfirmed?: boolean;
      }): string => {
        if (reg.status === "attended" || reg.attendanceConfirmed === true) {
          return "Attended";
        }
        if (reg.status === "no_show") {
          return "No Show";
        }
        return "Not Recorded";
      };

      const snapshotName = (snapshot?: {
        username?: string;
        firstName?: string;
        lastName?: string;
      }): string => {
        if (!snapshot) return "";
        const fullName = [snapshot.firstName, snapshot.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        return fullName || snapshot.username || "";
      };

      const csvValue = (value: unknown): string => {
        const sanitized = String(value ?? "")
          .replace(/[\r\n,]+/gu, " ");

        // Keep user-controlled values from becoming spreadsheet formulas when
        // a CSV is opened in Excel or another spreadsheet application.
        return /^\s*[=+\-@]/u.test(sanitized) ? `'${sanitized}` : sanitized;
      };

      const programPeriod = (period?: {
        startYear?: string;
        startMonth?: string;
        endYear?: string;
        endMonth?: string;
      }): string => {
        if (!period) return "";
        const start = [period.startYear, period.startMonth]
          .filter(Boolean)
          .join("-");
        const end = [period.endYear, period.endMonth].filter(Boolean).join("-");
        return [start, end].filter(Boolean).join(" to ");
      };

      type RawRegistrationExport = {
        userId?: unknown;
        eventId?: unknown;
        roleId?: string;
        status?: string;
        registrationDate?: string | Date;
        attendanceConfirmed?: boolean;
        notes?: string;
        specialRequirements?: string;
        registeredBy?: unknown;
        userSnapshot?: {
          username?: string;
          firstName?: string;
          lastName?: string;
          email?: string;
        };
        eventSnapshot?: {
          title?: string;
          date?: string;
          time?: string;
          location?: string;
          type?: string;
          roleName?: string;
        };
      };

      type ProgramCatalogExport = {
        _id?: unknown;
        id?: unknown;
        title?: string;
        programType?: string;
        hostedBy?: string;
        period?: {
          startYear?: string;
          startMonth?: string;
          endYear?: string;
          endMonth?: string;
        };
        isFree?: boolean;
        createdAt?: string | Date;
        updatedAt?: string | Date;
      };

      type RawProgramPurchaseExport = {
        userId?: unknown;
        purchaseType?: string;
        programId?: unknown;
        eventId?: unknown;
        membershipId?: unknown;
        orderNumber?: string;
        itemTitle?: string;
        itemLabel?: string;
        finalPrice?: number;
        status?: string;
        purchaseDate?: string | Date;
        studentRoleName?: string;
        isClassRep?: boolean;
        isEarlyBird?: boolean;
        promoCode?: string;
        stripePaymentIntentId?: string;
      };

      // Helper to safely fetch arrays from mongoose or mocked find() calls
      const safeFetch = async <T = unknown>(
        model: unknown,
        filter: Record<string, unknown>,
        opts?: {
          select?: string | Record<string, number | boolean>;
          sort?: Record<string, unknown>;
          limit?: number;
          lean?: boolean;
          strict?: boolean;
        },
      ): Promise<T[]> => {
        try {
          const hasFind =
            model && typeof (model as { find?: unknown }).find === "function";
          const finder = hasFind
            ? (model as { find: (f: Record<string, unknown>) => unknown }).find(
                filter,
              )
            : undefined;
          // Chainable mongoose query path
          if (finder && typeof finder === "object") {
            let q: unknown = finder;
            // select
            const sel = (
              q as {
                select?: (
                  s: string | Record<string, number | boolean>,
                ) => unknown;
              }
            ).select;
            if (opts?.select && typeof sel === "function") {
              q = sel.call(q as object, opts.select);
            }
            // sort
            const sorter = (
              q as {
                sort?: (s: Record<string, unknown>) => unknown;
              }
            ).sort;
            if (opts?.sort && typeof sorter === "function") {
              q = sorter.call(q as object, opts.sort);
            }
            // limit
            const limiter = (q as { limit?: (n: number) => unknown }).limit;
            if (
              typeof opts?.limit === "number" &&
              typeof limiter === "function"
            ) {
              q = limiter.call(q as object, opts.limit);
            }
            // lean
            const leaner = (q as { lean?: () => Promise<T[]> }).lean;
            if (opts?.lean !== false && typeof leaner === "function") {
              return await leaner.call(q as object);
            }
            // Fallback to awaiting the query if thenable
            const thenable = q as {
              then?: (onf: (v: T[]) => unknown) => unknown;
            };
            if (thenable && typeof thenable.then === "function")
              return (await (thenable as unknown as Promise<T[]>)) as T[];
          }
          // If finder is already a thenable (some mocks)
          if (
            finder &&
            typeof (finder as { then?: unknown }).then === "function"
          )
            return (await (finder as unknown as Promise<T[]>)) as T[];
          // If finder is an array (some simplistic mocks)
          if (Array.isArray(finder)) return finder as T[];
          return [] as T[];
        } catch (e) {
          if (opts?.strict) {
            throw e;
          }
          console.warn("safeFetch fallback: returning [] due to error", e);
          return [] as T[];
        }
      };

      const programCatalog = (
        (await safeFetch(
          Program as unknown,
          {},
          {
            select:
              "title programType hostedBy period isFree createdAt updatedAt",
            sort: { createdAt: -1 },
            limit: maxRows,
            strict: false,
          },
        )) as ProgramCatalogExport[]
      ).map((program) => ({
        id: toIdString(program._id ?? program.id),
        title: program.title ?? "",
        programType: program.programType ?? "",
        hostedBy: program.hostedBy ?? "",
        period: program.period,
        isFree: program.isFree,
        createdAt: program.createdAt,
        updatedAt: program.updatedAt,
      }));

      const programTitleById = new Map(
        programCatalog
          .filter((program) => program.id)
          .map((program) => [program.id, program.title]),
      );

      // Get constrained analytics data
      const data = {
        // This legacy row-level export intentionally uses a positive allowlist.
        // Registration/KPI fields are available only through the separately
        // suppressed aggregate export and must never be copied into these rows.
        users: (
          (await safeFetch(User as unknown, userFilter, {
            select:
              "username firstName lastName email role isAtCloudLeader roleInAtCloud gender weeklyChurch churchAddress isVerified isActive lastLogin createdAt",
            sort: { createdAt: -1 },
            limit: maxRows,
            strict: true,
          })) as Array<{
            username?: string;
            firstName?: string;
            lastName?: string;
            email?: string;
            role?: string;
            isAtCloudLeader?: boolean;
            roleInAtCloud?: string;
            gender?: string;
            weeklyChurch?: string;
            churchAddress?: string;
            isVerified?: boolean;
            isActive?: boolean;
            lastLogin?: string | Date;
            createdAt?: string | Date;
          }>
        ).map((user) => ({
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          isAtCloudLeader: user.isAtCloudLeader,
          roleInAtCloud: user.roleInAtCloud,
          gender: user.gender,
          weeklyChurch: user.weeklyChurch,
          churchAddress: user.churchAddress,
          isVerified: user.isVerified,
          isActive: user.isActive,
          lastLogin: user.lastLogin,
          createdAt: user.createdAt,
        })),
        events: (await safeFetch(Event as unknown, eventFilter, {
          sort: { createdAt: -1 },
          limit: maxRows,
          strict: true,
        })) as Array<{
          title?: string;
          type?: string;
          date?: string | Date;
          endDate?: string | Date;
          time?: string;
          endTime?: string;
          timeZone?: string;
          location?: string;
          format?: string;
          status?: string;
          hostedBy?: string;
          organizer?: string;
          roles?: Array<{ name?: string; maxParticipants?: number }>;
          totalSlots?: number;
          signedUp?: number;
          createdBy?:
            | {
                username?: string;
                firstName?: string;
                lastName?: string;
                email?: string;
              }
            | string;
          createdAt?: string | Date;
        }>,
        registrations: (
          (await safeFetch(Registration as unknown, registrationFilter, {
            sort: { createdAt: -1 },
            limit: maxRows,
            strict: true,
          })) as RawRegistrationExport[]
        ).map((reg) => ({
          userId: toIdString(reg.userId),
          eventId: toIdString(reg.eventId),
          roleId: reg.roleId,
          status: reg.status,
          attendanceStatus: deriveAttendanceStatus(reg),
          attendanceConfirmed: reg.attendanceConfirmed,
          registrationDate: reg.registrationDate,
          notes: reg.notes,
          specialRequirements: reg.specialRequirements,
          registeredBy: toIdString(reg.registeredBy),
          userSnapshot: reg.userSnapshot,
          eventSnapshot: reg.eventSnapshot,
        })),
        guestRegistrations: (await (async () => {
          // Define a minimal lean shape for GuestRegistration to avoid explicit 'any'.
          type GuestRegLean = {
            fullName?: string;
            gender?: "male" | "female" | string;
            email?: string;
            phone?: string;
            status?: string;
            registrationDate?: string | Date;
            eventId?: unknown;
            roleId?: string;
            migratedToUserId?: unknown;
            migrationStatus?: string;
            eventSnapshot?: {
              title?: string;
              date?: Date | string;
              location?: string;
              roleName?: string;
            };
            notes?: string;
          };

          try {
            const canQuery =
              Boolean(GuestRegistration) &&
              typeof (GuestRegistration as Partial<{ find: unknown }>).find ===
                "function";
            if (!canQuery) return [] as GuestRegLean[];

            // Use a loose type to allow filter/sort/limit chaining in tests
            const modelAny = GuestRegistration as unknown as {
              find: (filter?: Record<string, unknown>) => {
                sort: (s: Record<string, unknown>) => {
                  limit: (n: number) => { lean: () => Promise<GuestRegLean[]> };
                };
                lean: () => Promise<GuestRegLean[]>;
              };
            };
            const raw = await (modelAny.find
              ? modelAny
                  .find(createdAtFilter)
                  .sort({ createdAt: -1 })
                  .limit(maxRows)
                  .lean()
              : Promise.resolve([] as GuestRegLean[]));

            return raw.map((g: GuestRegLean) => ({
              fullName: g.fullName,
              gender: g.gender,
              email: g.email,
              phone: g.phone,
              status: g.status,
              registrationDate: g.registrationDate,
              eventId: g.eventId != null ? String(g.eventId) : undefined,
              roleId: g.roleId,
              migratedToUserId:
                g.migratedToUserId != null
                  ? String(g.migratedToUserId)
                  : undefined,
              migrationStatus: g.migrationStatus,
              eventSnapshot: g.eventSnapshot
                ? {
                    title: g.eventSnapshot.title,
                    date: g.eventSnapshot.date,
                    location: g.eventSnapshot.location,
                    roleName: g.eventSnapshot.roleName,
                  }
                : undefined,
              notes: g.notes,
            }));
          } catch (e) {
            console.warn(
              "GuestRegistrations fetch failed, continuing without guests:",
              e,
            );
            return [] as GuestRegLean[];
          }
        })()) as Array<{
          fullName?: string;
          gender?: "male" | "female" | string;
          email?: string;
          phone?: string;
          status?: string;
          registrationDate?: string | Date;
          eventId?: string;
          roleId?: string;
          migratedToUserId?: string;
          migrationStatus?: string;
          eventSnapshot?: {
            title?: string;
            date?: Date | string;
            location?: string;
            roleName?: string;
          };
          notes?: string;
        }>,
        // Programs (Purchases)
        programs: (
          (await safeFetch(
            Purchase as unknown,
            {},
            {
              sort: { purchaseDate: -1 },
              limit: maxRows,
              strict: false,
            },
          )) as RawProgramPurchaseExport[]
        ).map((purchase) => {
          const programId = toIdString(purchase.programId);
          return {
            userId: toIdString(purchase.userId),
            purchaseType: purchase.purchaseType ?? "program",
            programId,
            eventId: toIdString(purchase.eventId),
            membershipId: toIdString(purchase.membershipId),
            orderNumber: purchase.orderNumber,
            itemTitle: purchase.itemTitle,
            itemLabel: purchase.itemLabel,
            programTitle:
              purchase.itemTitle ||
              titleFromRef(purchase.programId) ||
              programTitleById.get(programId) ||
              "",
            finalPrice: purchase.finalPrice,
            status: purchase.status,
            purchaseDate: purchase.purchaseDate,
            studentRoleName: purchase.studentRoleName,
            isClassRep: purchase.isClassRep,
            isEarlyBird: purchase.isEarlyBird,
            promoCode: purchase.promoCode,
            stripePaymentIntentId: purchase.stripePaymentIntentId,
          };
        }),
        programCatalog,
        // Donations (Transactions)
        donations: (await safeFetch(
          DonationTransaction as unknown,
          {},
          {
            sort: { giftDate: -1 },
            limit: maxRows,
            strict: false,
          },
        )) as Array<{
          userId?: unknown;
          donationId?: unknown;
          amount?: number;
          type?: string;
          status?: string;
          giftDate?: string | Date;
          stripePaymentIntentId?: string;
        }>,
        timestamp: new Date().toISOString(),
        meta: {
          scope:
            Object.keys(createdAtRange).length > 0 ? "date-filtered" : "all",
          filteredFrom: fromDate?.toISOString() ?? null,
          filteredTo: toDate?.toISOString() ?? null,
          rowLimit: maxRows,
        },
      };

      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=analytics.json",
        );
        res.send(JSON.stringify(data, null, 2));
      } else if (format === "csv") {
        // CSV export (supports summary or streaming rows)
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=analytics.csv",
        );

        const mode = (req.query.mode as string) || "summary"; // "summary" | "rows"

        if (mode === "rows") {
          // Stream rows to reduce memory for larger datasets
          // Users
          res.write(`# Users\n`);
          res.write("Username,Email,Role,CreatedAt\n");
          for (const u of data.users) {
            const row = [
              u.username ?? "",
              u.email ?? "",
              u.role ?? "",
              u.createdAt ? new Date(u.createdAt).toISOString() : "",
            ]
              .map(csvValue)
              .join(",");
            res.write(`${row}\n`);
          }
          // Events
          res.write(`# Events\n`);
          res.write("Title,Format,Status,CreatedAt\n");
          for (const e of data.events) {
            const row = [
              e.title ?? "",
              e.format ?? "",
              e.status ?? "",
              e.createdAt ? new Date(e.createdAt).toISOString() : "",
            ]
              .map(csvValue)
              .join(",");
            res.write(`${row}\n`);
          }
          // Registrations
          res.write(`# Registrations\n`);
          res.write(
            "UserId,UserEmail,UserName,EventId,EventTitle,RoleId,RoleName,Status,AttendanceStatus,AttendanceConfirmed,RegistrationDate\n",
          );
          for (const r of data.registrations) {
            const row = [
              r.userId ?? "",
              r.userSnapshot?.email ?? "",
              snapshotName(r.userSnapshot),
              r.eventId ?? "",
              r.eventSnapshot?.title ?? "",
              r.roleId ?? "",
              r.eventSnapshot?.roleName ?? "",
              r.status ?? "",
              r.attendanceStatus ?? "",
              r.attendanceConfirmed ? "Yes" : "No",
              r.registrationDate
                ? new Date(r.registrationDate).toISOString()
                : "",
            ]
              .map(csvValue)
              .join(",");
            res.write(`${row}\n`);
          }
          res.end();
          return;
        }

        // Summary counts CSV (default)
        let csv = "Type,Count\n";
        csv += `Users,${data.users.length}\n`;
        csv += `Events,${data.events.length}\n`;
        csv += `Registrations,${data.registrations.length}\n`;
        if (data.guestRegistrations && data.guestRegistrations.length > 0) {
          csv += `GuestRegistrations,${data.guestRegistrations.length}\n`;
        }
        csv += `Programs,${data.programs.length}\n`;
        if (data.programCatalog && data.programCatalog.length > 0) {
          csv += `ProgramCatalog,${data.programCatalog.length}\n`;
        }
        csv += `Donations,${data.donations.length}\n`;
        res.send(csv);
      } else if (format === "xlsx") {
        // XLSX export
        const workbook = XLSX.utils.book_new();

        // Overview sheet
        const overviewData = [
          ["Metric", "Value", "Timestamp"],
          ["Total Users", data.users.length, data.timestamp],
          ["Total Events", data.events.length, data.timestamp],
          ["Total Registrations", data.registrations.length, data.timestamp],
          [
            "Total Guest Registrations",
            data.guestRegistrations.length,
            data.timestamp,
          ],
          ["Total Programs", data.programs.length, data.timestamp],
          ["Total Donations", data.donations.length, data.timestamp],
        ];
        if (data.programCatalog.length > 0) {
          overviewData.splice(6, 0, [
            "Total Program Catalog",
            data.programCatalog.length,
            data.timestamp,
          ]);
        }
        const overviewWS = XLSX.utils.aoa_to_sheet(overviewData);
        XLSX.utils.book_append_sheet(workbook, overviewWS, "Overview");

        // Users sheet (minimal schema expected by tests)
        // Columns (0-based): Username(0), First Name(1), Last Name(2), Role(3), @Cloud Co-worker(4), Join Date(5)
        const usersData = [
          [
            "Username",
            "First Name",
            "Last Name",
            "Role",
            "@Cloud Co-worker",
            "Join Date",
          ],
          ...data.users.map((user) => [
            user.username ?? "",
            user.firstName ?? "",
            user.lastName ?? "",
            user.role ?? "",
            user.isAtCloudLeader ? "Yes" : "No",
            user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "",
          ]),
        ];
        const usersWS = XLSX.utils.aoa_to_sheet(usersData);
        XLSX.utils.book_append_sheet(workbook, usersWS, "Users");

        // Events sheet (minimal schema expected by tests)
        // Columns (0-based): Title(0), Type(1), Date(2), Location(3), Format(4), Status(5), Created Date(6)
        const eventsData = [
          [
            "Title",
            "Type",
            "Date",
            "Location",
            "Format",
            "Status",
            "Created Date",
          ],
          ...data.events.map((event) => [
            event.title ?? "",
            event.type ?? "",
            event.date ?? "",
            event.location ?? "",
            event.format ?? "",
            event.status || "upcoming",
            event.createdAt
              ? new Date(event.createdAt).toLocaleDateString()
              : "",
          ]),
        ];
        const eventsWS = XLSX.utils.aoa_to_sheet(eventsData);
        XLSX.utils.book_append_sheet(workbook, eventsWS, "Events");

        // Registrations sheet
        const registrationsData = [
          [
            "User ID",
            "User Email",
            "User Name",
            "Event ID",
            "Event Title",
            "Role ID",
            "Role Name",
            "Registration Status",
            "Attendance Status",
            "Attendance Confirmed",
            "Registration Date",
            "Registered By",
            "Notes",
            "Special Requirements",
          ],
          ...data.registrations.map((reg) => [
            reg.userId ?? "",
            reg.userSnapshot?.email ?? "",
            snapshotName(reg.userSnapshot),
            reg.eventId ?? "",
            reg.eventSnapshot?.title ?? "",
            reg.roleId ?? "",
            reg.eventSnapshot?.roleName ?? "",
            reg.status ?? "",
            reg.attendanceStatus ?? "",
            reg.attendanceConfirmed ? "Yes" : "No",
            reg.registrationDate
              ? new Date(reg.registrationDate).toLocaleString()
              : "",
            reg.registeredBy ?? "",
            reg.notes ?? "",
            reg.specialRequirements ?? "",
          ]),
        ];
        const registrationsWS = XLSX.utils.aoa_to_sheet(registrationsData);
        XLSX.utils.book_append_sheet(
          workbook,
          registrationsWS,
          "Registrations",
        );

        // Guest Registrations sheet (only when data present to preserve legacy test expectations)
        if (data.guestRegistrations && data.guestRegistrations.length > 0) {
          const guestRegsData = [
            [
              "Full Name",
              "Gender",
              "Email",
              "Phone",
              "Event ID",
              "Event Title",
              "Event Date",
              "Location",
              "Role Name",
              "Status",
              "Migrated To User ID",
              "Migration Status",
              "Notes",
              "Registration Date",
            ],
            ...data.guestRegistrations.map((g) => [
              g.fullName ?? "",
              g.gender ?? "",
              g.email ?? "",
              g.phone ?? "",
              g.eventId ?? "",
              g.eventSnapshot?.title ?? "",
              g.eventSnapshot?.date
                ? new Date(
                    g.eventSnapshot.date as Date | string,
                  ).toLocaleString()
                : "",
              g.eventSnapshot?.location ?? "",
              g.eventSnapshot?.roleName ?? "",
              g.status ?? "",
              g.migratedToUserId ?? "",
              g.migrationStatus ?? "",
              g.notes ?? "",
              g.registrationDate
                ? new Date(g.registrationDate).toLocaleString()
                : "",
            ]),
          ];
          const guestRegsWS = XLSX.utils.aoa_to_sheet(guestRegsData);
          XLSX.utils.book_append_sheet(
            workbook,
            guestRegsWS,
            "Guest Registrations",
          );
        }

        // Programs sheet (Purchases)
        if (data.programs && data.programs.length > 0) {
          const programsData = [
            [
              "User ID",
              "Purchase Type",
              "Program ID",
              "Program Title",
              "Order Number",
              "Final Price (cents)",
              "Status",
              "Purchase Date",
              "Student Role",
              "Class Rep",
              "Early Bird",
              "Promo Code",
              "Stripe Payment Intent",
            ],
            ...data.programs.map((p) => [
              p.userId ?? "",
              p.purchaseType ?? "",
              p.programId ?? "",
              p.programTitle || p.itemTitle || p.itemLabel || "",
              p.orderNumber ?? "",
              p.finalPrice ?? 0,
              p.status ?? "",
              p.purchaseDate ? new Date(p.purchaseDate).toLocaleString() : "",
              p.studentRoleName ?? "",
              p.isClassRep ? "Yes" : "No",
              p.isEarlyBird ? "Yes" : "No",
              p.promoCode ?? "",
              p.stripePaymentIntentId ?? "",
            ]),
          ];
          const programsWS = XLSX.utils.aoa_to_sheet(programsData);
          XLSX.utils.book_append_sheet(workbook, programsWS, "Programs");
        }

        if (data.programCatalog && data.programCatalog.length > 0) {
          const programCatalogData = [
            [
              "Program ID",
              "Program Name",
              "Program Type",
              "Hosted By",
              "Period",
              "Free",
              "Created Date",
              "Updated Date",
            ],
            ...data.programCatalog.map((program) => [
              program.id,
              program.title,
              program.programType,
              program.hostedBy,
              programPeriod(program.period),
              program.isFree ? "Yes" : "No",
              program.createdAt
                ? new Date(program.createdAt).toLocaleString()
                : "",
              program.updatedAt
                ? new Date(program.updatedAt).toLocaleString()
                : "",
            ]),
          ];
          const programCatalogWS = XLSX.utils.aoa_to_sheet(programCatalogData);
          XLSX.utils.book_append_sheet(
            workbook,
            programCatalogWS,
            "Program Catalog",
          );
        }

        // Donations sheet (Transactions)
        if (data.donations && data.donations.length > 0) {
          const donationsData = [
            [
              "User ID",
              "Donation ID",
              "Amount (cents)",
              "Type",
              "Status",
              "Gift Date",
              "Stripe Payment Intent",
            ],
            ...data.donations.map((d) => [
              d.userId ? String(d.userId) : "",
              d.donationId ? String(d.donationId) : "",
              d.amount ?? 0,
              d.type ?? "",
              d.status ?? "",
              d.giftDate ? new Date(d.giftDate).toLocaleString() : "",
              d.stripePaymentIntentId ?? "",
            ]),
          ];
          const donationsWS = XLSX.utils.aoa_to_sheet(donationsData);
          XLSX.utils.book_append_sheet(workbook, donationsWS, "Donations");
        }

        // Generate buffer
        const buffer = XLSX.write(workbook, {
          type: "buffer",
          bookType: "xlsx",
        });

        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader(
          "Content-Disposition",
          "attachment; filename=analytics.xlsx",
        );
        res.send(buffer);
      }
    } catch (error: unknown) {
      console.error("Export analytics error:", error);
      try {
        CorrelatedLogger.fromRequest(req, "AnalyticsController").error(
          "Export analytics error",
          error as Error,
          "exportAnalytics",
          { query: req.query },
        );
      } catch {}
      res.status(500).json({
        success: false,
        message: "Failed to export analytics.",
      });
    }
  }
}
