import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface ChecksumEntry {
  readonly id: string;
  readonly checksum: string;
}

interface ChecksumModule {
  readonly MigrationChecksumScriptError: new (
    code: string,
    message: string,
  ) => Error & { readonly code: string };
  readonly checkMigrationChecksums: (paths?: {
    readonly versionsDirectory?: string;
    readonly manifestPath?: string;
  }) => Promise<number>;
  readonly calculateMigrationSourceChecksum: (
    filename: string,
    source: string,
  ) => string;
  readonly collectMigrationChecksums: (
    versionsDirectory?: string,
  ) => Promise<readonly ChecksumEntry[]>;
  readonly updateMigrationChecksums: (paths?: {
    readonly versionsDirectory?: string;
    readonly manifestPath?: string;
  }) => Promise<number>;
  readonly validateMigrationSource: (
    source: string,
    expectedId: string,
  ) => void;
}

const MIGRATION_ID = "20260909_001_fixture";
const SECRET_SOURCE_FRAGMENT = "do-not-echo-this-source-value";
const TYPE_IMPORT = 'import type { MigrationSourceDefinition } from "../types";';

let checksumModule: ChecksumModule;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  checksumModule = (await import(
    "../../../scripts/migration-checksums.mjs"
  )) as ChecksumModule;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "atcloud-checksums-"));
  temporaryDirectories.push(root);
  const versionsDirectory = path.join(root, "versions");
  const manifestPath = path.join(root, "checksums.generated.ts");
  await mkdir(versionsDirectory);
  return { versionsDirectory, manifestPath };
}

function migrationSource(lineEnding = "\n") {
  return [
    TYPE_IMPORT,
    "export const migration = {",
    `  id: "${MIGRATION_ID}",`,
    '  description: "Fixture",',
    `  plan: async () => { const privateValue = "${SECRET_SOURCE_FRAGMENT}"; void privateValue; return { summary: "plan", counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 }, estimatedBatches: 0, warnings: [] }; },`,
    "  up: async () => ({ done: true, checkpoint: null, counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 } }),",
    "  down: async () => ({ done: true, checkpoint: null, counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 } }),",
    "  verify: async () => ({ ok: true, summary: \"ok\", counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 } }),",
    "} satisfies MigrationSourceDefinition;",
    "",
  ].join(lineEnding);
}

async function writeMigration(versionsDirectory: string, source: string) {
  await writeFile(path.join(versionsDirectory, `${MIGRATION_ID}.ts`), source);
}

describe("migration checksum generator", () => {
  it("supports quiet checks without stdout and rejects ambiguous arguments", () => {
    const scriptPath = path.resolve("scripts/migration-checksums.mjs");
    const quiet = spawnSync(process.execPath, [scriptPath, "--check", "--quiet"], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toBe("");

    const ambiguous = spawnSync(
      process.execPath,
      [scriptPath, "--check", "--update"],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr).toContain("Usage:");
  });

  it("supports an empty versions directory and empty generated manifest", async () => {
    const harness = await createHarness();

    await expect(
      checksumModule.updateMigrationChecksums(harness),
    ).resolves.toBe(0);
    await expect(
      checksumModule.checkMigrationChecksums(harness),
    ).resolves.toBe(0);

    const generated = await readFile(harness.manifestPath, "utf8");
    expect(generated).toContain("Object.freeze({\n  });");
    expect(generated).toContain("Object.freeze([\n  ]);");
  });

  it("hashes LF-normalized source bytes and generates static imports", async () => {
    const harness = await createHarness();
    const lfSource = migrationSource("\n");
    await writeMigration(harness.versionsDirectory, lfSource);

    const entries = await checksumModule.collectMigrationChecksums(
      harness.versionsDirectory,
    );
    const expectedChecksum = createHash("sha256")
      .update(
        `atcloud-migration-source-v1\0${MIGRATION_ID}.ts\0${lfSource}`,
        "utf8",
      )
      .digest("hex");
    expect(entries).toEqual([{ id: MIGRATION_ID, checksum: expectedChecksum }]);

    await checksumModule.updateMigrationChecksums(harness);
    const generatedFromLf = await readFile(harness.manifestPath, "utf8");
    expect(generatedFromLf).toContain(
      `import { migration as migrationSource0 } from "./versions/${MIGRATION_ID}";`,
    );
    expect(generatedFromLf).toContain(`"${MIGRATION_ID}": "${expectedChecksum}"`);

    await writeMigration(harness.versionsDirectory, migrationSource("\r\n"));
    await expect(
      checksumModule.checkMigrationChecksums(harness),
    ).resolves.toBe(1);
  });

  it("domain-separates checksums by migration filename", () => {
    const source = migrationSource();
    const first = checksumModule.calculateMigrationSourceChecksum(
      `${MIGRATION_ID}.ts`,
      source,
    );
    const renamed = checksumModule.calculateMigrationSourceChecksum(
      "20260909_002_fixture.ts",
      source,
    );

    expect(first).not.toBe(renamed);
    expect(
      checksumModule.calculateMigrationSourceChecksum(
        `${MIGRATION_ID}.ts`,
        source.replaceAll("\n", "\r\n"),
      ),
    ).toBe(first);
  });

  it("fails closed on stale output without echoing migration source", async () => {
    const harness = await createHarness();
    await writeMigration(harness.versionsDirectory, migrationSource());
    await checksumModule.updateMigrationChecksums(harness);
    await writeMigration(
      harness.versionsDirectory,
      migrationSource().replace("Fixture", "Changed fixture"),
    );

    const error = await checksumModule.checkMigrationChecksums(harness).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(checksumModule.MigrationChecksumScriptError);
    expect(error).toMatchObject({ code: "MIGRATION_CHECKSUM_MANIFEST_STALE" });
    expect(String(error)).not.toContain(SECRET_SOURCE_FRAGMENT);
    expect(String(error)).not.toContain("Changed fixture");
  });

  it.each([
    'import mongoose from "mongoose";',
    'import { User } from "../../models/User";',
  ])("rejects runtime escape syntax without echoing its payload", (unsafeLine) => {
    const source = migrationSource().replace(TYPE_IMPORT, unsafeLine);

    expect(() =>
      checksumModule.validateMigrationSource(source, MIGRATION_ID),
    ).toThrow(/Migration sources|Dynamic module loading/);
    try {
      checksumModule.validateMigrationSource(source, MIGRATION_ID);
    } catch (error) {
      expect(String(error)).not.toContain(unsafeLine);
      expect(String(error)).not.toContain("mongoose");
      expect(String(error)).not.toContain("mongodb");
      expect(String(error)).not.toContain("example.invalid");
    }
  });

  it.each([
    "const commonJsModule = arguments[1]; void commonJsModule;",
    'const driver = require("mongodb"); void driver;',
    'const driver = await import("mongodb"); void driver;',
    "const connection = globalThis.mongoose.connection; void connection;",
    'const response = await fetch("https://example.invalid"); void response;',
    'console.log("private output");',
    "const receiver = this; void receiver;",
    "const commonJsExports = exports; void commonJsExports;",
  ])("rejects handler runtime escape syntax", (unsafeStatement) => {
    const source = migrationSource().replace(
      `const privateValue = "${SECRET_SOURCE_FRAGMENT}"; void privateValue;`,
      unsafeStatement,
    );

    expect(() =>
      checksumModule.validateMigrationSource(source, MIGRATION_ID),
    ).toThrow(/Dynamic module loading|runtime module loaders/);
    try {
      checksumModule.validateMigrationSource(source, MIGRATION_ID);
    } catch (error) {
      expect(String(error)).not.toContain(unsafeStatement);
      expect(String(error)).not.toContain("private output");
    }
  });

  it("allows only type-only relative imports", () => {
    expect(() =>
      checksumModule.validateMigrationSource(migrationSource(), MIGRATION_ID),
    ).not.toThrow();
    expect(() =>
      checksumModule.validateMigrationSource(
        migrationSource().replace(
          TYPE_IMPORT,
          'import type { ObjectId } from "mongodb";',
        ),
        MIGRATION_ID,
      ),
    ).toThrow(/type-only relative imports/);
  });

  it("requires a filename-matched id and forbids authored checksums", () => {
    expect(() =>
      checksumModule.validateMigrationSource(
        migrationSource().replace(MIGRATION_ID, "20260909_002_other"),
        MIGRATION_ID,
      ),
    ).toThrow(/does not match its filename/);
    expect(() =>
      checksumModule.validateMigrationSource(
        migrationSource().replace(
          '  description: "Fixture",',
          `  checksum: "${"a".repeat(64)}",\n  description: "Fixture",`,
        ),
        MIGRATION_ID,
      ),
    ).toThrow(/exactly the required literal fields/);
  });

  it("rejects executable top-level statements", () => {
    const source = migrationSource().replace(
      TYPE_IMPORT,
      `${TYPE_IMPORT}\nrunAtImportTime();`,
    );

    expect(() =>
      checksumModule.validateMigrationSource(source, MIGRATION_ID),
    ).toThrow(/only contain type declarations/);
  });

  it.each([
    {
      name: "getter",
      mutate: (source: string) =>
        source.replace(
          /  plan:.*\n/u,
          '  get plan() { return async () => ({ summary: "plan", counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 }, estimatedBatches: 0, warnings: [] }); },\n',
        ),
    },
    {
      name: "extra field",
      mutate: (source: string) =>
        source.replace(
          '  description: "Fixture",',
          '  description: "Fixture",\n  extra: true,',
        ),
    },
    {
      name: "non-function handler",
      mutate: (source: string) =>
        source.replace(/  plan:.*\n/u, "  plan: Promise.resolve(null),\n"),
    },
  ])("rejects a $name migration definition", ({ mutate }) => {
    expect(() =>
      checksumModule.validateMigrationSource(
        mutate(migrationSource()),
        MIGRATION_ID,
      ),
    ).toThrow(/Migration source|Migration handlers/);
  });

  it("allows type/interface declarations but no helper runtime declarations", () => {
    const source = migrationSource().replace(
      TYPE_IMPORT,
      `${TYPE_IMPORT}\ninterface LocalCheckpoint { readonly lastId: number; }\ntype LocalId = string;`,
    );
    expect(() =>
      checksumModule.validateMigrationSource(source, MIGRATION_ID),
    ).not.toThrow();

    expect(() =>
      checksumModule.validateMigrationSource(
        migrationSource().replace(
          TYPE_IMPORT,
          `${TYPE_IMPORT}\nconst helper = () => true;`,
        ),
        MIGRATION_ID,
      ),
    ).toThrow(/only contain type declarations/);
  });

  it("rejects TypeScript-like files outside the flat version filename contract", async () => {
    const harness = await createHarness();
    await writeFile(
      path.join(harness.versionsDirectory, "unregistered-migration.tsx"),
      SECRET_SOURCE_FRAGMENT,
    );

    const error = await checksumModule
      .collectMigrationChecksums(harness.versionsDirectory)
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({ code: "MIGRATION_SOURCE_FILENAME_INVALID" });
    expect(String(error)).not.toContain(SECRET_SOURCE_FRAGMENT);
  });
});
