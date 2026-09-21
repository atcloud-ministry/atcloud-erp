import { useEffect, useMemo, useState } from "react";

function safeAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0])[0] ?? "?";
  const last =
    parts.length > 1
      ? (Array.from(parts[parts.length - 1] ?? "")[0] ?? "")
      : "";
  return `${first}${last}`.toLocaleUpperCase();
}

export default function DirectoryAvatar({
  avatar,
  displayName,
  size = "card",
}: {
  avatar: string | null;
  displayName: string;
  size?: "card" | "detail";
}) {
  const source = useMemo(() => safeAvatarUrl(avatar), [avatar]);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [source]);

  const sizeClass = size === "detail" ? "h-24 w-24 text-2xl" : "h-16 w-16 text-lg";
  if (!source || failed) {
    return (
      <div
        aria-label={`${displayName} avatar`}
        className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-blue-100 font-semibold text-blue-700`}
        role="img"
      >
        {initialsFor(displayName)}
      </div>
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

export { initialsFor, safeAvatarUrl };
