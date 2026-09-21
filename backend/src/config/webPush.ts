import { createECDH, createHash, timingSafeEqual } from "node:crypto";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export interface WebPushEnvironment {
  readonly WEB_PUSH_ENABLED?: string;
  readonly VAPID_SUBJECT?: string;
  readonly VAPID_PUBLIC_KEY?: string;
  readonly VAPID_PRIVATE_KEY?: string;
}

export type WebPushConfiguration =
  | Readonly<{ enabled: false; publicKey: null }>
  | Readonly<{
      enabled: true;
      subject: string;
      publicKey: string;
      privateKey: string;
    }>;

export class WebPushConfigurationError extends Error {
  readonly name = "WebPushConfigurationError";
  readonly code = "WEB_PUSH_CONFIGURATION_INVALID";

  constructor() {
    // Never include secret values, parser errors, or key fragments here.
    super("Web Push is enabled but its VAPID configuration is invalid.");
  }
}

function currentEnvironment(): WebPushEnvironment {
  return {
    WEB_PUSH_ENABLED: process.env.WEB_PUSH_ENABLED,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  };
}

function validSubject(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" && Boolean(url.hostname)) ||
      (url.protocol === "mailto:" && /^mailto:[^@\s]+@[^@\s]+$/i.test(value))
    );
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    return Buffer.from(value.replace(/=+$/u, ""), "base64url");
  } catch {
    return null;
  }
}

function normalizeBase64Url(value: string): string {
  return BASE64URL_PATTERN.test(value) ? value.replace(/=+$/u, "") : value;
}

function validKeyPair(publicValue: string, privateValue: string): boolean {
  const publicKey = decodeBase64Url(publicValue);
  const privateKey = decodeBase64Url(privateValue);
  if (
    publicKey?.length !== 65 ||
    publicKey[0] !== 4 ||
    privateKey?.length !== 32
  ) {
    return false;
  }
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateKey);
    return timingSafeEqual(ecdh.getPublicKey(), publicKey);
  } catch {
    return false;
  }
}

/**
 * Reads secrets only at call time, after dotenv is loaded. Disabled is the
 * safe default. Opting in with an incomplete/invalid secret set fails closed.
 */
export function readWebPushConfiguration(
  env: WebPushEnvironment = currentEnvironment(),
): WebPushConfiguration {
  if (env.WEB_PUSH_ENABLED !== "true") {
    return Object.freeze({ enabled: false as const, publicKey: null });
  }
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  const publicKey = normalizeBase64Url(env.VAPID_PUBLIC_KEY?.trim() ?? "");
  const privateKey = normalizeBase64Url(env.VAPID_PRIVATE_KEY?.trim() ?? "");
  if (
    !validSubject(subject) ||
    !validKeyPair(publicKey, privateKey)
  ) {
    throw new WebPushConfigurationError();
  }
  return Object.freeze({
    enabled: true as const,
    subject,
    publicKey,
    privateKey,
  });
}

export function assertWebPushConfiguration(): void {
  readWebPushConfiguration();
}

/** Non-secret identity used only to keep subscriptions bound to one VAPID key. */
export function webPushPublicKeyId(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex");
}
