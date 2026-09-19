import { describe, expect, it } from "vitest";
import {
  buildMigrationRegistry,
  MIGRATION_REGISTRY,
  validateMigrationRegistry,
} from "../../../src/migrations/registry";
import type {
  MigrationCounts,
  MigrationDefinition,
  MigrationSourceDefinition,
} from "../../../src/migrations/types";

const counts: MigrationCounts = {
  examined: 0,
  matched: 0,
  modified: 0,
  skipped: 0,
  errors: 0,
};

function migration(
  overrides: Partial<MigrationDefinition> = {},
): MigrationDefinition {
  return {
    id: "20260909_001_first-migration",
    description: "First test migration",
    checksum: "a".repeat(64),
    plan: async () => ({
      summary: "No changes required",
      counts,
      estimatedBatches: 0,
      warnings: [],
    }),
    up: async () => ({ done: true, checkpoint: null, counts }),
    down: async () => ({ done: true, checkpoint: null, counts }),
    verify: async () => ({ ok: true, summary: "Verified", counts }),
    ...overrides,
  };
}

function sourceMigration(
  overrides: Partial<MigrationSourceDefinition> = {},
): MigrationSourceDefinition {
  return {
    id: "20260909_001_first-migration",
    description: "First test migration",
    plan: async () => ({
      summary: "No changes required",
      counts,
      estimatedBatches: 0,
      warnings: [],
    }),
    up: async () => ({ done: true, checkpoint: null, counts }),
    down: async () => ({ done: true, checkpoint: null, counts }),
    verify: async () => ({ ok: true, summary: "Verified", counts }),
    ...overrides,
  };
}

describe("migration registry", () => {
  it("exports the immutable checksum-backed production registry", () => {
    expect(Object.isFrozen(MIGRATION_REGISTRY)).toBe(true);
    expect(MIGRATION_REGISTRY).toHaveLength(7);
    expect(MIGRATION_REGISTRY[0]).toMatchObject({
      id: "20260911_001_inventory-registration-profile",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(MIGRATION_REGISTRY[1]).toMatchObject({
      id: "20260912_001_backfill-program-purchase-student-roles",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(MIGRATION_REGISTRY[2]).toMatchObject({
      id: "20260918_001_enforce-audit-log-ttl",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      prepare: expect.any(Function),
    });
    expect(MIGRATION_REGISTRY[3]).toMatchObject({
      id: "20260918_002_create-refresh-session-indexes",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      prepare: expect.any(Function),
    });
    expect(MIGRATION_REGISTRY[4]).toMatchObject({
      id: "20260918_003_create-file-cleanup-job-index",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      prepare: expect.any(Function),
    });
    expect(MIGRATION_REGISTRY[5]).toMatchObject({
      id: "20260918_004_enforce-notification-outbox-retention",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      prepare: expect.any(Function),
    });
    expect(MIGRATION_REGISTRY[6]).toMatchObject({
      id: "20260918_005_reconcile-user-deletion-notices",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(MIGRATION_REGISTRY[0])).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY[1])).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY[2])).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY[3])).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY[4])).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY[5])).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY[6])).toBe(true);
    expect(() => validateMigrationRegistry(MIGRATION_REGISTRY)).not.toThrow();
  });

  it("accepts an empty source list only with an empty manifest", () => {
    const registry = buildMigrationRegistry([], Object.freeze({}));

    expect(registry).toEqual([]);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("injects the generated checksum by id and freezes the result", () => {
    const source = sourceMigration();
    const checksum = "d".repeat(64);

    const registry = buildMigrationRegistry(
      [source],
      Object.freeze({ [source.id]: checksum }),
    );

    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ id: source.id, checksum });
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry[0])).toBe(true);
    expect(source).not.toHaveProperty("checksum");
  });

  it("fails closed when manifest and source ids are not exactly equal", () => {
    const source = sourceMigration();

    expect(() => buildMigrationRegistry([source], {})).toThrow(
      /exactly the same ids/,
    );
    expect(() =>
      buildMigrationRegistry([], { [source.id]: "a".repeat(64) }),
    ).toThrow(/exactly the same ids/);
  });

  it("rejects a source-supplied checksum and malformed manifest entries", () => {
    const source = sourceMigration();
    const unsafeSource = {
      ...source,
      checksum: "a".repeat(64),
    } as unknown as MigrationSourceDefinition;

    expect(() =>
      buildMigrationRegistry([unsafeSource], { [source.id]: "a".repeat(64) }),
    ).toThrow(/must not provide a checksum/);
    expect(() =>
      buildMigrationRegistry([source], { [source.id]: "not-a-checksum" }),
    ).toThrow(/invalid entry/);
  });

  it("accepts unique migrations in strict chronological order", () => {
    const registry = [
      migration(),
      migration({
        id: "20260909_002_second-migration",
        checksum: "b".repeat(64),
      }),
      migration({
        id: "20260910_001_next-day-migration",
        checksum: "c".repeat(64),
      }),
    ];

    expect(() => validateMigrationRegistry(registry)).not.toThrow();
  });

  it.each([
    "20260909-first-migration",
    "20260909_01_first-migration",
    "20260909_001_First-migration",
    "20260909_001_first_migration",
    "20260909_001_-first-migration",
  ])("rejects malformed migration id %s", (id) => {
    expect(() => validateMigrationRegistry([migration({ id })])).toThrow(
      /invalid id/,
    );
  });

  it.each(["20260229_001_bad-leap-day", "20261301_001_bad-month"])(
    "rejects migration id with invalid calendar date %s",
    (id) => {
      expect(() => validateMigrationRegistry([migration({ id })])).toThrow(
        /invalid calendar date/,
      );
    },
  );

  it("accepts a leap-day migration id in a leap year", () => {
    expect(() =>
      validateMigrationRegistry([
        migration({ id: "20280229_001_valid-leap-day" }),
      ]),
    ).not.toThrow();
  });

  it("rejects duplicate migration ids", () => {
    expect(() =>
      validateMigrationRegistry([
        migration(),
        migration({ checksum: "b".repeat(64) }),
      ]),
    ).toThrow(/duplicate id/);
  });

  it("rejects migrations that are out of order", () => {
    expect(() =>
      validateMigrationRegistry([
        migration({ id: "20260910_001_later-migration" }),
        migration({
          id: "20260909_002_earlier-migration",
          checksum: "b".repeat(64),
        }),
      ]),
    ).toThrow(/strictly increasing/);
  });

  it.each([
    "",
    " leading space",
    "trailing space ",
    "two\nlines",
    "x".repeat(241),
  ])(
    "rejects invalid descriptions",
    (description) => {
      expect(() =>
        validateMigrationRegistry([migration({ description })]),
      ).toThrow(/trimmed description/);
    },
  );

  it.each(["a".repeat(63), "A".repeat(64), `g${"a".repeat(63)}`])(
    "rejects invalid checksums",
    (checksum) => {
      expect(() =>
        validateMigrationRegistry([migration({ checksum })]),
      ).toThrow(/SHA-256 checksum/);
    },
  );

  it.each(["plan", "up", "down", "verify"] as const)(
    "requires the %s handler",
    (handler) => {
      const definition = migration() as unknown as Record<string, unknown>;
      Reflect.deleteProperty(definition, handler);

      expect(() =>
        validateMigrationRegistry([
          definition as unknown as MigrationDefinition,
        ]),
      ).toThrow(new RegExp(`${handler}\\(\\) function`));
    },
  );

  it("rejects a non-array registry at runtime", () => {
    expect(() =>
      validateMigrationRegistry(
        null as unknown as readonly MigrationDefinition[],
      ),
    ).toThrow(/must be an array/);
  });

  it("rejects non-object entries at runtime", () => {
    expect(() =>
      validateMigrationRegistry([
        null as unknown as MigrationDefinition,
      ]),
    ).toThrow(/must be an object/);
  });
});
