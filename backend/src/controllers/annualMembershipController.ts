import { Request, Response } from "express";
import mongoose from "mongoose";
import { AnnualMembership, Program, Purchase } from "../models";
import { lockService } from "../services/LockService";
import { createMembershipCheckoutSession } from "../services/stripeService";
import { resourceAuthorizationInvalidationService } from "../services/authorization/ResourceAuthorizationInvalidationService";

const ADMIN_ROLES = ["Super Admin", "Administrator"];

function isAdmin(user?: { role?: string }): boolean {
  return !!user && ADMIN_ROLES.includes(user.role || "");
}

function normalizeProgramIds(programIds: unknown): string[] | null {
  if (!Array.isArray(programIds)) return null;
  const ids = programIds.map((id) => String(id).trim()).filter(Boolean);
  return Array.from(new Set(ids));
}

async function validateProgramIds(
  programIds: unknown,
): Promise<{ valid: true; ids: mongoose.Types.ObjectId[] } | { valid: false; message: string }> {
  const ids = normalizeProgramIds(programIds);

  if (!ids || ids.length === 0) {
    return { valid: false, message: "Please select at least one program." };
  }

  const invalidId = ids.find((id) => !mongoose.Types.ObjectId.isValid(id));
  if (invalidId) {
    return { valid: false, message: `Invalid program ID: ${invalidId}` };
  }

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const count = await Program.countDocuments({ _id: { $in: objectIds } });
  if (count !== objectIds.length) {
    return {
      valid: false,
      message: "One or more selected programs could not be found.",
    };
  }

  return { valid: true, ids: objectIds };
}

async function addPurchaseState<T extends { _id?: unknown; id?: unknown }>(
  memberships: T[],
  user: Express.Request["user"],
): Promise<Array<T & { purchased: boolean; adminAccess: boolean }>> {
  const adminAccess = isAdmin(user);

  if (!user) {
    return memberships.map((membership) => ({
      ...membership,
      purchased: false,
      adminAccess,
    }));
  }

  const membershipIds = memberships
    .map((membership) => membership._id || membership.id)
    .filter(Boolean);

  const purchases = await Purchase.find({
    userId: user._id,
    purchaseType: "membership",
    membershipId: { $in: membershipIds },
    status: "completed",
    unenrolledAt: { $exists: false },
  }).select("membershipId");

  const purchasedIds = new Set(
    purchases.map((purchase) => String(purchase.membershipId)),
  );

  return memberships.map((membership) => {
    const id = membership._id || membership.id;
    return {
      ...membership,
      purchased: adminAccess || (id ? purchasedIds.has(String(id)) : false),
      adminAccess,
    };
  });
}

export class AnnualMembershipController {
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const { programId, q } = req.query as { programId?: string; q?: string };
      const filter: Record<string, unknown> = {};

      if (!isAdmin(req.user)) {
        filter.isActive = true;
      }

      if (programId) {
        if (!mongoose.Types.ObjectId.isValid(programId)) {
          res.status(400).json({
            success: false,
            message: "Invalid program ID.",
          });
          return;
        }
        filter.programs = new mongoose.Types.ObjectId(programId);
        filter.isActive = true;
      }

      if (q?.trim()) {
        filter.title = { $regex: q.trim(), $options: "i" };
      }

      const memberships = await AnnualMembership.find(filter)
        .populate(
          "programs",
          "title programType period isFree fullPriceTicket",
        )
        .sort({ createdAt: -1 })
        .lean({ virtuals: true });

      const data = await addPurchaseState(memberships, req.user);
      res.status(200).json({ success: true, data });
    } catch (error) {
      console.error("Error listing annual memberships:", error);
      res.status(500).json({
        success: false,
        message: "Failed to list annual memberships.",
      });
    }
  }

  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid annual membership ID.",
        });
        return;
      }

      const filter: Record<string, unknown> = { _id: id };
      if (!isAdmin(req.user)) filter.isActive = true;

      const membership = await AnnualMembership.findOne(filter)
        .populate(
          "programs",
          "title programType period isFree fullPriceTicket",
        )
        .lean({ virtuals: true });

      if (!membership) {
        res.status(404).json({
          success: false,
          message: "Annual membership not found.",
        });
        return;
      }

      const [data] = await addPurchaseState([membership], req.user);
      res.status(200).json({ success: true, data });
    } catch (error) {
      console.error("Error loading annual membership:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load annual membership.",
      });
    }
  }

  static async create(req: Request, res: Response): Promise<void> {
    try {
      if (!isAdmin(req.user)) {
        res.status(403).json({
          success: false,
          message: "Only Super Admin and Administrator can create memberships.",
        });
        return;
      }

      const title = String(req.body.title || "").trim();
      const price = Number(req.body.price);

      if (!title) {
        res.status(400).json({ success: false, message: "Title is required." });
        return;
      }

      if (!Number.isInteger(price) || price < 50 || price > 100000) {
        res.status(400).json({
          success: false,
          message: "Price must be an integer number of cents from 50 to 100000.",
        });
        return;
      }

      const programValidation = await validateProgramIds(req.body.programIds);
      if (!programValidation.valid) {
        res.status(400).json({
          success: false,
          message: programValidation.message,
        });
        return;
      }

      const membership = await AnnualMembership.create({
        title,
        price,
        programs: programValidation.ids,
        isActive: req.body.isActive !== false,
        createdBy: req.user!._id,
      });

      await membership.populate(
        "programs",
        "title programType period isFree fullPriceTicket",
      );

      res.status(201).json({ success: true, data: membership });
    } catch (error) {
      console.error("Error creating annual membership:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create annual membership.",
      });
    }
  }

  static async update(req: Request, res: Response): Promise<void> {
    try {
      if (!isAdmin(req.user)) {
        res.status(403).json({
          success: false,
          message: "Only Super Admin and Administrator can edit memberships.",
        });
        return;
      }

      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid annual membership ID.",
        });
        return;
      }

      const membership = await AnnualMembership.findById(id);
      if (!membership) {
        res.status(404).json({
          success: false,
          message: "Annual membership not found.",
        });
        return;
      }

      const priorProgramIds = (membership.programs || []).map((programId) =>
        String(programId),
      );
      const realtimeAccessInputsProvided =
        "programIds" in req.body || "isActive" in req.body;

      if ("title" in req.body) {
        const title = String(req.body.title || "").trim();
        if (!title) {
          res.status(400).json({
            success: false,
            message: "Title is required.",
          });
          return;
        }
        membership.title = title;
      }

      if ("price" in req.body) {
        const price = Number(req.body.price);
        if (!Number.isInteger(price) || price < 50 || price > 100000) {
          res.status(400).json({
            success: false,
            message:
              "Price must be an integer number of cents from 50 to 100000.",
          });
          return;
        }
        membership.price = price;
      }

      if ("programIds" in req.body) {
        const programValidation = await validateProgramIds(req.body.programIds);
        if (!programValidation.valid) {
          res.status(400).json({
            success: false,
            message: programValidation.message,
          });
          return;
        }
        membership.programs = programValidation.ids;
      }

      if ("isActive" in req.body) {
        membership.isActive = req.body.isActive !== false;
      }

      const affectedProgramIds = [
        ...priorProgramIds,
        ...(membership.programs || []),
      ];
      const affectedEventIdsBefore = realtimeAccessInputsProvided
        ? await resourceAuthorizationInvalidationService.findEventIdsForPrograms(
            affectedProgramIds,
          )
        : [];
      await membership.save();
      resourceAuthorizationInvalidationService.invalidateEventRooms(
        affectedEventIdsBefore,
      );
      if (realtimeAccessInputsProvided) {
        try {
          const affectedEventIdsAfter =
            await resourceAuthorizationInvalidationService.findEventIdsForPrograms(
              affectedProgramIds,
            );
          const previouslyInvalidated = new Set(affectedEventIdsBefore);
          resourceAuthorizationInvalidationService.invalidateEventRooms(
            affectedEventIdsAfter.filter(
              (eventId) => !previouslyInvalidated.has(eventId),
            ),
          );
        } catch (error) {
          console.error(
            "Failed to reconcile annual membership event-room invalidation:",
            error,
          );
        }
      }
      await membership.populate(
        "programs",
        "title programType period isFree fullPriceTicket",
      );

      res.status(200).json({ success: true, data: membership });
    } catch (error) {
      console.error("Error updating annual membership:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update annual membership.",
      });
    }
  }

  static async createCheckoutSession(
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }

      if (isAdmin(req.user)) {
        res.status(400).json({
          success: false,
          message: "Administrators already have access and do not need to purchase memberships.",
        });
        return;
      }

      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          message: "Invalid annual membership ID.",
        });
        return;
      }

      const membership = await AnnualMembership.findOne({
        _id: id,
        isActive: true,
      });
      if (!membership) {
        res.status(404).json({
          success: false,
          message: "Annual membership not found.",
        });
        return;
      }
      const membershipId = membership._id as mongoose.Types.ObjectId;

      const userId = req.user._id as mongoose.Types.ObjectId;
      const existingPurchase = await Purchase.findOne({
        userId,
        purchaseType: "membership",
        membershipId,
        status: "completed",
        unenrolledAt: { $exists: false },
      });

      if (existingPurchase) {
        res.status(400).json({
          success: false,
          message: "You have already purchased this annual membership.",
        });
        return;
      }

      const userName =
        `${req.user.firstName || ""} ${req.user.lastName || ""}`.trim() ||
        req.user.username;

      const result = await lockService.withLock(
        `membership:checkout:${userId.toString()}:${membershipId.toString()}`,
        async () => {
          const pendingPurchase = await Purchase.findOne({
            userId,
            purchaseType: "membership",
            membershipId,
            status: "pending",
          });

          if (pendingPurchase) {
            if (pendingPurchase.stripeSessionId) {
              try {
                const { stripe } = await import("../services/stripeService");
                const existingSession =
                  await stripe.checkout.sessions.retrieve(
                    pendingPurchase.stripeSessionId,
                  );
                if (existingSession.status === "open") {
                  await stripe.checkout.sessions.expire(
                    pendingPurchase.stripeSessionId,
                  );
                }
              } catch (error) {
                console.error("Error expiring old membership session:", error);
              }
            }
            await Purchase.deleteOne({ _id: pendingPurchase._id });
          }

          const purchaseId = new mongoose.Types.ObjectId();
          const orderNumber = await (
            Purchase as unknown as {
              generateOrderNumber: () => Promise<string>;
            }
          ).generateOrderNumber();

          const purchase = await Purchase.create({
            _id: purchaseId,
            userId,
            purchaseType: "membership",
            membershipId,
            orderNumber,
            itemTitle: membership.title,
            itemLabel: "Annual Membership",
            fullPrice: membership.price,
            classRepDiscount: 0,
            earlyBirdDiscount: 0,
            finalPrice: membership.price,
            isClassRep: false,
            isEarlyBird: false,
            stripeSessionId: "",
            status: "pending",
            billingInfo: {
              fullName: userName,
              email: req.user!.email,
            },
            paymentMethod: {
              type: "card",
            },
            purchaseDate: new Date(),
          });

          const session = await createMembershipCheckoutSession({
            userId: userId.toString(),
            userEmail: req.user!.email,
            membershipId: membershipId.toString(),
            membershipTitle: membership.title,
            price: membership.price,
            purchaseId: purchaseId.toString(),
          });

          purchase.stripeSessionId = session.id;
          await purchase.save();

          return {
            sessionId: session.id,
            sessionUrl: session.url,
            purchaseId: purchaseId.toString(),
            orderNumber,
          };
        },
        30000,
      );

      res.status(200).json({
        success: true,
        message: "Annual membership checkout session created successfully.",
        data: result,
      });
    } catch (error) {
      console.error("Error creating membership checkout session:", error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to create membership checkout session.",
      });
    }
  }
}

export default AnnualMembershipController;
