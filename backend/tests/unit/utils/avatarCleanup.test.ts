import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueStandalone, processTargets, log } = vi.hoisted(() => ({
  enqueueStandalone: vi.fn(),
  processTargets: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../../src/services/LoggerService", () => ({
  createLogger: vi.fn(() => log),
  Logger: {
    getInstance: vi.fn(() => ({ child: vi.fn(() => log) })),
  },
}));
vi.mock(
  "../../../src/services/privacy/FileCleanupService",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/services/privacy/FileCleanupService")
      >();
    return {
      ...actual,
      fileCleanupService: { enqueueStandalone, processTargets },
    };
  },
);

import {
  cleanupOldAvatar,
  deleteOldAvatarFile,
  isUploadedAvatar,
} from "../../../src/utils/avatarCleanup";

const QUEUED_AVATAR = {
  jobKey: "a".repeat(64),
  storageArea: "avatars" as const,
  filename: "old.jpg",
};

describe("avatarCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BACKEND_URL", "https://app.test/api");
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    vi.stubEnv("API_BASE_URL", "");
    enqueueStandalone.mockResolvedValue([QUEUED_AVATAR]);
    processTargets.mockResolvedValue([
      { target: QUEUED_AVATAR, outcome: "deleted" },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["/uploads/avatars/user.jpg", true],
    ["https://app.test/uploads/avatars/user.jpg", true],
    ["https://external.test/uploads/avatars/user.jpg", false],
    ["/default-avatar-male.jpg", false],
    [undefined, false],
    [null, false],
  ])("identifies approved local avatars", (value, expected) => {
    expect(isUploadedAvatar(value)).toBe(expected);
  });

  it("does not queue default or untrusted avatars", async () => {
    await expect(deleteOldAvatarFile("/default-avatar-male.jpg")).resolves.toBe(
      false,
    );
    await expect(
      deleteOldAvatarFile(
        "https://external.test/uploads/avatars/do-not-delete.jpg",
      ),
    ).resolves.toBe(false);
    expect(enqueueStandalone).not.toHaveBeenCalled();
  });

  it("queues an old avatar durably and uses the guarded processor", async () => {
    await expect(
      deleteOldAvatarFile(
        "https://app.test/uploads/avatars/old.jpg?version=2",
      ),
    ).resolves.toBe(true);

    expect(enqueueStandalone).toHaveBeenCalledWith([
      { storageArea: "avatars", filename: "old.jpg" },
    ]);
    expect(processTargets).toHaveBeenCalledWith([QUEUED_AVATAR]);
  });

  it("queues a relative legacy avatar path through the same durable path", async () => {
    await expect(
      deleteOldAvatarFile("/uploads/avatars/old.jpg#cached"),
    ).resolves.toBe(true);

    expect(enqueueStandalone).toHaveBeenCalledWith([
      { storageArea: "avatars", filename: "old.jpg" },
    ]);
  });

  it("reports an already-absent avatar without direct filesystem access", async () => {
    processTargets.mockResolvedValue([
      { target: QUEUED_AVATAR, outcome: "already_absent" },
    ]);

    await expect(
      deleteOldAvatarFile("/uploads/avatars/old.jpg"),
    ).resolves.toBe(false);
    expect(enqueueStandalone).toHaveBeenCalledOnce();
    expect(processTargets).toHaveBeenCalledOnce();
  });

  it("leaves failed or referenced cleanup in the durable queue", async () => {
    processTargets.mockResolvedValue([
      { target: QUEUED_AVATAR, outcome: "still_referenced" },
    ]);

    await expect(
      deleteOldAvatarFile("/uploads/avatars/old.jpg"),
    ).resolves.toBe(false);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("uses the same durable path through cleanupOldAvatar without logging the old URL", async () => {
    const oldUrl = "/uploads/avatars/old.jpg?private=reference";

    await expect(cleanupOldAvatar("user-1", oldUrl)).resolves.toBe(true);

    expect(enqueueStandalone).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      "Cleaning up old avatar for user",
      undefined,
      { userId: "user-1" },
    );
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(oldUrl);
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain(oldUrl);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(oldUrl);
  });
});
