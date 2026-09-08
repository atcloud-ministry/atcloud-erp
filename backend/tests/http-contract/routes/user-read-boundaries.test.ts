import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  authorizePermission: vi.fn(),
  permissionCheck: vi.fn(),
  listCommunityMembers: vi.fn(),
  getCommunityMember: vi.fn(),
  listAdminUsers: vi.fn(),
  getAdminUser: vi.fn(),
  listUserOptions: vi.fn(),
}));

vi.mock("../../../src/utils/roleUtils", () => ({
  PERMISSIONS: {
    VIEW_USER_PROFILES: "view_user_profiles",
    MANAGE_USERS: "manage_users",
  },
}));

vi.mock("../../../src/middleware/auth", () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.header("x-test-role") === "anonymous") {
      res.status(401).json({ success: false });
      return;
    }
    req.user = { role: req.header("x-test-role") || "Participant" } as never;
    next();
  },
  authorizePermission: mocks.authorizePermission.mockImplementation(
    (permission: string) =>
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        mocks.permissionCheck(permission);
        if (
          permission === "manage_users" &&
          !["Administrator", "Super Admin"].includes(req.user?.role || "")
        ) {
          res.status(403).json({ success: false });
          return;
        }
        next();
      },
  ),
}));

vi.mock("../../../src/controllers/UserReadController", () => ({
  default: {
    listCommunityMembers: mocks.listCommunityMembers.mockImplementation(
      (_req: express.Request, res: express.Response) =>
        res.status(200).json({ success: true, data: { members: [] } }),
    ),
    getCommunityMember: mocks.getCommunityMember,
    listAdminUsers: mocks.listAdminUsers.mockImplementation(
      (_req: express.Request, res: express.Response) =>
        res.status(200).json({ success: true, data: { users: [] } }),
    ),
    getAdminUser: mocks.getAdminUser,
    listUserOptions: mocks.listUserOptions.mockImplementation(
      (_req: express.Request, res: express.Response) =>
        res.status(200).json({ success: true, data: { options: [] } }),
    ),
  },
}));

import adminUserRoutes from "../../../src/routes/admin/users";
import communityRoutes from "../../../src/routes/community";
import userOptionsRoutes from "../../../src/routes/userOptions";

describe("page-specific user read route boundaries", () => {
  const app = express()
    .use("/api/community", communityRoutes)
    .use("/api/admin/users", adminUserRoutes)
    .use("/api/user-options", userOptionsRoutes);

  beforeEach(() => {
    mocks.listCommunityMembers.mockClear();
    mocks.listAdminUsers.mockClear();
    mocks.listUserOptions.mockClear();
    mocks.permissionCheck.mockClear();
  });

  it("wires Community through explicit profile-view permission", async () => {
    await request(app)
      .get("/api/community/members")
      .set("x-test-role", "Participant")
      .expect(200);
    expect(mocks.permissionCheck).toHaveBeenCalledWith(
      "view_user_profiles",
    );
    expect(mocks.listCommunityMembers).toHaveBeenCalledOnce();
  });

  it("denies a Participant from the admin user page", async () => {
    await request(app)
      .get("/api/admin/users")
      .set("x-test-role", "Participant")
      .expect(403);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });

  it("allows an Administrator into the admin user page", async () => {
    await request(app)
      .get("/api/admin/users")
      .set("x-test-role", "Administrator")
      .expect(200);
    expect(mocks.listAdminUsers).toHaveBeenCalledOnce();
  });

  it("requires authentication for picker options", async () => {
    await request(app)
      .get("/api/user-options?context=event-organizer")
      .set("x-test-role", "anonymous")
      .expect(401);
    expect(mocks.listUserOptions).not.toHaveBeenCalled();
  });
});
