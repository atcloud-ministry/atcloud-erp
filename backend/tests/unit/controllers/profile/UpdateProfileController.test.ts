import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import UpdateProfileController from "../../../../src/controllers/profile/UpdateProfileController";

vi.mock("../../../../src/models", () => ({
  User: { findById: vi.fn() },
}));
vi.mock("../../../../src/utils/avatarCleanup", () => ({
  cleanupOldAvatar: vi.fn(),
}));
vi.mock(
  "../../../../src/services/infrastructure/autoEmailNotificationService",
  () => ({
    AutoEmailNotificationService: {
      sendAtCloudRoleChangeNotification: vi.fn(),
    },
  }),
);
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
import { cleanupOldAvatar } from "../../../../src/utils/avatarCleanup";
import { AutoEmailNotificationService } from "../../../../src/services/infrastructure/autoEmailNotificationService";
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
  company: "TestCo",
  occupation: "Developer",
} as const;

function hydratedUser(overrides: Record<string, unknown> = {}) {
  const user: Record<string, unknown> & { save: ReturnType<typeof vi.fn> } = {
    _id: "user123",
    username: "testuser",
    email: "user@test.com",
    firstName: "Test",
    lastName: "User",
    gender: "male",
    avatar: "/old-avatar.jpg",
    role: "Participant",
    isAtCloudLeader: false,
    roleInAtCloud: undefined,
    homeAddress: "123 Legacy St",
    weeklyChurch: "Test Church",
    churchAddress: "456 Church Ave",
    isActive: true,
    isVerified: true,
    lastLogin: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
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

describe("UpdateProfileController", () => {
  let req: {
    user?: { _id: string; role: string; email: string };
    body: Record<string, unknown>;
  };
  let res: Partial<Response>;
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    res = { status, json } as Partial<Response>;
    req = {
      user: {
        _id: "user123",
        role: "Participant",
        email: "user@test.com",
      },
      body: {},
    };
    vi.mocked(cleanupOldAvatar).mockResolvedValue(true);
    vi.mocked(CachePatterns.invalidateUserCache).mockResolvedValue(undefined);
    vi.mocked(mongoTransactionService.run).mockImplementation(
      async (operation) =>
        operation(TRANSACTION_SESSION as never, { attempt: 1, maxAttempts: 3 }),
    );
    vi.mocked(synchronizeExistingAlumniProfileProjection).mockResolvedValue(
      false,
    );
    vi.mocked(
      AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
    ).mockResolvedValue({ emailsSent: 1, messagesCreated: 1, success: true });
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  async function invoke() {
    await UpdateProfileController.updateProfile(
      req as unknown as Request,
      res as Response,
    );
  }

  it("requires authentication", async () => {
    req.user = undefined;
    await invoke();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("loads the hydrated owner with hidden birthYear", async () => {
    const { select, session } = mockFindById(null);
    await invoke();
    expect(select).toHaveBeenCalledWith("+birthYear");
    expect(session).toHaveBeenCalledWith(TRANSACTION_SESSION);
    expect(status).toHaveBeenCalledWith(404);
  });

  it("saves and synchronizes an existing alumni projection atomically", async () => {
    const user = hydratedUser();
    mockFindById(user);
    req.body = { company: "Next Company" };
    await invoke();

    expect(user.save).toHaveBeenCalledWith({ session: TRANSACTION_SESSION });
    expect(synchronizeExistingAlumniProfileProjection).toHaveBeenCalledWith(
      user,
      TRANSACTION_SESSION,
    );
  });

  it("keeps a legacy incomplete account editable for unrelated fields", async () => {
    const user = hydratedUser({ phone: undefined, birthYear: undefined });
    mockFindById(user);
    req.body = { firstName: "Updated", role: "Super Admin" };
    await invoke();

    expect(user.firstName).toBe("Updated");
    expect(user.role).toBe("Participant");
    expect(user.homeAddress).toBe("123 Legacy St");
    expect(user.save).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(200);
  });

  it("merges a partial contract edit, canonicalizes it, and clears homeAddress", async () => {
    const user = hydratedUser();
    mockFindById(user);
    req.body = { residenceCity: " San   José " };
    await invoke();

    expect(user).toMatchObject({
      ...BASE_PROFILE,
      residenceCity: "San José",
      homeAddress: undefined,
    });
    expect(user.save).toHaveBeenCalledOnce();
  });

  it("updates and returns all eight canonical registration-profile fields", async () => {
    const user = hydratedUser();
    mockFindById(user);
    req.body = {
      phone: " +14155552671 ",
      birthYear: "1988",
      residenceCity: " Toronto ",
      residenceRegion: "ca-on",
      residenceCountryCode: "ca",
      employmentStatus: "employed",
      company: " Example   Company ",
      occupation: " Product   Manager ",
      homeAddress: "Attempted replacement",
    };
    await invoke();

    expect(user).toMatchObject({
      phone: "+14155552671",
      birthYear: 1988,
      residenceCity: "Toronto",
      residenceRegion: "CA-ON",
      residenceCountryCode: "CA",
      employmentStatus: "employed",
      company: "Example Company",
      occupation: "Product Manager",
      homeAddress: undefined,
    });
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          phone: "+14155552671",
          birthYear: 1988,
          residenceCity: "Toronto",
          residenceRegion: "CA-ON",
          residenceCountryCode: "CA",
          employmentStatus: "employed",
          company: "Example Company",
          occupation: "Product Manager",
        }),
      }),
    );
  });

  it("rejects an invalid contract edit before save", async () => {
    const user = hydratedUser();
    mockFindById(user);
    req.body = { phone: "not-a-phone" };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ field: "phone" }),
        ]),
      }),
    );
    expect(user.save).not.toHaveBeenCalled();
  });

  it("requires roleInAtCloud when enabling co-worker status", async () => {
    mockFindById(hydratedUser({ roleInAtCloud: undefined }));
    req.body = { isAtCloudLeader: true };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
  });

  it("clears roleInAtCloud and sends removal notification", async () => {
    const user = hydratedUser({
      isAtCloudLeader: true,
      roleInAtCloud: "Developer",
    });
    mockFindById(user);
    req.body = { isAtCloudLeader: false };
    await invoke();

    expect(user.roleInAtCloud).toBeUndefined();
    expect(
      AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: "removed",
        userData: expect.objectContaining({
          previousRoleInAtCloud: "Developer",
        }),
      }),
    );
  });

  it("sends an assignment notification when promoted", async () => {
    const user = hydratedUser();
    mockFindById(user);
    req.body = {
      isAtCloudLeader: true,
      roleInAtCloud: "Ministry Leader",
    };
    await invoke();
    expect(
      AutoEmailNotificationService.sendAtCloudRoleChangeNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: "assigned",
        userData: expect.objectContaining({
          roleInAtCloud: "Ministry Leader",
        }),
      }),
    );
  });

  it("sets and cleans up the default avatar after a gender change", async () => {
    const user = hydratedUser({ gender: "female", avatar: "/old.jpg" });
    mockFindById(user);
    req.body = { gender: "male" };
    await invoke();

    expect(user.avatar).toBe("https://i.pravatar.cc/300?img=12");
    await vi.waitFor(() =>
      expect(cleanupOldAvatar).toHaveBeenCalledWith("user123", "/old.jpg"),
    );
  });

  it("invalidates the user cache after a successful hydrated save", async () => {
    mockFindById(hydratedUser());
    req.body = { firstName: "Updated" };
    await invoke();
    expect(CachePatterns.invalidateUserCache).toHaveBeenCalledWith("user123");
  });

  it("returns document validation failures as 400", async () => {
    const user = hydratedUser();
    user.save.mockRejectedValue({
      name: "ValidationError",
      errors: { email: { message: "Invalid email format" } },
    });
    mockFindById(user);
    req.body = { email: "invalid" };
    await invoke();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Validation failed.",
      errors: ["Invalid email format"],
    });
  });

  it("returns 500 for an unexpected database error", async () => {
    vi.mocked(User.findById).mockImplementation(() => {
      throw new Error("database failed");
    });
    await invoke();
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      message: "Failed to update profile.",
    });
  });
});
