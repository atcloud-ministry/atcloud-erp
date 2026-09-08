import { Request, Response } from "express";
import mongoose from "mongoose";
import {
  adminUsersQuerySchema,
  communityMembersQuerySchema,
  RuntimeQueryValidationError,
  userOptionsQuerySchema,
} from "../contracts/userReadContracts";
import {
  UserOptionsAccessError,
  UserOptionsAccessService,
} from "../services/UserOptionsAccessService";
import { UserReadService } from "../services/UserReadService";

function validationFailure(res: Response, error: RuntimeQueryValidationError) {
  res.status(400).json({
    success: false,
    message: error.message,
    errors: error.issues,
  });
}

function isValidId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export default class UserReadController {
  static async listCommunityMembers(req: Request, res: Response): Promise<void> {
    try {
      const query = communityMembersQuerySchema.parse(req.query);
      const data = await UserReadService.listCommunityMembers(query);
      res.status(200).json({ success: true, data });
    } catch (error) {
      if (error instanceof RuntimeQueryValidationError) {
        validationFailure(res, error);
        return;
      }
      console.error("List community members error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve community members.",
      });
    }
  }

  static async getCommunityMember(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        res.status(400).json({ success: false, message: "Invalid user ID." });
        return;
      }
      const member = await UserReadService.getCommunityMember(id);
      if (!member) {
        res.status(404).json({
          success: false,
          message: "Community member not found.",
        });
        return;
      }
      res.status(200).json({ success: true, data: { member } });
    } catch (error) {
      console.error("Get community member error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve community member.",
      });
    }
  }

  static async listAdminUsers(req: Request, res: Response): Promise<void> {
    try {
      const query = adminUsersQuerySchema.parse(req.query);
      const data = await UserReadService.listAdminUsers(query);
      res.status(200).json({ success: true, data });
    } catch (error) {
      if (error instanceof RuntimeQueryValidationError) {
        validationFailure(res, error);
        return;
      }
      console.error("List admin users error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve users.",
      });
    }
  }

  static async listLegacyAdminUsers(req: Request, res: Response): Promise<void> {
    const legacyQuery = { ...req.query } as Record<string, unknown>;
    if (legacyQuery.search !== undefined && legacyQuery.q === undefined) {
      legacyQuery.q = legacyQuery.search;
    }
    if (
      legacyQuery.emailVerified !== undefined &&
      legacyQuery.isVerified === undefined
    ) {
      legacyQuery.isVerified = legacyQuery.emailVerified;
    }
    delete legacyQuery.search;
    delete legacyQuery.emailVerified;
    req.query = legacyQuery as Request["query"];
    await UserReadController.listAdminUsers(req, res);
  }

  static async getAdminUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if (!isValidId(id)) {
        res.status(400).json({ success: false, message: "Invalid user ID." });
        return;
      }
      const user = await UserReadService.getAdminUser(id);
      if (!user) {
        res.status(404).json({ success: false, message: "User not found." });
        return;
      }
      res.status(200).json({ success: true, data: { user } });
    } catch (error) {
      console.error("Get admin user error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve user.",
      });
    }
  }

  static async listUserOptions(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          message: "Authentication required.",
        });
        return;
      }
      const query = userOptionsQuerySchema.parse(req.query);
      await UserOptionsAccessService.assertCanRead(query, req.user);
      const data = await UserReadService.listUserOptions(query);
      res.status(200).json({ success: true, data });
    } catch (error) {
      if (error instanceof RuntimeQueryValidationError) {
        validationFailure(res, error);
        return;
      }
      if (error instanceof UserOptionsAccessError) {
        res
          .status(error.status)
          .json({ success: false, message: error.message });
        return;
      }
      console.error("List user options error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve user options.",
      });
    }
  }
}
