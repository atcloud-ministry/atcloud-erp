import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/models", () => ({
  Event: { findById: vi.fn() },
  Program: { findById: vi.fn(), findOne: vi.fn() },
  Purchase: { findOne: vi.fn() },
}));

import { Event, Program, Purchase, type IUser } from "../../../src/models";
import {
  UserOptionsAccessError,
  UserOptionsAccessService,
} from "../../../src/services/UserOptionsAccessService";

function selected(value: unknown) {
  return { select: vi.fn().mockResolvedValue(value) };
}

function user(role: IUser["role"], id = new mongoose.Types.ObjectId()) {
  return { _id: id, role } as IUser;
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
      ),
    ).rejects.toBeInstanceOf(UserOptionsAccessError);
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
});
