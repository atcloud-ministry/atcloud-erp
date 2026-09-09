import { describe, expect, it } from "vitest";
import {
  isMongoTransactionCapabilityRequired,
  isNotificationOutboxEnabled,
} from "../../../src/config/reliability";

describe("reliability configuration", () => {
  it("requires MongoDB transaction capability by default in production", () => {
    expect(
      isMongoTransactionCapabilityRequired({ NODE_ENV: "production" }),
    ).toBe(true);
    expect(
      isMongoTransactionCapabilityRequired({
        NODE_ENV: "production",
        MONGO_TRANSACTIONS_REQUIRED: "false",
      }),
    ).toBe(true);
  });

  it("lets development explicitly enable the transaction startup guard", () => {
    expect(
      isMongoTransactionCapabilityRequired({ NODE_ENV: "development" }),
    ).toBe(false);
    expect(
      isMongoTransactionCapabilityRequired({
        NODE_ENV: "development",
        MONGO_TRANSACTIONS_REQUIRED: "true",
      }),
    ).toBe(true);
  });

  it("starts the outbox worker only with an explicit non-test opt-in", () => {
    expect(isNotificationOutboxEnabled({ NODE_ENV: "production" })).toBe(
      false,
    );
    expect(
      isNotificationOutboxEnabled({
        NODE_ENV: "production",
        NOTIFICATION_OUTBOX_ENABLED: "true",
      }),
    ).toBe(true);
    expect(
      isNotificationOutboxEnabled({
        NODE_ENV: "test",
        NOTIFICATION_OUTBOX_ENABLED: "true",
      }),
    ).toBe(false);
  });
});
