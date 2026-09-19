import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const MIGRATION_ID_PATTERN =
  /^(\d{4})(\d{2})(\d{2})_\d{3}_[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIGRATION_FILE_PATTERN =
  /^(\d{8}_\d{3}_[a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/;
const CHECKSUM_DOMAIN = "atcloud-migration-source-v1";
const REQUIRED_MIGRATION_FIELDS = new Set([
  "id",
  "description",
  "plan",
  "up",
  "down",
  "verify",
]);
const OPTIONAL_MIGRATION_FIELDS = new Set(["prepare"]);
const ALLOWED_MIGRATION_FIELDS = new Set([
  ...REQUIRED_MIGRATION_FIELDS,
  ...OPTIONAL_MIGRATION_FIELDS,
]);
const MIGRATION_HANDLER_FIELDS = new Set([
  "prepare",
  "plan",
  "up",
  "down",
  "verify",
]);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");

export const DEFAULT_MIGRATION_VERSIONS_DIRECTORY = path.join(
  BACKEND_DIRECTORY,
  "src",
  "migrations",
  "versions",
);
export const DEFAULT_MIGRATION_CHECKSUM_MANIFEST = path.join(
  BACKEND_DIRECTORY,
  "src",
  "migrations",
  "checksums.generated.ts",
);

export class MigrationChecksumScriptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationChecksumScriptError";
    this.code = code;
  }
}

export function normalizeLf(source) {
  return source.replace(/\r\n?/gu, "\n");
}

export function calculateMigrationSourceChecksum(filename, source) {
  const checksumInput = `${CHECKSUM_DOMAIN}\0${filename}\0${normalizeLf(source)}`;
  return createHash("sha256").update(checksumInput, "utf8").digest("hex");
}

function isRelativeModuleSpecifier(value) {
  return value.startsWith("./") || value.startsWith("../");
}

function isTypeOnlyImportClause(importClause) {
  if (!importClause) return false;
  if (importClause.isTypeOnly) return true;
  return (
    !importClause.name &&
    importClause.namedBindings &&
    ts.isNamedImports(importClause.namedBindings) &&
    importClause.namedBindings.elements.length > 0 &&
    importClause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExportClause(statement) {
  if (statement.isTypeOnly) return true;
  return (
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length > 0 &&
    statement.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name) {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function findMigrationDeclaration(sourceFile) {
  let migrationDeclaration;
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !isRelativeModuleSpecifier(statement.moduleSpecifier.text) ||
        !isTypeOnlyExportClause(statement)
      ) {
        throw new MigrationChecksumScriptError(
          "MIGRATION_SOURCE_TOP_LEVEL_FORBIDDEN",
          "Migration sources may only contain type declarations, type-only relative imports or exports, and one migration definition.",
        );
      }
      continue;
    }

    const modifiers = ts.isVariableStatement(statement)
      ? statement.modifiers?.map((modifier) => modifier.kind) ?? []
      : [];
    const declarations = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
      : [];
    const declaration = declarations[0];
    const isMigrationStatement =
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags === ts.NodeFlags.Const &&
      modifiers.length === 1 &&
      modifiers[0] === ts.SyntaxKind.ExportKeyword &&
      declarations.length === 1 &&
      declaration !== undefined &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === "migration" &&
      declaration.initializer !== undefined;
    if (!isMigrationStatement || migrationDeclaration) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_TOP_LEVEL_FORBIDDEN",
        "Migration sources may only contain type declarations, type-only relative imports or exports, and one migration definition.",
      );
    }
    migrationDeclaration = declaration;
  }

  if (!migrationDeclaration) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_EXPORT_INVALID",
      "Each migration source must directly export one const named migration.",
    );
  }
  return migrationDeclaration;
}

function requireLiteralText(property, field) {
  if (
    !ts.isPropertyAssignment(property) ||
    !(
      ts.isStringLiteral(property.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(property.initializer)
    )
  ) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_DEFINITION_INVALID",
      `Migration source ${field} must be a string literal.`,
    );
  }
  return property.initializer.text;
}

function validateSourceDefinition(sourceFile, expectedId) {
  const migrationDeclaration = findMigrationDeclaration(sourceFile);

  const initializer = unwrapExpression(migrationDeclaration.initializer);
  if (!ts.isObjectLiteralExpression(initializer)) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_DEFINITION_INVALID",
      "The exported migration source definition must be an object literal.",
    );
  }

  const seenFields = new Set();
  for (const property of initializer.properties) {
    const propertyName = propertyNameText(property.name);
    if (
      ts.isSpreadAssignment(property) ||
      !propertyName ||
      !ALLOWED_MIGRATION_FIELDS.has(propertyName) ||
      seenFields.has(propertyName) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_DEFINITION_INVALID",
        "Migration source definitions must contain exactly the required literal fields without computed, duplicate, accessor, spread, or extra properties.",
      );
    }
    seenFields.add(propertyName);

    if (propertyName === "id") {
      if (requireLiteralText(property, "id") !== expectedId) {
        throw new MigrationChecksumScriptError(
          "MIGRATION_SOURCE_ID_MISMATCH",
          "A migration source id does not match its filename.",
        );
      }
      continue;
    }
    if (propertyName === "description") {
      const description = requireLiteralText(property, "description");
      if (
        description.length === 0 ||
        description.length > 240 ||
        description.trim() !== description ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(description)
      ) {
        throw new MigrationChecksumScriptError(
          "MIGRATION_SOURCE_DESCRIPTION_INVALID",
          "A migration source description is invalid.",
        );
      }
      continue;
    }

    const handlerIsInline =
      MIGRATION_HANDLER_FIELDS.has(propertyName) &&
      (ts.isMethodDeclaration(property) ||
        (ts.isPropertyAssignment(property) &&
          (ts.isArrowFunction(unwrapExpression(property.initializer)) ||
            ts.isFunctionExpression(unwrapExpression(property.initializer)))));
    if (!handlerIsInline) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_HANDLER_INVALID",
        "Migration handlers must be inline arrow functions, function expressions, or methods.",
      );
    }
  }

  if (
    [...REQUIRED_MIGRATION_FIELDS].some((field) => !seenFields.has(field)) ||
    seenFields.size > ALLOWED_MIGRATION_FIELDS.size
  ) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_DEFINITION_INVALID",
      "Migration source definitions must contain id, description, plan, up, down, and verify, with only the optional prepare handler allowed.",
    );
  }
}

function validateImportPolicy(sourceFile) {
  if (
    sourceFile.parseDiagnostics.length > 0 ||
    sourceFile.typeReferenceDirectives.length > 0 ||
    sourceFile.libReferenceDirectives.length > 0 ||
    sourceFile.referencedFiles.length > 0
  ) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_SYNTAX_INVALID",
      "A migration source contains unsupported syntax or reference directives.",
    );
  }

  const forbiddenRuntimeIdentifiers = new Set([
    "Function",
    "__dirname",
    "__filename",
    "arguments",
    "console",
    "eval",
    "exports",
    "fetch",
    "global",
    "globalThis",
    "module",
    "process",
    "require",
    "WebSocket",
  ]);

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
      if (
        !specifier ||
        !isRelativeModuleSpecifier(specifier) ||
        !isTypeOnlyImportClause(node.importClause)
      ) {
        throw new MigrationChecksumScriptError(
          "MIGRATION_SOURCE_RUNTIME_IMPORT_FORBIDDEN",
          "Migration sources may only use type-only relative imports.",
        );
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_RUNTIME_IMPORT_FORBIDDEN",
        "Migration sources may only use type-only relative imports.",
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
      if (
        !specifier ||
        !isRelativeModuleSpecifier(specifier) ||
        !isTypeOnlyExportClause(node)
      ) {
        throw new MigrationChecksumScriptError(
          "MIGRATION_SOURCE_RUNTIME_IMPORT_FORBIDDEN",
          "Migration sources may only use type-only relative imports.",
        );
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_DYNAMIC_IMPORT_FORBIDDEN",
        "Dynamic module loading is forbidden in migration sources.",
      );
    } else if (
      ts.isImportTypeNode(node) &&
      (!ts.isLiteralTypeNode(node.argument) ||
        !ts.isStringLiteral(node.argument.literal) ||
        !isRelativeModuleSpecifier(node.argument.literal.text))
    ) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_TYPE_IMPORT_FORBIDDEN",
        "Migration source type imports must be relative.",
      );
    } else if (
      ts.isIdentifier(node) &&
      forbiddenRuntimeIdentifiers.has(node.text)
    ) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_RUNTIME_ACCESS_FORBIDDEN",
        "Migration sources may not access runtime module loaders or process globals.",
      );
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_RUNTIME_ACCESS_FORBIDDEN",
        "Migration sources may not access runtime module loaders or process globals.",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function validateMigrationSource(source, expectedId) {
  const sourceFile = ts.createSourceFile(
    "migration.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // This is a defense-in-depth guardrail for trusted, reviewed migrations, not
  // a sandbox for executing adversarial code.
  validateImportPolicy(sourceFile);
  validateSourceDefinition(sourceFile, expectedId);
}

function hasValidCalendarDate(id) {
  const match = MIGRATION_ID_PATTERN.exec(id);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysByMonth[month - 1];
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_ENCODING_INVALID",
      "A migration source file is not valid UTF-8.",
    );
  }
}

async function readDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function collectMigrationChecksums(
  versionsDirectory = DEFAULT_MIGRATION_VERSIONS_DIRECTORY,
) {
  const directoryEntries = await readDirectory(versionsDirectory);
  const sourceFiles = directoryEntries.filter((entry) =>
    /\.(?:[cm]?ts|tsx)$/iu.test(entry.name),
  );
  if (
    sourceFiles.some(
      (entry) => !entry.isFile() || !MIGRATION_FILE_PATTERN.test(entry.name),
    )
  ) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_SOURCE_FILENAME_INVALID",
      "Every TypeScript migration source must use the filename YYYYMMDD_NNN_kebab-slug.ts.",
    );
  }

  sourceFiles.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const entries = [];
  for (const sourceFile of sourceFiles) {
    const id = MIGRATION_FILE_PATTERN.exec(sourceFile.name)?.[1];
    if (!id || !hasValidCalendarDate(id)) {
      throw new MigrationChecksumScriptError(
        "MIGRATION_SOURCE_ID_INVALID",
        "A migration source filename contains an invalid migration id.",
      );
    }
    const bytes = await readFile(path.join(versionsDirectory, sourceFile.name));
    const normalizedSource = normalizeLf(decodeUtf8(bytes));
    validateMigrationSource(normalizedSource, id);
    entries.push(
      Object.freeze({
        id,
        checksum: calculateMigrationSourceChecksum(
          sourceFile.name,
          normalizedSource,
        ),
      }),
    );
  }
  return Object.freeze(entries);
}

export function renderMigrationChecksumManifest(entries) {
  const imports = entries.map(
    (entry, index) =>
      `import { migration as migrationSource${index} } from "./versions/${entry.id}";`,
  );
  const checksumProperties = entries.map(
    (entry) => `  "${entry.id}": "${entry.checksum}",`,
  );
  const sources = entries.map((_entry, index) => `  migrationSource${index},`);

  return normalizeLf(
    [
      "// Generated by scripts/migration-checksums.mjs. Do not edit.",
      'import type { MigrationSourceDefinition } from "./types";',
      ...imports,
      "",
      "export const MIGRATION_CHECKSUMS: Readonly<Record<string, string>> =",
      "  Object.freeze({",
      ...checksumProperties,
      "  });",
      "",
      "export const MIGRATION_SOURCE_DEFINITIONS: readonly MigrationSourceDefinition[] =",
      "  Object.freeze([",
      ...sources,
      "  ]);",
      "",
    ].join("\n"),
  );
}

export async function expectedMigrationChecksumManifest(
  versionsDirectory = DEFAULT_MIGRATION_VERSIONS_DIRECTORY,
) {
  const entries = await collectMigrationChecksums(versionsDirectory);
  return Object.freeze({
    entries,
    source: renderMigrationChecksumManifest(entries),
  });
}

export async function checkMigrationChecksums({
  versionsDirectory = DEFAULT_MIGRATION_VERSIONS_DIRECTORY,
  manifestPath = DEFAULT_MIGRATION_CHECKSUM_MANIFEST,
} = {}) {
  const expected = await expectedMigrationChecksumManifest(versionsDirectory);
  let actual;
  try {
    actual = normalizeLf(decodeUtf8(await readFile(manifestPath)));
  } catch (error) {
    if (error instanceof MigrationChecksumScriptError) throw error;
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new MigrationChecksumScriptError(
        "MIGRATION_CHECKSUM_MANIFEST_MISSING",
        "The generated migration checksum manifest is missing. Run the update command.",
      );
    }
    throw error;
  }
  if (actual !== expected.source) {
    throw new MigrationChecksumScriptError(
      "MIGRATION_CHECKSUM_MANIFEST_STALE",
      "The generated migration checksum manifest is stale. Run the update command.",
    );
  }
  return expected.entries.length;
}

export async function updateMigrationChecksums({
  versionsDirectory = DEFAULT_MIGRATION_VERSIONS_DIRECTORY,
  manifestPath = DEFAULT_MIGRATION_CHECKSUM_MANIFEST,
} = {}) {
  const expected = await expectedMigrationChecksumManifest(versionsDirectory);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, expected.source, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, manifestPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
  return expected.entries.length;
}

async function main() {
  const cliArguments = process.argv.slice(2);
  const operations = cliArguments.filter(
    (argument) => argument === "--check" || argument === "--update",
  );
  const quietArguments = cliArguments.filter(
    (argument) => argument === "--quiet",
  );
  const validArguments = cliArguments.every(
    (argument) =>
      argument === "--check" ||
      argument === "--update" ||
      argument === "--quiet",
  );
  if (
    !validArguments ||
    operations.length !== 1 ||
    quietArguments.length > 1
  ) {
    process.stderr.write(
      "Usage: node scripts/migration-checksums.mjs --check|--update [--quiet]\n",
    );
    process.exitCode = 2;
    return;
  }
  const operation = operations[0];
  const quiet = quietArguments.length === 1;

  try {
    const count =
      operation === "--check"
        ? await checkMigrationChecksums()
        : await updateMigrationChecksums();
    if (!quiet) {
      process.stdout.write(
        `Migration checksum manifest ${operation === "--check" ? "is current" : "updated"} (${count} migrations).\n`,
      );
    }
  } catch (error) {
    if (error instanceof MigrationChecksumScriptError) {
      process.stderr.write(`[${error.code}] ${error.message}\n`);
    } else {
      process.stderr.write(
        "[MIGRATION_CHECKSUM_OPERATION_FAILED] Migration checksum operation failed.\n",
      );
    }
    process.exitCode = 1;
  }
}

const invokedModuleUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedModuleUrl === import.meta.url) {
  await main();
}
