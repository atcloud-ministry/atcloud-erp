const MAX_INTERNAL_REDIRECT_LENGTH = 4_096;

function hasUnsafeRedirectCharacter(value: string): boolean {
  return (
    value.includes("\\") ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

export function isSafeInternalRedirectPath(
  value: string | null | undefined,
): value is string {
  if (
    !value ||
    value.length > MAX_INTERNAL_REDIRECT_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    hasUnsafeRedirectCharacter(value)
  ) {
    return false;
  }

  try {
    const base = new URL("https://atcloud.invalid");
    const parsed = new URL(value, base);
    return parsed.origin === base.origin && parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
}

export function getRedirectParam(search: string): string | null {
  try {
    const params = new URLSearchParams(
      search.startsWith("?") ? search : `?${search}`,
    );
    const redirect = params.get("redirect");
    return isSafeInternalRedirectPath(redirect) ? redirect : null;
  } catch {
    return null;
  }
}

export function getPathWithSearch(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  return `${location.pathname}${location.search || ""}${location.hash || ""}`;
}

export function getSafeLocationRedirectPath(location: {
  pathname?: string;
  search?: string;
  hash?: string;
} | null | undefined): string | null {
  if (!location || typeof location.pathname !== "string") return null;
  const target = getPathWithSearch({
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  });
  return isSafeInternalRedirectPath(target) ? target : null;
}

export function consumeStoredLoginRedirect(
  storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
): string | null {
  const candidate = storage.getItem("returnUrl");
  if (candidate !== null) storage.removeItem("returnUrl");
  return isSafeInternalRedirectPath(candidate) ? candidate : null;
}

export function resolvePostLoginRedirect(input: {
  readonly search?: string;
  readonly from?: {
    readonly pathname?: string;
    readonly search?: string;
    readonly hash?: string;
  } | null;
  readonly storedReturnUrl?: string | null;
}): string {
  return (
    getRedirectParam(input.search || "") ??
    getSafeLocationRedirectPath(input.from) ??
    (isSafeInternalRedirectPath(input.storedReturnUrl)
      ? input.storedReturnUrl
      : null) ??
    "/dashboard"
  );
}

export function buildLoginRedirectUrl(targetPath: string): string {
  if (!isSafeInternalRedirectPath(targetPath)) {
    return "/login";
  }

  return `/login?redirect=${encodeURIComponent(targetPath)}`;
}
