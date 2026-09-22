import { createLogger } from "../services/LoggerService";
import {
  canonicalizeLocalUploadReference,
  fileCleanupService,
} from "../services/privacy/FileCleanupService";

const log = createLogger("AvatarCleanup");

/**
 * Check if an avatar URL maps to an approved local upload target.
 */
export const isUploadedAvatar = (
  avatarUrl: string | null | undefined,
): boolean =>
  canonicalizeLocalUploadReference(avatarUrl, "avatars") !== null;

/**
 * Durably queue an old avatar and attempt guarded cleanup immediately.
 */
export const deleteOldAvatarFile = async (
  avatarUrl: string | null | undefined,
): Promise<boolean> => {
  const target = canonicalizeLocalUploadReference(avatarUrl, "avatars");
  if (!target) {
    try {
      log.debug("Skip deleting avatar: not an approved local upload", undefined, {
        hasUrl: Boolean(avatarUrl),
      });
    } catch {}
    return false;
  }

  try {
    const queued = await fileCleanupService.enqueueStandalone([target]);
    if (queued.length === 0) return false;
    const [result] = await fileCleanupService.processTargets(queued);
    log.info("Old avatar cleanup processed", undefined, {
      jobKey: queued[0]?.jobKey,
      outcome: result?.outcome ?? "not_processed",
    });
    return result?.outcome === "deleted";
  } catch (error) {
    log.error("Error scheduling old avatar cleanup", error as Error);
    return false;
  }
};

/**
 * Cleanup old avatar file for a user.
 */
export const cleanupOldAvatar = async (
  userId: string,
  oldAvatarUrl: string | null | undefined,
): Promise<boolean> => {
  if (!isUploadedAvatar(oldAvatarUrl)) {
    try {
      log.debug("No cleanup needed for avatar", undefined, {
        userId,
        hasUrl: Boolean(oldAvatarUrl),
      });
    } catch {}
    return false;
  }

  try {
    log.info("Cleaning up old avatar for user", undefined, { userId });
    return await deleteOldAvatarFile(oldAvatarUrl);
  } catch (error) {
    log.error(
      "Error cleaning up old avatar for user",
      error as Error,
      undefined,
      { userId },
    );
    return false;
  }
};
