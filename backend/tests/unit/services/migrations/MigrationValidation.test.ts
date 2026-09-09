import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_MIGRATION_CHECKPOINT_ARRAY_ITEMS,
  MAX_MIGRATION_CHECKPOINT_BYTES,
  MAX_MIGRATION_CHECKPOINT_DEPTH,
  MAX_MIGRATION_CHECKPOINT_KEYS,
  MAX_MIGRATION_CHECKPOINT_NODES,
  MAX_MIGRATION_CHECKPOINT_STRING_LENGTH,
  type JsonValue,
  type MigrationCounts,
  type MigrationDefinition,
} from "../../../../src/migrations/types";
import { MigrationUsageError } from "../../../../src/services/migrations/MigrationErrors";
import {
  ZERO_MIGRATION_COUNTS,
  addMigrationCounts,
  cloneMigrationCheckpoint,
  normalizeMigrationBatchResult,
  normalizeMigrationCounts,
  normalizeMigrationPlan,
  normalizeMigrationVerification,
  sanitizeMigrationFailure,
} from "../../../../src/services/migrations/MigrationValidation";

const counts = (overrides: Partial<MigrationCounts> = {}): MigrationCounts => ({
  examined: 10,
  matched: 8,
  modified: 6,
  skipped: 2,
  errors: 0,
  ...overrides,
});

function expectUsageError(operation: () => unknown, message: RegExp): void {
  expect(operation).toThrowError(MigrationUsageError);
  expect(operation).toThrowError(message);
}

describe("MigrationValidation", () => {
  describe("migration counts", () => {
    it("normalizes valid non-negative safe integer counts", () => {
      const input = counts();

      const normalized = normalizeMigrationCounts(input);

      expect(normalized).toEqual(input);
      expect(normalized).not.toBe(input);
      expect(ZERO_MIGRATION_COUNTS).toEqual({
        examined: 0,
        matched: 0,
        modified: 0,
        skipped: 0,
        errors: 0,
      });
      expect(Object.isFrozen(ZERO_MIGRATION_COUNTS)).toBe(true);
    });

    it.each([null, undefined, [], "counts", 1])(
      "rejects a non-object count payload %#",
      (value) => {
        expectUsageError(
          () => normalizeMigrationCounts(value),
          /counts must be an object/i,
        );
      },
    );

    it.each([
      ["examined", -1],
      ["matched", 0.5],
      ["modified", Number.POSITIVE_INFINITY],
      ["skipped", Number.MAX_SAFE_INTEGER + 1],
      ["errors", "0"],
    ] as const)("rejects an invalid %s count", (field, value) => {
      expectUsageError(
        () => normalizeMigrationCounts({ ...counts(), [field]: value }),
        new RegExp(`${field}.*non-negative safe integer`, "i"),
      );
    });

    it.each([
      ["matched", counts({ examined: 4, matched: 5 }), /matched.*examined/i],
      ["modified", counts({ matched: 4, modified: 5 }), /modified.*matched/i],
      ["skipped", counts({ examined: 4, matched: 4, modified: 4, skipped: 5 }), /skipped.*examined/i],
      ["errors", counts({ examined: 4, matched: 4, modified: 4, errors: 5 }), /error.*examined/i],
    ] as const)("rejects the invalid %s relationship", (_field, value, message) => {
      expectUsageError(() => normalizeMigrationCounts(value), message);
    });

    it("adds count sets without mutating either operand", () => {
      const total = counts();
      const delta = counts({ examined: 4, matched: 3, modified: 2, skipped: 1 });

      expect(addMigrationCounts(total, delta)).toEqual({
        examined: 14,
        matched: 11,
        modified: 8,
        skipped: 3,
        errors: 0,
      });
      expect(total).toEqual(counts());
      expect(delta).toEqual(
        counts({ examined: 4, matched: 3, modified: 2, skipped: 1 }),
      );
    });

    it.each([
      "examined",
      "matched",
      "modified",
      "skipped",
      "errors",
    ] as const)("rejects %s count overflow", (field) => {
      const maximum = { ...ZERO_MIGRATION_COUNTS, [field]: Number.MAX_SAFE_INTEGER };
      const one = { ...ZERO_MIGRATION_COUNTS, [field]: 1 };

      expectUsageError(
        () => addMigrationCounts(maximum, one),
        new RegExp(`${field}.*overflowed`, "i"),
      );
    });
  });

  describe("migration checkpoints", () => {
    it("normalizes absent checkpoints to null", () => {
      expect(cloneMigrationCheckpoint(null)).toBeNull();
      expect(cloneMigrationCheckpoint(undefined)).toBeNull();
    });

    it("returns an isolated deep JSON clone", () => {
      const input = {
        cursor: "user-10",
        phase: 2,
        nested: { flags: [true, false, null] },
      };

      const cloned = cloneMigrationCheckpoint(input) as typeof input;
      input.cursor = "changed";
      input.nested.flags[0] = false;

      expect(cloned).toEqual({
        cursor: "user-10",
        phase: 2,
        nested: { flags: [true, false, null] },
      });
      expect(cloned).not.toBe(input);
      expect(cloned.nested).not.toBe(input.nested);
    });

    it.each([[], "cursor", 12, true])(
      "rejects a non-object checkpoint root %#",
      (value) => {
        expectUsageError(
          () => cloneMigrationCheckpoint(value),
          /JSON object or null/i,
        );
      },
    );

    it("rejects circular checkpoint graphs", () => {
      const checkpoint: Record<string, unknown> = { cursor: "one" };
      checkpoint.self = checkpoint;

      expectUsageError(
        () => cloneMigrationCheckpoint(checkpoint),
        /circular reference/i,
      );
    });

    it.each(["__proto__", "constructor", "prototype"])(
      "rejects the unsafe checkpoint key %s",
      (key) => {
        const checkpoint = JSON.parse(`{"${key}":"unsafe"}`) as unknown;

        expectUsageError(
          () => cloneMigrationCheckpoint(checkpoint),
          /invalid key/i,
        );
      },
    );

    it.each(["$where", "contains.dot", "1startsWithDigit", "x".repeat(65)])(
      "rejects a checkpoint key outside the safe key grammar: %s",
      (key) => {
        const checkpoint = Object.create(null) as Record<string, unknown>;
        checkpoint[key] = "unsafe";

        expectUsageError(
          () => cloneMigrationCheckpoint(checkpoint),
          /invalid key/i,
        );
      },
    );

    it("rejects every bounded-checkpoint limit when exceeded", () => {
      const tooManyKeys = Object.fromEntries(
        Array.from(
          { length: MAX_MIGRATION_CHECKPOINT_KEYS + 1 },
          (_, index) => [`key${index}`, index],
        ),
      );
      const tooManyArrayItems = {
        items: Array.from(
          { length: MAX_MIGRATION_CHECKPOINT_ARRAY_ITEMS + 1 },
          () => null,
        ),
      };
      const tooLongString = {
        value: "x".repeat(MAX_MIGRATION_CHECKPOINT_STRING_LENGTH + 1),
      };
      const nodeGroupCount = Math.ceil(
        MAX_MIGRATION_CHECKPOINT_NODES /
          MAX_MIGRATION_CHECKPOINT_ARRAY_ITEMS,
      );
      const tooManyNodes = Object.fromEntries(
        Array.from({ length: nodeGroupCount }, (_, index) => [
          `group${index}`,
          Array.from(
            { length: MAX_MIGRATION_CHECKPOINT_ARRAY_ITEMS },
            () => [],
          ),
        ]),
      );
      let tooDeep: Record<string, unknown> = { cursor: "last" };
      for (let depth = 0; depth <= MAX_MIGRATION_CHECKPOINT_DEPTH; depth += 1) {
        tooDeep = { next: tooDeep };
      }
      const stringsNeeded =
        Math.ceil(
          MAX_MIGRATION_CHECKPOINT_BYTES /
            MAX_MIGRATION_CHECKPOINT_STRING_LENGTH,
        ) + 1;
      const tooLarge = Object.fromEntries(
        Array.from({ length: stringsNeeded }, (_, index) => [
          `value${index}`,
          "x".repeat(MAX_MIGRATION_CHECKPOINT_STRING_LENGTH),
        ]),
      );

      expectUsageError(
        () => cloneMigrationCheckpoint(tooManyKeys),
        /too many keys/i,
      );
      expectUsageError(
        () => cloneMigrationCheckpoint(tooManyArrayItems),
        /too many items/i,
      );
      expectUsageError(
        () => cloneMigrationCheckpoint(tooLongString),
        /string that is too long/i,
      );
      expectUsageError(
        () => cloneMigrationCheckpoint(tooManyNodes),
        /too many values/i,
      );
      expectUsageError(
        () => cloneMigrationCheckpoint(tooDeep),
        /maximum nesting depth/i,
      );
      expectUsageError(
        () => cloneMigrationCheckpoint(tooLarge),
        /maximum serialized size/i,
      );
    });

    it.each([
      [{ cursor: undefined }, /non-JSON undefined/i],
      [{ cursor: Number.NaN }, /non-finite number/i],
      [{ cursor: 1n }, /non-JSON bigint/i],
      [{ cursor: new Date() }, /non-plain object/i],
    ] as const)("rejects a non-JSON checkpoint value", (checkpoint, message) => {
      expectUsageError(() => cloneMigrationCheckpoint(checkpoint), message);
    });

    it("rejects accessor and non-enumerable checkpoint properties", () => {
      const accessor = {} as Record<string, unknown>;
      Object.defineProperty(accessor, "cursor", {
        enumerable: true,
        get: () => "secret",
      });
      const hidden = {} as Record<string, unknown>;
      Object.defineProperty(hidden, "cursor", {
        enumerable: false,
        value: "secret",
      });

      expectUsageError(
        () => cloneMigrationCheckpoint(accessor),
        /non-data property/i,
      );
      expectUsageError(
        () => cloneMigrationCheckpoint(hidden),
        /non-data property/i,
      );
    });

    it("clones a Proxy from captured descriptors without invoking value traps", () => {
      let valueReads = 0;
      const checkpoint = new Proxy(
        { cursor: "safe" },
        {
          get: (target, key, receiver) => {
            valueReads += 1;
            if (key === "cursor") {
              return "x".repeat(MAX_MIGRATION_CHECKPOINT_BYTES + 1);
            }
            return Reflect.get(target, key, receiver);
          },
        },
      );

      expect(cloneMigrationCheckpoint(checkpoint)).toEqual({ cursor: "safe" });
      expect(valueReads).toBe(0);
    });

    it("fails closed when a Proxy cannot be inspected safely", () => {
      const { proxy, revoke } = Proxy.revocable({ cursor: "safe" }, {});
      revoke();

      expectUsageError(
        () => cloneMigrationCheckpoint(proxy),
        /cannot be inspected safely/i,
      );
    });

    it("supports separate forward and rollback checkpoint types", () => {
      type ApplyCheckpoint = {
        readonly [key: string]: JsonValue;
        readonly applyCursor: string;
      };
      type RollbackCheckpoint = {
        readonly [key: string]: JsonValue;
        readonly rollbackCursor: string;
      };

      const definition: MigrationDefinition<
        ApplyCheckpoint,
        RollbackCheckpoint
      > = {
        id: "20260909_001_typed-checkpoints",
        description: "Exercise separate checkpoint types",
        checksum: "a".repeat(64),
        plan: async () => ({
          summary: "No changes required",
          counts: ZERO_MIGRATION_COUNTS,
          estimatedBatches: 0,
          warnings: [],
        }),
        up: async ({ checkpoint }) => ({
          done: true,
          checkpoint: checkpoint ?? { applyCursor: "complete" },
          counts: ZERO_MIGRATION_COUNTS,
        }),
        down: async ({ checkpoint, appliedCheckpoint }) => ({
          done: true,
          checkpoint: checkpoint ?? {
            rollbackCursor: appliedCheckpoint?.applyCursor ?? "complete",
          },
          counts: ZERO_MIGRATION_COUNTS,
        }),
        verify: async () => ({
          ok: true,
          summary: "Verification complete",
          counts: ZERO_MIGRATION_COUNTS,
        }),
      };

      expect(definition.id).toBe("20260909_001_typed-checkpoints");
    });
  });

  describe("migration batch results", () => {
    it("normalizes valid complete and incomplete results", () => {
      expect(
        normalizeMigrationBatchResult(
          {
            done: false,
            checkpoint: { cursor: "user-20" },
            counts: counts(),
          },
          { cursor: "user-10" },
        ),
      ).toEqual({
        done: false,
        checkpoint: { cursor: "user-20" },
        counts: counts(),
      });
      expect(
        normalizeMigrationBatchResult(
          { done: true, checkpoint: undefined, counts: counts() },
          { cursor: "user-20" },
        ),
      ).toEqual({ done: true, checkpoint: null, counts: counts() });
    });

    it.each([null, [], "done"])(
      "rejects a non-object batch result %#",
      (value) => {
        expectUsageError(
          () => normalizeMigrationBatchResult(value, null),
          /batch result must be an object/i,
        );
      },
    );

    it("rejects missing or non-boolean done values", () => {
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            { checkpoint: null, counts: counts() },
            null,
          ),
        /requires done/i,
      );
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            { done: "true", checkpoint: null, counts: counts() },
            null,
          ),
        /requires done/i,
      );
    });

    it("rejects a batch with row errors", () => {
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            {
              done: true,
              checkpoint: null,
              counts: counts({ errors: 1 }),
            },
            null,
          ),
        /row errors cannot be committed/i,
      );
    });

    it("rejects an incomplete batch without a checkpoint", () => {
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            { done: false, checkpoint: null, counts: counts() },
            null,
          ),
        /requires a checkpoint/i,
      );
    });

    it("rejects an incomplete batch whose checkpoint does not advance", () => {
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            {
              done: false,
              checkpoint: { cursor: "user-10", phase: 1 },
              counts: counts(),
            },
            { cursor: "user-10", phase: 1 },
          ),
        /must advance its checkpoint/i,
      );
    });

    it("treats object-key reordering as the same checkpoint", () => {
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            {
              done: false,
              checkpoint: { phase: 1, cursor: "user-10" },
              counts: counts(),
            },
            { cursor: "user-10", phase: 1 },
          ),
        /must advance its checkpoint/i,
      );
    });

    it("rejects malformed batch counts and checkpoints", () => {
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            { done: true, checkpoint: null, counts: { examined: -1 } },
            null,
          ),
        /non-negative safe integer/i,
      );
      expectUsageError(
        () =>
          normalizeMigrationBatchResult(
            { done: true, checkpoint: { unsafe: undefined }, counts: counts() },
            null,
          ),
        /non-JSON undefined/i,
      );
    });
  });

  describe("migration plans", () => {
    it("normalizes a valid plan into isolated count and warning values", () => {
      const inputCounts = counts();
      const warnings = [{ code: "LONG_RUNNING", count: 3 }];

      const plan = normalizeMigrationPlan({
        summary: "Backfill alumni profiles",
        counts: inputCounts,
        estimatedBatches: 3,
        warnings,
      });
      warnings[0] = { code: "CHANGED", count: 0 };

      expect(plan).toEqual({
        summary: "Backfill alumni profiles",
        counts: counts(),
        estimatedBatches: 3,
        warnings: [{ code: "LONG_RUNNING", count: 3 }],
      });
      expect(plan.counts).not.toBe(inputCounts);
    });

    it.each([null, [], "plan"])("rejects a non-object plan %#", (value) => {
      expectUsageError(() => normalizeMigrationPlan(value), /plan must be an object/i);
    });

    it.each(["", "   ", "x".repeat(501), "line one\nline two", "bad\u007fsummary"])(
      "rejects an invalid plan summary %#",
      (summary) => {
        expectUsageError(
          () =>
            normalizeMigrationPlan({
              summary,
              counts: counts(),
              estimatedBatches: 1,
              warnings: [],
            }),
          /plan summary is invalid/i,
        );
      },
    );

    it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid estimatedBatches %#",
      (estimatedBatches) => {
        expectUsageError(
          () =>
            normalizeMigrationPlan({
              summary: "Valid summary",
              counts: counts(),
              estimatedBatches,
              warnings: [],
            }),
          /estimatedBatches.*non-negative safe integer/i,
        );
      },
    );

    it.each([
      "warning",
      Array.from({ length: 21 }, () => ({ code: "WARNING", count: 1 })),
      [{ code: "lowercase", count: 1 }],
      [{ code: "INVALID\nCODE", count: 1 }],
      [{ code: "WARNING", count: -1 }],
      [{ code: "WARNING", count: 1.5 }],
      [{ code: "WARNING", count: 1, detail: "not allowed" }],
      [42],
    ])("rejects invalid plan warnings %#", (warnings) => {
      expectUsageError(
        () =>
          normalizeMigrationPlan({
            summary: "Valid summary",
            counts: counts(),
            estimatedBatches: 1,
            warnings,
          }),
        /plan warnings are invalid/i,
      );
    });

    it("rejects invalid plan counts", () => {
      expectUsageError(
        () =>
          normalizeMigrationPlan({
            summary: "Valid summary",
            counts: counts({ matched: 11 }),
            estimatedBatches: 1,
            warnings: [],
          }),
        /matched.*examined/i,
      );
    });
  });

  describe("migration verification results", () => {
    it.each([true, false])("normalizes a verification with ok=%s", (ok) => {
      const inputCounts = counts();
      const verification = normalizeMigrationVerification({
        ok,
        summary: "Verification complete",
        counts: inputCounts,
      });

      expect(verification).toEqual({
        ok,
        summary: "Verification complete",
        counts: counts(),
      });
      expect(verification.counts).not.toBe(inputCounts);
    });

    it.each([null, [], "verification"])(
      "rejects a non-object verification %#",
      (value) => {
        expectUsageError(
          () => normalizeMigrationVerification(value),
          /verification result must be an object/i,
        );
      },
    );

    it.each([undefined, "true", 1])("rejects invalid ok value %#", (ok) => {
      expectUsageError(
        () =>
          normalizeMigrationVerification({
            ok,
            summary: "Verification complete",
            counts: counts(),
          }),
        /verification requires ok/i,
      );
    });

    it.each(["", "   ", "x".repeat(501), "two\nlines", "bad\u0000summary"])(
      "rejects an invalid verification summary %#",
      (summary) => {
        expectUsageError(
          () =>
            normalizeMigrationVerification({
              ok: true,
              summary,
              counts: counts(),
            }),
          /verification summary is invalid/i,
        );
      },
    );

    it("rejects invalid verification counts", () => {
      expectUsageError(
        () =>
          normalizeMigrationVerification({
            ok: true,
            summary: "Verification complete",
            counts: counts({ modified: 9 }),
          }),
        /modified.*matched/i,
      );
    });
  });

  describe("failure sanitization", () => {
    it("rejects custom error codes and returns a deterministic SHA-256 digest", () => {
      const secret = "mongodb://operator:p%40ssword@atlas.example/private";
      const error = Object.assign(new Error(secret), {
        code: "MIGRATION_WRITE_CONFLICT",
        connectionString: secret,
      });

      const sanitized = sanitizeMigrationFailure(
        error,
        "MIGRATION_EXECUTION_FAILED",
      );
      const expectedDigest = createHash("sha256")
        .update(`Error:${secret}`)
        .digest("hex");

      expect(sanitized).toEqual({
        code: "MIGRATION_EXECUTION_FAILED",
        digest: expectedDigest,
      });
      expect(Object.keys(sanitized).sort()).toEqual(["code", "digest"]);
      expect(sanitized.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(sanitized)).not.toContain(secret);
      expect(Object.values(sanitized)).not.toContain(secret);
    });

    it("retains only explicit framework failure codes", () => {
      expect(
        sanitizeMigrationFailure(
          new MigrationUsageError("Invalid migration output"),
          "MIGRATION_APPLY_FAILED",
        ).code,
      ).toBe("MIGRATION_USAGE_ERROR");
      expect(
        sanitizeMigrationFailure(
          Object.assign(new Error("private"), {
            code: "TOKEN_SUPER_SECRET_123",
          }),
          "MIGRATION_ROLLBACK_FAILED",
        ).code,
      ).toBe("MIGRATION_ROLLBACK_FAILED");
    });

    it.each([
      undefined,
      null,
      { code: 11_000 },
      { code: "lowercase_code" },
      { code: "HAS-HYPHEN" },
      { code: `A${"A".repeat(80)}` },
    ])("uses the safe fallback for a non-allowlisted code %#", (error) => {
      expect(
        sanitizeMigrationFailure(error, "MIGRATION_EXECUTION_FAILED").code,
      ).toBe("MIGRATION_EXECUTION_FAILED");
    });

    it("hashes primitive failures without returning their sensitive content", () => {
      const secret = "token=super-secret-value";
      const sanitized = sanitizeMigrationFailure(
        secret,
        "MIGRATION_EXECUTION_FAILED",
      );

      expect(sanitized).toEqual({
        code: "MIGRATION_EXECUTION_FAILED",
        digest: createHash("sha256").update(secret).digest("hex"),
      });
      expect(JSON.stringify(sanitized)).not.toContain(secret);
    });

    it("uses a stable unknown digest for non-error objects", () => {
      const sanitized = sanitizeMigrationFailure(
        { password: "must-not-leak" },
        "MIGRATION_EXECUTION_FAILED",
      );

      expect(sanitized).toEqual({
        code: "MIGRATION_EXECUTION_FAILED",
        digest: createHash("sha256").update("unknown").digest("hex"),
      });
      expect(JSON.stringify(sanitized)).not.toContain("must-not-leak");
    });

    it("replaces an unsafe fallback code with the fixed safe default", () => {
      const sanitized = sanitizeMigrationFailure(
        new Error("sensitive failure"),
        "unsafe fallback with secrets",
      );

      expect(sanitized.code).toBe("MIGRATION_EXECUTION_FAILED");
    });

    it("is total for revoked proxies and throwing Error accessors", () => {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const throwingError = new Error("initial");
      Object.defineProperty(throwingError, "message", {
        configurable: true,
        get: () => {
          throw new Error("must not escape");
        },
      });

      for (const error of [revoked.proxy, throwingError]) {
        expect(() =>
          sanitizeMigrationFailure(error, "MIGRATION_APPLY_FAILED"),
        ).not.toThrow();
        expect(
          sanitizeMigrationFailure(error, "MIGRATION_APPLY_FAILED"),
        ).toEqual({
          code: "MIGRATION_APPLY_FAILED",
          digest: createHash("sha256").update("unknown").digest("hex"),
        });
      }
    });
  });
});
