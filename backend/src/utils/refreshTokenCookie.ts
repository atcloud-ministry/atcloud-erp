import type { CookieOptions } from "express";

export const REFRESH_TOKEN_COOKIE_NAME = "refreshToken" as const;
export const REFRESH_TOKEN_COOKIE_PATH = "/api/auth" as const;

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: REFRESH_TOKEN_COOKIE_PATH,
  };
}

export function refreshTokenCookieOptions(maxAge: number): CookieOptions {
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) {
    throw new Error("Refresh-token cookie maxAge is invalid.");
  }
  return { ...baseOptions(), maxAge };
}

export function refreshTokenClearCookieOptions(): CookieOptions {
  return baseOptions();
}
