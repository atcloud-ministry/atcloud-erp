/**
 * Utility functions for handling user avatars
 */

/**
 * Utility functions for handling user avatars
 */

export const getAvatarUrl = (
  customAvatar: string | null,
  gender: "male" | "female"
): string => {
  // Check if customAvatar is actually a default avatar (bad data from backend)
  const isDefaultAvatar =
    customAvatar === "/default-avatar-male.jpg" ||
    customAvatar === "/default-avatar-female.jpg";

  // If user has a real custom avatar (not a default one), use it
  if (customAvatar && !isDefaultAvatar) {
    // In production, preserve absolute URLs from backend
    // In development, convert to relative path for proxy compatibility
    if (
      customAvatar.startsWith("http://") ||
      customAvatar.startsWith("https://")
    ) {
      try {
        // Deployed frontends live on a different origin from the backend/static uploads.
        // Preserve absolute avatar URLs so staging and production load from the API host.
        if (import.meta.env.PROD) {
          return customAvatar;
        }
        // In development, extract the path part from full URL (e.g., "/uploads/avatars/...")
        const url = new URL(customAvatar);
        return url.pathname + url.search; // Include query params (cache-busting timestamp)
      } catch (error) {
        // If URL parsing fails, return as-is (likely already a relative path)
        console.warn("Failed to parse avatar URL:", customAvatar, error);
        return customAvatar;
      }
    }
    // Already a relative path, use as is
    return customAvatar;
  }

  // Otherwise, use gender-specific default avatar based on actual gender
  return gender === "male"
    ? "/default-avatar-male.jpg"
    : "/default-avatar-female.jpg";
};

/**
 * Resolve an avatar URL without adding a render-time cache key.
 *
 * Uploaded avatars already have unique filenames and the upload response may
 * include a stable version query parameter. Keeping that URL unchanged lets
 * the browser cache the image while a newly uploaded avatar still receives a
 * new URL. The legacy function name is retained for existing callers.
 */
export const getAvatarUrlWithCacheBust = (
  customAvatar: string | null,
  gender: "male" | "female"
): string => {
  return getAvatarUrl(customAvatar, gender);
};

export const getAvatarAlt = (
  firstName: string,
  lastName: string,
  hasCustomAvatar: boolean
): string => {
  const fullName = `${firstName} ${lastName}`;
  return hasCustomAvatar ? `${fullName} avatar` : `${fullName} default avatar`;
};
