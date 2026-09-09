import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../../src/models", () => ({
  AnnualMembership: {
    findById: vi.fn(),
  },
  Program: {
    countDocuments: vi.fn(),
  },
  Purchase: {
    find: vi.fn(),
  },
}));

vi.mock("../../../src/services/LockService", () => ({
  lockService: {},
}));

vi.mock("../../../src/services/stripeService", () => ({
  createMembershipCheckoutSession: vi.fn(),
}));

vi.mock(
  "../../../src/services/authorization/ResourceAuthorizationInvalidationService",
  () => ({
    resourceAuthorizationInvalidationService: {
      findEventIdsForPrograms: vi.fn(),
      invalidateEventRooms: vi.fn(),
    },
  }),
);

import { AnnualMembershipController } from "../../../src/controllers/annualMembershipController";
import { AnnualMembership, Program } from "../../../src/models";
import { resourceAuthorizationInvalidationService } from "../../../src/services/authorization/ResourceAuthorizationInvalidationService";

describe("AnnualMembershipController realtime authorization revocation", () => {
  const membershipId = "507f1f77bcf86cd799439010";
  const oldProgramId = "507f1f77bcf86cd799439011";
  const newProgramId = "507f1f77bcf86cd799439012";
  const eventId = "507f1f77bcf86cd799439013";
  let status: ReturnType<typeof vi.fn>;
  let json: ReturnType<typeof vi.fn>;
  let response: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    status = vi.fn().mockReturnThis();
    json = vi.fn();
    response = { status, json };
    vi.mocked(
      resourceAuthorizationInvalidationService.findEventIdsForPrograms,
    ).mockResolvedValue([eventId]);
  });

  it("invalidates affected event rooms after deactivation is persisted", async () => {
    const membership = {
      programs: [oldProgramId],
      isActive: true,
      save: vi.fn().mockResolvedValue(undefined),
      populate: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(AnnualMembership.findById).mockResolvedValue(membership as any);
    const request = {
      params: { id: membershipId },
      body: { isActive: false },
      user: { role: "Administrator" },
    } as Partial<Request>;

    await AnnualMembershipController.update(
      request as Request,
      response as Response,
    );

    expect(membership.isActive).toBe(false);
    expect(
      resourceAuthorizationInvalidationService.findEventIdsForPrograms,
    ).toHaveBeenCalledWith([oldProgramId, oldProgramId]);
    expect(
      resourceAuthorizationInvalidationService.invalidateEventRooms,
    ).toHaveBeenCalledWith([eventId]);
    expect(
      vi.mocked(
        resourceAuthorizationInvalidationService.findEventIdsForPrograms,
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(
      membership.save.mock.invocationCallOrder[0],
    );
    expect(membership.save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(
        resourceAuthorizationInvalidationService.invalidateEventRooms,
      ).mock.invocationCallOrder[0],
    );
    expect(
      resourceAuthorizationInvalidationService.findEventIdsForPrograms,
    ).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledWith(200);
  });

  it("finds events from both old and new program mappings after persistence", async () => {
    const membership = {
      programs: [oldProgramId],
      isActive: true,
      save: vi.fn().mockResolvedValue(undefined),
      populate: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(AnnualMembership.findById).mockResolvedValue(membership as any);
    vi.mocked(Program.countDocuments).mockResolvedValue(1);
    const request = {
      params: { id: membershipId },
      body: { programIds: [newProgramId] },
      user: { role: "Super Admin" },
    } as Partial<Request>;

    await AnnualMembershipController.update(
      request as Request,
      response as Response,
    );

    const affectedPrograms = vi.mocked(
      resourceAuthorizationInvalidationService.findEventIdsForPrograms,
    ).mock.calls[0][0];
    expect(affectedPrograms.map(String)).toEqual([oldProgramId, newProgramId]);
    expect(status).toHaveBeenCalledWith(200);
  });

  it("does not persist when the pre-mutation event lookup fails", async () => {
    const membership = {
      programs: [oldProgramId],
      isActive: true,
      save: vi.fn().mockResolvedValue(undefined),
      populate: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(AnnualMembership.findById).mockResolvedValue(membership as any);
    vi.mocked(
      resourceAuthorizationInvalidationService.findEventIdsForPrograms,
    ).mockRejectedValueOnce(new Error("lookup unavailable"));
    const request = {
      params: { id: membershipId },
      body: { isActive: false },
      user: { role: "Administrator" },
    } as Partial<Request>;

    await AnnualMembershipController.update(
      request as Request,
      response as Response,
    );

    expect(membership.save).not.toHaveBeenCalled();
    expect(
      resourceAuthorizationInvalidationService.invalidateEventRooms,
    ).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);
  });

  it("keeps the persisted update successful when reconciliation lookup fails", async () => {
    const membership = {
      programs: [oldProgramId],
      isActive: true,
      save: vi.fn().mockResolvedValue(undefined),
      populate: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(AnnualMembership.findById).mockResolvedValue(membership as any);
    vi.mocked(
      resourceAuthorizationInvalidationService.findEventIdsForPrograms,
    )
      .mockResolvedValueOnce([eventId])
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const request = {
      params: { id: membershipId },
      body: { isActive: false },
      user: { role: "Administrator" },
    } as Partial<Request>;

    await AnnualMembershipController.update(
      request as Request,
      response as Response,
    );

    expect(membership.save).toHaveBeenCalledTimes(1);
    expect(
      resourceAuthorizationInvalidationService.invalidateEventRooms,
    ).toHaveBeenCalledWith([eventId]);
    expect(status).toHaveBeenCalledWith(200);
    consoleError.mockRestore();
  });
});
