import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/models", () => ({
  Event: { findById: vi.fn() },
  Program: { findById: vi.fn(), findOne: vi.fn() },
  Purchase: { findOne: vi.fn() },
}));

vi.mock(
  "../../../src/services/authorization/AuthorizationAuditService",
  () => ({ recordAuthorizationDenial: vi.fn() }),
);

import { Event, Program, Purchase, type IUser } from "../../../src/models";
import {
  UserOptionsAccessError,
  UserOptionsAccessService,
} from "../../../src/services/UserOptionsAccessService";
import { recordAuthorizationDenial } from "../../../src/services/authorization/AuthorizationAuditService";

function selected(value: unknown) {
  return { select: vi.fn().mockResolvedValue(value) };
}

function user(role: IUser["role"], id = new mongoose.Types.ObjectId()) {
  return {
    _id: id,
    role,
    isActive: true,
    isVerified: true,
  } as IUser;
}

describe("UserOptionsAccessService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires global create permission for a create-flow picker", async () => {
    await expect(
      UserOptionsAccessService.assertCanRead(
        { context: "program-mentor", page: 1, limit: 20 },
        user("Participant"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(recordAuthorizationDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "http",
        action: "platform.has_permission",
      }),
      expect.objectContaining({
        allowed: false,
        reasonCode: "insufficient_permission",
      }),
      undefined,
    );

    await expect(
      UserOptionsAccessService.assertCanRead(
        { context: "program-mentor", page: 1, limit: 20 },
        user("Leader"),
      ),
    ).resolves.toBeUndefined();
  });

  it("preserves concrete Program edit rights for an admin-enrolled class rep", async () => {
    const id = new mongoose.Types.ObjectId();
    const programId = new mongoose.Types.ObjectId().toString();
    vi.mocked(Program.findById).mockReturnValue(
      selected({
        _id: programId,
        createdBy: new mongoose.Types.ObjectId(),
        mentors: [],
        adminEnrollments: { classReps: [id] },
      }) as never,
    );

    await expect(
      UserOptionsAccessService.assertCanRead(
        {
          context: "program-mentor",
          resourceId: programId,
          page: 1,
          limit: 20,
        },
        user("Participant", id),
      ),
    ).resolves.toBeUndefined();
    expect(Purchase.findOne).not.toHaveBeenCalled();
  });

  it("preserves concrete Event rights for its creator regardless of global role", async () => {
    const id = new mongoose.Types.ObjectId();
    const eventId = new mongoose.Types.ObjectId().toString();
    vi.mocked(Event.findById).mockReturnValue(
      selected({ createdBy: id, organizerDetails: [], programLabels: [] }) as never,
    );

    await expect(
      UserOptionsAccessService.assertCanRead(
        {
          context: "event-organizer",
          resourceId: eventId,
          page: 1,
          limit: 20,
        },
        user("Participant", id),
      ),
    ).resolves.toBeUndefined();
  });

  it("distinguishes a missing resource from forbidden access", async () => {
    vi.mocked(Event.findById).mockReturnValue(selected(null) as never);
    await expect(
      UserOptionsAccessService.assertCanRead(
        {
          context: "event-role-assignee",
          resourceId: new mongoose.Types.ObjectId().toString(),
          page: 1,
          limit: 20,
        },
        user("Leader"),
        "options-request-123",
      ),
    ).rejects.toBeInstanceOf(UserOptionsAccessError);
    expect(recordAuthorizationDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "http",
        action: "event.manage",
      }),
      expect.objectContaining({
        allowed: false,
        reasonCode: "resource_not_found",
      }),
      "options-request-123",
    );
    await expect(
      UserOptionsAccessService.assertCanRead(
        {
          context: "event-role-assignee",
          resourceId: new mongoose.Types.ObjectId().toString(),
          page: 1,
          limit: 20,
        },
        user("Leader"),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("preserves a server error when a resource authorization lookup fails", async () => {
    const eventId = new mongoose.Types.ObjectId().toString();
    vi.mocked(Event.findById).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const result = UserOptionsAccessService.assertCanRead(
      {
        context: "event-organizer",
        resourceId: eventId,
        page: 1,
        limit: 20,
      },
      user("Leader"),
      "options-request-500",
    );

    await expect(result).rejects.toEqual(
      new Error("User options authorization check failed."),
    );
    expect(recordAuthorizationDenial).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.manage" }),
      expect.objectContaining({
        allowed: false,
        reasonCode: "authorization_error",
      }),
      "options-request-500",
    );
  });
});
