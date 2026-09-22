import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseNotificationPreferenceBody,
  parsePushSubscriptionBody,
  PushNotificationValidationError,
} from "../../../src/contracts/pushNotifications";
import {
  readWebPushConfiguration,
  WebPushConfigurationError,
} from "../../../src/config/webPush";

const ECDH = createECDH("prime256v1");
ECDH.generateKeys();
const PUBLIC_KEY = ECDH.getPublicKey().toString("base64url");
const PRIVATE_KEY = ECDH.getPrivateKey().toString("base64url");
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 3)]).toString(
  "base64url",
);
const AUTH = Buffer.alloc(16, 4).toString("base64url");

describe("push notification contracts", () => {
  it("accepts exact browser subscription data and supported vendor endpoints", () => {
    expect(
      parsePushSubscriptionBody({
        installationId: "install:ios:1",
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/private-id",
          expirationTime: null,
          keys: { p256dh: P256DH, auth: AUTH },
        },
      }),
    ).toEqual({
      installationId: "install:ios:1",
      endpoint: "https://fcm.googleapis.com/fcm/send/private-id",
      expirationTime: null,
      keys: { p256dh: P256DH, auth: AUTH },
    });
  });

  it("rejects SSRF endpoints, credentials, ports, and unknown fields", () => {
    const body = (endpoint: string) => ({
      installationId: "install-1",
      subscription: {
        endpoint,
        expirationTime: null,
        keys: { p256dh: P256DH, auth: AUTH },
      },
    });
    for (const endpoint of [
      "https://127.0.0.1/push",
      "https://localhost/push",
      "https://user:pass@fcm.googleapis.com/push",
      "https://fcm.googleapis.com:8443/push",
      "https://evil.example/push",
    ]) {
      expect(() => parsePushSubscriptionBody(body(endpoint))).toThrow(
        PushNotificationValidationError,
      );
    }
    expect(() =>
      parsePushSubscriptionBody({ ...body("https://web.push.apple.com/Q"), extra: true }),
    ).toThrow(PushNotificationValidationError);
  });

  it("uses exact boolean preference patches", () => {
    expect(parseNotificationPreferenceBody({ pushEnabled: false })).toEqual({
      pushEnabled: false,
    });
    expect(() => parseNotificationPreferenceBody({})).toThrow(
      PushNotificationValidationError,
    );
    expect(() =>
      parseNotificationPreferenceBody({ emailEnabled: "yes" }),
    ).toThrow(PushNotificationValidationError);
  });

  it("defaults disabled and fails closed without a complete VAPID secret set", () => {
    expect(readWebPushConfiguration({})).toEqual({
      enabled: false,
      publicKey: null,
    });
    expect(() =>
      readWebPushConfiguration({ WEB_PUSH_ENABLED: "true" }),
    ).toThrow(WebPushConfigurationError);
    expect(
      readWebPushConfiguration({
        WEB_PUSH_ENABLED: "true",
        VAPID_SUBJECT: "mailto:security@example.org",
        VAPID_PUBLIC_KEY: PUBLIC_KEY,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toEqual({
      enabled: true,
      subject: "mailto:security@example.org",
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    });
  });

  it("normalizes optional base64url padding before passing VAPID keys to web-push", () => {
    expect(
      readWebPushConfiguration({
        WEB_PUSH_ENABLED: "true",
        VAPID_SUBJECT: "mailto:security@example.org",
        VAPID_PUBLIC_KEY: `${PUBLIC_KEY}=`,
        VAPID_PRIVATE_KEY: `${PRIVATE_KEY}=`,
      }),
    ).toEqual({
      enabled: true,
      subject: "mailto:security@example.org",
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    });
    expect(() =>
      readWebPushConfiguration({
        WEB_PUSH_ENABLED: "true",
        VAPID_SUBJECT: "mailto:security@example.org",
        VAPID_PUBLIC_KEY: `${PUBLIC_KEY}===`,
        VAPID_PRIVATE_KEY: PRIVATE_KEY,
      }),
    ).toThrow(WebPushConfigurationError);
  });
});
