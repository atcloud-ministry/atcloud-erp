import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { AlumniProfileController } from "../../../src/controllers/alumni/AlumniProfileController";
import type { AlumniProfileService } from "../../../src/services/alumni/AlumniProfileService";

describe("explicit own-draft controller", () => {
  it("calls the writable draft service and returns the own profile", async () => {
    const profile = { id: "profile-id", publishStatus: "draft" };
    const ensureOwnDraft = vi.fn().mockResolvedValue(profile);
    const controller = new AlumniProfileController({ ensureOwnDraft } as unknown as AlumniProfileService);
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const setHeader = vi.fn();
    await controller.ensureOwnDraft(
      { userId: "user-id", userRole: "Participant" } as Request,
      { status, setHeader } as unknown as Response,
    );
    expect(ensureOwnDraft).toHaveBeenCalledWith("user-id");
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: { profile } });
  });
});
