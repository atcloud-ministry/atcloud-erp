import { describe, expect, it } from "vitest";
import { MONGODB_CONNECTION_OPTIONS } from "../../../src/config/database";

describe("MongoDB connection configuration", () => {
  it("uses the approved Atlas Flex connection cap", () => {
    expect(MONGODB_CONNECTION_OPTIONS).toEqual({
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 45_000,
      bufferCommands: false,
    });
    expect(Object.isFrozen(MONGODB_CONNECTION_OPTIONS)).toBe(true);
  });
});
