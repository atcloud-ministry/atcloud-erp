import { beforeEach, describe, expect, it, vi } from "vitest";
import AlumniProfile from "../../../../src/models/AlumniProfile";
import { getRegistrationProfileReadiness } from "../../../../src/services/RegistrationProfileService";
import { ensurePrivateAlumniDraft } from "../../../../src/services/alumni/AlumniDraftProfileService";

vi.mock("../../../../src/models/AlumniProfile", () => {
  class Profile {
    static updateOne = vi.fn();
    static exists = vi.fn();
    searchProjection: unknown;
    constructor(readonly source: unknown) {}
    toObject() { return { ...this.source as object, publishStatus: "draft", revision: 0, searchProjection: this.searchProjection }; }
  }
  return { default: Profile };
});
vi.mock("../../../../src/services/RegistrationProfileService", () => ({
  getRegistrationProfileReadiness: vi.fn(),
}));
vi.mock("../../../../src/services/alumni/AlumniProfileProjectionService", () => ({
  buildAlumniProfileSearchProjection: vi.fn(() => ({ searchText: "member" })),
}));

const user = { _id: "user-id", username: "member" } as never;

describe("private Alumni draft provisioner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRegistrationProfileReadiness).mockReturnValue({ ready: true, issues: [] });
    vi.mocked(AlumniProfile.updateOne).mockResolvedValue({ upsertedCount: 1 } as never);
  });

  it("skips incomplete accounts", async () => {
    vi.mocked(getRegistrationProfileReadiness).mockReturnValue({ ready: false, issues: [] });
    expect(await ensurePrivateAlumniDraft(user)).toBe(false);
    expect(AlumniProfile.updateOne).not.toHaveBeenCalled();
  });

  it("inserts only a private draft and suppresses matched-profile timestamp writes", async () => {
    expect(await ensurePrivateAlumniDraft(user)).toBe(true);
    expect(AlumniProfile.updateOne).toHaveBeenCalledWith(
      { userId: "user-id" },
      { $setOnInsert: expect.objectContaining({
        publishStatus: "draft", revision: 0,
        createdAt: expect.any(Date), updatedAt: expect.any(Date),
      }) },
      { upsert: true, session: undefined, runValidators: true, timestamps: false },
    );
  });

  it("treats an existing profile after a duplicate-key race as success", async () => {
    vi.mocked(AlumniProfile.updateOne).mockRejectedValueOnce({ code: 11000 });
    vi.mocked(AlumniProfile.exists).mockReturnValue({
      session: vi.fn().mockResolvedValue({ _id: "existing" }),
    } as never);
    expect(await ensurePrivateAlumniDraft(user)).toBe(true);
  });
});
