import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/models", () => ({
  User: { find: vi.fn() },
}));

import { User } from "../../../src/models";
import {
  AssignmentSnapshotError,
  UserAssignmentSnapshotService,
} from "../../../src/services/UserAssignmentSnapshotService";

function mockUsers(rows: unknown[]) {
  vi.mocked(User.find).mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(rows),
    }),
  } as never);
}

describe("UserAssignmentSnapshotService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores spoofed organizer identity and resolves the canonical user", async () => {
    const id = new mongoose.Types.ObjectId();
    mockUsers([
      {
        _id: id,
        username: "amy",
        email: "real@example.com",
        firstName: "Amy",
        lastName: "Chen",
        gender: "female",
        avatar: "/real.jpg",
        role: "Leader",
        roleInAtCloud: "Program Mentor",
        isActive: true,
        isVerified: true,
      },
    ]);

    const [snapshot] =
      await UserAssignmentSnapshotService.resolveEventOrganizers([
        {
          userId: id.toString(),
          name: "Spoofed",
          email: "attacker@example.com",
          phone: "555-9999",
          avatar: "/spoof.jpg",
        },
      ]);

    expect(snapshot).toEqual({
      userId: id,
      name: "Amy Chen",
      role: "Program Mentor",
      avatar: "/real.jpg",
      gender: "female",
      email: "placeholder@example.com",
      phone: "Phone not provided",
    });
  });

  it("resolves canonical private mentor email instead of trusting the payload", async () => {
    const id = new mongoose.Types.ObjectId();
    mockUsers([
      {
        _id: id,
        email: "canonical@example.com",
        firstName: "Sam",
        lastName: "Ma",
        role: "Administrator",
        isActive: true,
        isVerified: true,
      },
    ]);

    const [snapshot] =
      await UserAssignmentSnapshotService.resolveProgramMentors([
        { userId: id.toString(), email: "spoofed@example.com" },
      ]);
    expect(snapshot.email).toBe("canonical@example.com");
    expect(snapshot.firstName).toBe("Sam");
  });

  it("rejects a newly added inactive or unverified user", async () => {
    const id = new mongoose.Types.ObjectId();
    mockUsers([
      {
        _id: id,
        role: "Leader",
        isActive: false,
        isVerified: true,
      },
    ]);
    await expect(
      UserAssignmentSnapshotService.resolveEventOrganizers([
        { userId: id.toString() },
      ]),
    ).rejects.toBeInstanceOf(AssignmentSnapshotError);
  });

  it("allows an unchanged inactive assignment while refreshing its snapshot", async () => {
    const id = new mongoose.Types.ObjectId();
    mockUsers([
      {
        _id: id,
        username: "retained",
        firstName: "Updated",
        lastName: "Name",
        role: "Participant",
        isActive: false,
        isVerified: false,
      },
    ]);
    const [snapshot] =
      await UserAssignmentSnapshotService.resolveEventOrganizers(
        [{ userId: id.toString(), name: "Stale Name" }],
        [id.toString()],
      );
    expect(snapshot.name).toBe("Updated Name");
  });
});
