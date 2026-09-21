import { useEffect, useMemo, useState } from "react";
import {
  initialsFor,
  safeAvatarUrl,
} from "../directory/DirectoryAvatar";

export default function ChatAvatar({
  avatar,
  displayName,
  size = "md",
}: {
  avatar: string | null;
  displayName: string;
  size?: "sm" | "md";
}) {
  const source = useMemo(() => safeAvatarUrl(avatar), [avatar]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  const sizeClass = size === "sm" ? "h-8 w-8 text-xs" : "h-11 w-11 text-sm";

  if (!source || failed) {
    return (
      <span
        aria-label={`${displayName} avatar`}
        className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-blue-100 font-semibold text-blue-700`}
        role="img"
      >
        {initialsFor(displayName)}
      </span>
    );
  }

  return (
    <img
      alt={`${displayName} avatar`}
      className={`${sizeClass} shrink-0 rounded-full object-cover`}
      loading="lazy"
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={source}
    />
  );
}
