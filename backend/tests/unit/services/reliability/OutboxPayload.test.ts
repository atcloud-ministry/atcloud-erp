import { describe, expect, it } from "vitest";
import {
  InvalidOutboxPayloadError,
  hashOutboxPayload,
  normalizeOutboxPayload,
} from "../../../../src/services/reliability/OutboxPayload";

describe("OutboxPayload", () => {
  it("sorts keys recursively and produces a stable hash", () => {
    const first = normalizeOutboxPayload({ z: 1, nested: { b: 2, a: 1 } });
    const second = normalizeOutboxPayload({ nested: { a: 1, b: 2 }, z: 1 });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(hashOutboxPayload(1, first)).toBe(hashOutboxPayload(1, second));
    expect(hashOutboxPayload(2, first)).not.toBe(hashOutboxPayload(1, first));
  });

  it.each([
    undefined,
    [],
    new Date(),
    { value: Number.NaN },
    { "unsafe.path": true },
    { $unsafe: true },
    { value: undefined },
  ])("rejects non-JSON or unsafe input %#", (payload) => {
    expect(() => normalizeOutboxPayload(payload)).toThrow(
      InvalidOutboxPayloadError,
    );
  });

  it("rejects cycles without rejecting a reused non-cyclic object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeOutboxPayload(cyclic)).toThrow("cyclic");

    const child = { safe: true };
    expect(normalizeOutboxPayload({ first: child, second: child })).toEqual({
      first: { safe: true },
      second: { safe: true },
    });
  });
});
