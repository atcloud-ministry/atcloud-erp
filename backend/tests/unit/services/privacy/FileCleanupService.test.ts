import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeLocalUploadReference,
  FileCleanupService,
  normalizeFileCleanupTarget,
} from "../../../../src/services/privacy/FileCleanupService";
import type { FileCleanupStorageArea } from "../../../../src/models/FileCleanupJob";
import Event from "../../../../src/models/Event";
import Program from "../../../../src/models/Program";
import User from "../../../../src/models/User";

const NOW = new Date("2032-01-31T20:15:00.000Z");
const LEASE = "2f47bc55-87ae-4df2-b711-0e2c60c8ca5f";

function modelDouble() {
  return {
    bulkWrite: vi.fn().mockResolvedValue({}),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
}

function jobFor(
  filename = "private.jpg",
  storageArea: FileCleanupStorageArea = "avatars",
) {
  const target = normalizeFileCleanupTarget({
    storageArea,
    filename,
  });
  return {
    _id: "job-id",
    ...target,
    attemptCount: 0,
    nextAttemptAt: NOW,
  };
}

describe("FileCleanupService", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_URL", "https://api.example.org/backend");
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    vi.stubEnv("API_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("canonicalizes approved local upload references and strips URL metadata", () => {
    expect(
      canonicalizeLocalUploadReference(
        "https://api.example.org/uploads/avatars/private.webp?t=123#cache",
        "avatars",
      ),
    ).toEqual({ storageArea: "avatars", filename: "private.webp" });
    expect(
      canonicalizeLocalUploadReference(
        "/uploads/images/flyer%20one.webp?revision=2",
        "images",
      ),
    ).toEqual({ storageArea: "images", filename: "flyer one.webp" });
  });

  it("accepts configured absolute origins, rejects external hosts, and supports legacy event paths", () => {
    vi.stubEnv("API_BASE_URL", "https://secondary.example.org/api");

    expect(
      canonicalizeLocalUploadReference(
        "https://secondary.example.org/uploads/events/legacy.jpg?revision=2",
        "events",
      ),
    ).toEqual({ storageArea: "events", filename: "legacy.jpg" });
    expect(
      canonicalizeLocalUploadReference(
        "https://external.example.org/uploads/events/legacy.jpg",
        "events",
      ),
    ).toBeNull();
    expect(
      canonicalizeLocalUploadReference(
        "/uploads/events/legacy.jpg#preview",
        "events",
      ),
    ).toEqual({ storageArea: "events", filename: "legacy.jpg" });
  });

  it.each([
    "private.jpg",
    "https://example.org/avatar.jpg",
    "https://external.example.org/uploads/avatars/private.jpg",
    "/uploads/avatars/nested/private.jpg",
    "/uploads/avatars/../private.jpg",
    "/uploads/avatars/%2e%2e/private.jpg",
    "/uploads/images/private.jpg",
    "ftp://api.example.org/uploads/avatars/private.jpg",
    "https://user:pass@api.example.org/uploads/avatars/private.jpg",
  ])("rejects an unapproved avatar reference: %s", (reference) => {
    expect(canonicalizeLocalUploadReference(reference, "avatars")).toBeNull();
  });

  it("enqueues idempotent cleanup in the caller's transaction", async () => {
    const model = modelDouble();
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
    });
    const session = { inTransaction: () => true };

    const targets = await service.enqueueInTransaction(
      [
        {
          storageArea: "avatars",
          filename: "private.jpg",
        },
        {
          storageArea: "avatars",
          filename: "private.jpg",
        },
      ],
      session as never,
    );

    expect(targets).toHaveLength(1);
    expect(model.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { jobKey: targets[0]?.jobKey },
            upsert: true,
          }),
        }),
      ],
      { session, ordered: true },
    );
  });

  it("enqueues standalone cleanup without a caller session", async () => {
    const model = modelDouble();
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
    });

    const targets = await service.enqueueStandalone([
      { storageArea: "avatars", filename: "old-avatar.jpg" },
    ]);

    expect(targets).toHaveLength(1);
    expect(model.bulkWrite).toHaveBeenCalledWith(expect.any(Array), {
      ordered: true,
    });
  });

  it("retains a failed unlink for unlimited scheduled retry", async () => {
    const model = modelDouble();
    const job = jobFor();
    model.findOneAndUpdate.mockResolvedValue(job);
    const unlink = vi.fn().mockRejectedValue(
      Object.assign(new Error("device unavailable"), { code: "EIO" }),
    );
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced: vi.fn().mockResolvedValue(false),
      uploadRoot: () => "/srv/uploads",
      baseRetryMs: 1_000,
      maxRetryMs: 10_000,
    });

    const [result] = await service.processTargets([job]);

    expect(result?.outcome).toBe("retry_scheduled");
    expect(unlink).toHaveBeenCalledWith("/srv/uploads/avatars/private.jpg");
    expect(model.deleteOne).not.toHaveBeenCalled();
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: "job-id", leaseToken: LEASE },
      expect.objectContaining({
        $set: expect.objectContaining({
          nextAttemptAt: new Date(NOW.getTime() + 1_000),
          lastErrorCode: "EIO",
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        $inc: { attemptCount: 1 },
      }),
      { runValidators: true },
    );
  });

  it("completes and erases the durable record when the file is absent", async () => {
    const model = modelDouble();
    const job = jobFor();
    model.findOneAndUpdate.mockResolvedValue(job);
    const unlink = vi.fn().mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced: vi.fn().mockResolvedValue(false),
      uploadRoot: () => "/srv/uploads",
    });

    const [result] = await service.processTargets([job]);

    expect(result?.outcome).toBe("already_absent");
    expect(model.updateOne).not.toHaveBeenCalled();
    expect(model.deleteOne).toHaveBeenCalledWith({
      _id: "job-id",
      leaseToken: LEASE,
    });
  });

  it("claims due work atomically and removes a successfully deleted job", async () => {
    const model = modelDouble();
    const job = jobFor();
    model.findOneAndUpdate
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(null);
    const unlink = vi.fn().mockResolvedValue(undefined);
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced: vi.fn().mockResolvedValue(false),
      uploadRoot: () => "/srv/uploads",
    });

    const results = await service.processPending(2);

    expect(results).toMatchObject([{ outcome: "deleted" }]);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        nextAttemptAt: { $lte: NOW },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ leaseToken: LEASE }),
      }),
      expect.objectContaining({ new: true, select: "+filename" }),
    );
    expect(model.deleteOne).toHaveBeenCalledOnce();
  });

  it("maps an image upload reference to the images storage directory", async () => {
    const model = modelDouble();
    const parsed = canonicalizeLocalUploadReference(
      "/uploads/images/flyer.webp?revision=4#preview",
      "images",
    );
    expect(parsed).not.toBeNull();
    const target = normalizeFileCleanupTarget(parsed!);
    const job = {
      _id: "image-job-id",
      ...target,
      attemptCount: 0,
      nextAttemptAt: NOW,
    };
    model.findOneAndUpdate.mockResolvedValue(job);
    const unlink = vi.fn().mockResolvedValue(undefined);
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced: vi.fn().mockResolvedValue(false),
      uploadRoot: () => "/srv/uploads",
    });

    const [result] = await service.processTargets([target]);

    expect(result?.outcome).toBe("deleted");
    expect(unlink).toHaveBeenCalledWith("/srv/uploads/images/flyer.webp");
  });

  it("keeps a shared asset queued and never unlinks while it remains referenced", async () => {
    const model = modelDouble();
    const job = jobFor("shared.jpg");
    model.findOneAndUpdate.mockResolvedValue(job);
    const unlink = vi.fn().mockResolvedValue(undefined);
    const isReferenced = vi.fn().mockResolvedValue(true);
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced,
      uploadRoot: () => "/srv/uploads",
      baseRetryMs: 1_000,
      maxRetryMs: 10_000,
    });

    const [result] = await service.processTargets([job]);

    expect(result?.outcome).toBe("still_referenced");
    expect(isReferenced).toHaveBeenCalledWith(
      expect.objectContaining({
        jobKey: job.jobKey,
        storageArea: "avatars",
        filename: "shared.jpg",
      }),
    );
    expect(unlink).not.toHaveBeenCalled();
    expect(model.deleteOne).not.toHaveBeenCalled();
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: "job-id", leaseToken: LEASE },
      {
        $set: {
          nextAttemptAt: new Date(NOW.getTime() + 1_000),
          lastErrorCode: "STILL_REFERENCED",
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: NOW,
        },
        $inc: { attemptCount: 1 },
      },
      { runValidators: true },
    );
  });

  it("fails closed and retries when the authoritative reference check fails", async () => {
    const model = modelDouble();
    const job = jobFor("reference-check.jpg");
    model.findOneAndUpdate.mockResolvedValue(job);
    const unlink = vi.fn().mockResolvedValue(undefined);
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("database unavailable"), {
          code: "ETIMEDOUT",
        })),
      uploadRoot: () => "/srv/uploads",
      baseRetryMs: 1_000,
      maxRetryMs: 10_000,
    });

    const [result] = await service.processTargets([job]);

    expect(result?.outcome).toBe("retry_scheduled");
    expect(unlink).not.toHaveBeenCalled();
    expect(model.deleteOne).not.toHaveBeenCalled();
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: "job-id", leaseToken: LEASE },
      expect.objectContaining({
        $set: expect.objectContaining({
          lastErrorCode: "ETIMEDOUT",
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      }),
      { runValidators: true },
    );
  });

  it("uses surviving user avatars as the default authoritative reference guard", async () => {
    const model = modelDouble();
    const job = jobFor("shared-user.jpg");
    model.findOneAndUpdate.mockResolvedValue(job);
    vi.spyOn(User, "find").mockReturnValue({
      lean: vi.fn(() => ({
        exec: vi.fn().mockResolvedValue([
          { avatar: "/uploads/avatars/shared-user.jpg?revision=2" },
        ]),
      })),
    } as never);
    const unlink = vi.fn().mockResolvedValue(undefined);
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      uploadRoot: () => "/srv/uploads",
    });

    const [result] = await service.processTargets([job]);

    expect(result?.outcome).toBe("still_referenced");
    expect(unlink).not.toHaveBeenCalled();
    expect(User.find).toHaveBeenCalledWith(
      { avatar: { $type: "string" } },
      { _id: 0, avatar: 1 },
    );
  });

  it.each([
    {
      label: "Event.flyerUrl images",
      storageArea: "images" as const,
      events: [{ flyerUrl: "/uploads/images/shared-flyer.jpg?revision=1" }],
      programs: [],
    },
    {
      label: "Event.secondaryFlyerUrl legacy events",
      storageArea: "events" as const,
      events: [
        {
          secondaryFlyerUrl:
            "/uploads/events/shared-flyer.jpg#secondary-preview",
        },
      ],
      programs: [],
    },
    {
      label: "Program.flyerUrl images",
      storageArea: "images" as const,
      events: [],
      programs: [{ flyerUrl: "/uploads/images/shared-flyer.jpg#program" }],
    },
  ])(
    "uses surviving $label as an authoritative reference",
    async ({ storageArea, events, programs }) => {
      const model = modelDouble();
      const job = jobFor("shared-flyer.jpg", storageArea);
      model.findOneAndUpdate.mockResolvedValue(job);
      vi.spyOn(Event, "find").mockReturnValue({
        lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(events) })),
      } as never);
      vi.spyOn(Program, "find").mockReturnValue({
        lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(programs) })),
      } as never);
      const unlink = vi.fn().mockResolvedValue(undefined);
      const service = new FileCleanupService({
        model: model as never,
        now: () => NOW,
        createLeaseToken: () => LEASE,
        unlink,
        uploadRoot: () => "/srv/uploads",
      });

      const [result] = await service.processTargets([job]);

      expect(result?.outcome).toBe("still_referenced");
      expect(unlink).not.toHaveBeenCalled();
      expect(Event.find).toHaveBeenCalledWith(
        {
          $or: [
            { flyerUrl: { $type: "string" } },
            { secondaryFlyerUrl: { $type: "string" } },
          ],
        },
        { _id: 0, flyerUrl: 1, secondaryFlyerUrl: 1 },
      );
      expect(Program.find).toHaveBeenCalledWith(
        { flyerUrl: { $type: "string" } },
        { _id: 0, flyerUrl: 1 },
      );
    },
  );

  it("maps a legacy event upload to the events storage directory", async () => {
    const model = modelDouble();
    const target = normalizeFileCleanupTarget({
      storageArea: "events",
      filename: "legacy-flyer.jpg",
    });
    model.findOneAndUpdate.mockResolvedValue({
      _id: "legacy-event-job",
      ...target,
      attemptCount: 0,
      nextAttemptAt: NOW,
    });
    const unlink = vi.fn().mockResolvedValue(undefined);
    const service = new FileCleanupService({
      model: model as never,
      now: () => NOW,
      createLeaseToken: () => LEASE,
      unlink,
      isReferenced: vi.fn().mockResolvedValue(false),
      uploadRoot: () => "/srv/uploads",
    });

    const [result] = await service.processTargets([target]);

    expect(result?.outcome).toBe("deleted");
    expect(unlink).toHaveBeenCalledWith(
      "/srv/uploads/events/legacy-flyer.jpg",
    );
  });
});
