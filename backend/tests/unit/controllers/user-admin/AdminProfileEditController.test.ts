import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import AdminProfileEditController from "../../../../src/controllers/user-admin/AdminProfileEditController";

vi.mock("../../../../src/models", () => ({
  User: { findById: vi.fn() },
}));
vi.mock("../../../../src/services/AuditLogService", () => ({
  AuditLogService: { recordRequiredInTransaction: vi.fn() },
}));
vi.mock("../../../../src/utils/avatarCleanup", () => ({
  cleanupOldAvatar: vi.fn(),
}));
vi.mock("../../../../src/services/infrastructure/SocketService", () => ({
  socketService: { emitUserUpdate: vi.fn() },
}));
vi.mock("../../../../src/services/infrastructure/CacheService", () => ({
  CachePatterns: { invalidateUserCache: vi.fn() },
}));
vi.mock(
  "../../../../src/services/alumni/AlumniProfileProjectionSyncService",
  () => ({ synchronizeExistingAlumniProfileProjection: vi.fn() }),
);
vi.mock("../../../../src/services/alumni/AlumniDraftProfileService", () => ({
  ensurePrivateAlumniDraft: vi.fn().mockResolvedValue(true),
}));
vi.mock(
  "../../../../src/services/reliability/MongoTransactionService",
  () => ({ mongoTransactionService: { run: vi.fn() } }),
);

import { User } from "../../../../src/models";
import { AuditLogService } from "../../../../src/services/AuditLogService";
import { cleanupOldAvatar } from "../../../../src/utils/avatarCleanup";
import { socketService } from "../../../../src/services/infrastructure/SocketService";
import { CachePatterns } from "../../../../src/services/infrastructure/CacheService";
import {
  synchronizeExistingAlumniProfileProjection,
} from "../../../../src/services/alumni/AlumniProfileProjectionSyncService";
import { mongoTransactionService } from "../../../../src/services/reliability/MongoTransactionService";

const TRANSACTION_SESSION = { inTransaction: () => true };

const BASE_PROFILE = {
  phone: "+12065550123",
  birthYear: 1990,
  residenceCity: "Seattle",
  residenceRegion: "US-WA",
  residenceCountryCode: "US",
  employmentStatus: "employed",
  company: "AtCloud Test",
  occupation: "Tester",
} as const;

function hydratedUser(overrides: Record<string, unknown> = {}) {
  const user: Record<string, unknown> & { save: ReturnType<typeof vi.fn> } = {
    _id: "targetUser123",
    email: "target@test.com",
    username: "targetuser",
    firstName: "Target",
    lastName: "User",
    role: "Participant",
    avatar: "/old-avatar.jpg",
    homeAddress: "Legacy address",
    isAtCloudLeader: false,
    roleInAtCloud: undefined,
    isActive: true,
    ...BASE_PROFILE,
    ...overrides,
    save: vi.fn(),
  };
  user.save.mockImplementation(async () => user);
  return user;
}

function mockFindById(result: Record<string, unknown> | null) {
  const session = vi.fn().mockResolvedValue(result);
  const select = vi.fn().mockReturnValue({ session });
  vi.mocked(User.findById).mockReturnValue({ select } as never);
  return { select, session };
}

describe("AdminProfileEditController", () => {
  let req: {
    params: Record<string, string>;
    body: Record<string, unknown>;
    user?: { _id: string; role: string; email: string };
    ip: string;
    get: ReturnType<typeof vi.fn>;
  };
  let res: Partial<Response>;
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    res = { status, json } as Partial<Response>;
    req = {
      params: { id: "targetUser123" },
      body: {},
      user: {
        _id: "admin123",
        role: "Administrator",
        email: "admin@test.com",
      },
      ip: "127.0.0.1",
      get: vi.fn().mockReturnValue("unit-test"),
    };
    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
    vi.mocked(AuditLogService.recordRequiredInTransaction).mockResolvedValue(
      undefined,
    );
    vi.mocked(cleanupOldAvatar).mockResolvedValue(true);
    vi.mocked(mongoTransactionService.run).mockImplementation(
      async (operation) =>
        operation(TRANSACTION_SESSION as never, { attempt: 1, maxAttempts: 3 }),
    );
    vi.mocked(synchronizeExistingAlumniProfileProjection).mockResolvedValue(
      false,
    );
  });

  afterEach(() => consoleError.mockRestore());

  async function invoke() {
    await AdminProfileEditController.adminEditProfile(
      req as unknown as Request,
      res as Response,
    );
  }

  it("requires authentication", async () => {
    req.user = undefined;
    await invoke();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("uses MANAGE_USERS permission semantics", async () => {
    req.user!.role = "Leader";
    await invoke();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Access denied. Required permission: manage_users",
    });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it.each(["Administrator", "Super Admin"])(
    "allows %s to reach the target lookup",
    async (role) => {
      req.user!.role = role;
      mockFindById(null);
      await invoke();
      expect(status).toHaveBeenCalledWith(404);
    },
  );

  it("selects hidden birthYear while loading the hydrated target", async () => {
    const { select, session } = mockFindById(null);
    await invoke();
    expect(select).toHaveBeenCalledWith("+birthYear");
    expect(session).toHaveBeenCalledWith(TRANSACTION_SESSION);
  });

  it("saves and synchronizes an existing alumni projection atomically", async () => {
    const target = hydratedUser();
    mockFindById(target);
    req.body = { company: "Next Company" };
    await invoke();

    expect(target.save).toHaveBeenCalledWith({ session: TRANSACTION_SESSION });
    expect(synchronizeExistingAlumniProfileProjection).toHaveBeenCalledWith(
      target,
      TRANSACTION_SESSION,
    );
  });

  it("returns 400 for a non-boolean isAtCloudLeader without throwing", async () => {
    req.body = { isAtCloudLeader: "false" };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Invalid admin profile edit payload.",
    });
    expect(User.findById).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith(500);
  });

  it("rejects an invalid merged registration profile", async () => {
    const target = hydratedUser();
    mockFindById(target);
    req.body = { birthYear: "not-a-year" };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ field: "birthYear" }),
        ]),
      }),
    );
    expect(target.save).not.toHaveBeenCalled();
  });

  it("requires roleInAtCloud for an enabled co-worker", async () => {
    mockFindById(hydratedUser({ roleInAtCloud: undefined }));
    req.body = { isAtCloudLeader: true };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Role in @Cloud is required for @Cloud co-workers.",
    });
  });

  it("canonicalizes all eight registration fields and clears homeAddress", async () => {
    const target = hydratedUser();
    mockFindById(target);
    req.body = {
      phone: " +14155552671 ",
      birthYear: "1988",
      residenceCity: " San   José ",
      residenceRegion: "ca-on",
      residenceCountryCode: "ca",
      employmentStatus: "employed",
      company: " Example   Company ",
      occupation: " Product   Manager ",
    };
    await invoke();

    expect(target.save).toHaveBeenCalledOnce();
    expect(target).toMatchObject({
      phone: "+14155552671",
      birthYear: 1988,
      residenceCity: "San José",
      residenceRegion: "CA-ON",
      residenceCountryCode: "CA",
      employmentStatus: "employed",
      company: "Example Company",
      occupation: "Product Manager",
      homeAddress: undefined,
    });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phone: "+14155552671",
          birthYear: 1988,
          residenceCity: "San José",
          residenceRegion: "CA-ON",
          residenceCountryCode: "CA",
          employmentStatus: "employed",
          company: "Example Company",
          occupation: "Product Manager",
        }),
      }),
    );
  });

  it("merges a partial profile edit with persisted values", async () => {
    const target = hydratedUser();
    mockFindById(target);
    req.body = { residenceCity: " Bellevue " };
    await invoke();
    expect(target).toMatchObject({
      ...BASE_PROFILE,
      residenceCity: "Bellevue",
      homeAddress: undefined,
    });
    expect(target.save).toHaveBeenCalledOnce();
  });

  it("keeps legacy incomplete accounts editable for unrelated fields", async () => {
    const target = hydratedUser({
      birthYear: undefined,
      phone: undefined,
      homeAddress: "Legacy address",
    });
    mockFindById(target);
    req.body = { avatar: "/new-avatar.jpg" };
    await invoke();
    expect(target.avatar).toBe("/new-avatar.jpg");
    expect(target.homeAddress).toBe("Legacy address");
    expect(target.save).toHaveBeenCalledOnce();
  });

  it("clears roleInAtCloud when co-worker status is disabled", async () => {
    const target = hydratedUser({
      isAtCloudLeader: true,
      roleInAtCloud: "Developer",
    });
    mockFindById(target);
    req.body = { isAtCloudLeader: false };
    await invoke();
    expect(target.isAtCloudLeader).toBe(false);
    expect(target.roleInAtCloud).toBeUndefined();
  });

  it("audits canonical changes and cleans a replaced avatar", async () => {
    const target = hydratedUser();
    mockFindById(target);
    req.body = { avatar: "/new-avatar.jpg", phone: " +14155552671 " };
    await invoke();

    await vi.waitFor(() =>
      expect(cleanupOldAvatar).toHaveBeenCalledWith(
        "targetUser123",
        "/old-avatar.jpg",
      ),
    );
    expect(AuditLogService.recordRequiredInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_profile_edit",
        target: { model: "User", id: "targetUser123" },
        details: {
          changedFields: expect.arrayContaining(["phone", "avatar", "homeAddress"]),
        },
      }),
      TRANSACTION_SESSION,
    );
    expect(
      JSON.stringify(
        vi.mocked(AuditLogService.recordRequiredInTransaction).mock.calls[0][0],
      ),
    )
      .not.toContain("target@test.com");
    expect(
      JSON.stringify(
        vi.mocked(AuditLogService.recordRequiredInTransaction).mock.calls[0][0],
      ),
    )
      .not.toContain("+14155552671");
  });

  it("keeps new raw structured private values off sockets", async () => {
    const target = hydratedUser();
    mockFindById(target);
    req.body = {
      birthYear: 1988,
      residenceCity: "Bellevue",
      company: "New Company",
    };
    await invoke();

    const socketPayload = vi.mocked(socketService.emitUserUpdate).mock
      .calls[0][1];
    expect(socketPayload).toMatchObject({
      type: "profile_edited",
      changes: { birthYear: true, residenceCity: true, company: true },
    });
    expect(socketPayload.user).not.toHaveProperty("birthYear");
    expect(socketPayload.user).not.toHaveProperty("residenceCity");
    expect(socketPayload.user).not.toHaveProperty("company");
    expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith(
      "targetUser123",
    );
  });

  it("returns schema validation failures as 400", async () => {
    const target = hydratedUser();
    target.save.mockRejectedValue({
      name: "ValidationError",
      errors: { phone: { message: "invalid phone" } },
    });
    mockFindById(target);
    req.body = { avatar: "/new-avatar.jpg" };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Validation failed.",
      errors: ["invalid phone"],
    });
  });

  it("fails the transaction when the required audit write fails", async () => {
    mockFindById(hydratedUser());
    vi.mocked(
      AuditLogService.recordRequiredInTransaction,
    ).mockRejectedValue(new Error("audit unavailable"));
    req.body = { avatar: "/new-avatar.jpg" };
    await invoke();
    expect(status).toHaveBeenCalledWith(500);
    expect(
      AuditLogService.recordRequiredInTransaction,
    ).toHaveBeenCalledOnce();
    expect(CachePatterns.invalidateUserCache).not.toHaveBeenCalled();
    expect(socketService.emitUserUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 for an unexpected database failure", async () => {
    vi.mocked(User.findById).mockImplementation(() => {
      throw new Error("database failed");
    });
    await invoke();
    expect(status).toHaveBeenCalledWith(500);
  });
});
