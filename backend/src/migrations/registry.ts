import {
  MIGRATION_CHECKSUM_PATTERN,
  MIGRATION_ID_PATTERN,
  type MigrationDefinition,
  type MigrationSourceDefinition,
} from "./types";
import {
  MIGRATION_CHECKSUMS,
  MIGRATION_SOURCE_DEFINITIONS,
} from "./checksums.generated";

const MAX_MIGRATION_DESCRIPTION_LENGTH = 240;
const REQUIRED_HANDLERS = ["plan", "up", "down", "verify"] as const;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function hasValidCalendarDate(id: string): boolean {
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

export function validateMigrationRegistry(
  registry: readonly MigrationDefinition[],
): void {
  if (!Array.isArray(registry)) {
    throw new TypeError("Migration registry must be an array.");
  }

  const seenIds = new Set<string>();
  let previousId: string | undefined;

  registry.forEach((definition, index) => {
    if (!definition || typeof definition !== "object") {
      throw new TypeError(`Migration at index ${index} must be an object.`);
    }

    const { id, description, checksum } = definition;
    if (typeof id !== "string" || !MIGRATION_ID_PATTERN.test(id)) {
      throw new Error(
        `Migration at index ${index} has an invalid id; expected YYYYMMDD_NNN_kebab-slug.`,
      );
    }
    if (!hasValidCalendarDate(id)) {
      throw new Error(`Migration ${id} contains an invalid calendar date.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Migration registry contains duplicate id: ${id}.`);
    }
    if (previousId !== undefined && id <= previousId) {
      throw new Error(
        `Migration registry must be strictly increasing: ${id} follows ${previousId}.`,
      );
    }

    if (
      typeof description !== "string" ||
      description.length === 0 ||
      description.length > MAX_MIGRATION_DESCRIPTION_LENGTH ||
      description.trim() !== description ||
      CONTROL_CHARACTER_PATTERN.test(description)
    ) {
      throw new Error(
        `Migration ${id} must have a trimmed description between 1 and ${MAX_MIGRATION_DESCRIPTION_LENGTH} characters.`,
      );
    }
    if (
      typeof checksum !== "string" ||
      !MIGRATION_CHECKSUM_PATTERN.test(checksum)
    ) {
      throw new Error(
        `Migration ${id} must have a lowercase 64-character SHA-256 checksum.`,
      );
    }

    for (const handler of REQUIRED_HANDLERS) {
      if (typeof definition[handler] !== "function") {
        throw new TypeError(
          `Migration ${id} must define a ${handler}() function.`,
        );
      }
    }

    seenIds.add(id);
    previousId = id;
  });
}

export function buildMigrationRegistry(
  sourceDefinitions: readonly MigrationSourceDefinition[],
  checksumManifest: Readonly<Record<string, string>>,
): readonly MigrationDefinition[] {
  if (!Array.isArray(sourceDefinitions)) {
    throw new TypeError("Migration source definitions must be an array.");
  }
  if (
    !checksumManifest ||
    typeof checksumManifest !== "object" ||
    Array.isArray(checksumManifest) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(checksumManifest))
  ) {
    throw new TypeError("Migration checksum manifest must be a plain object.");
  }

  const manifestDescriptors = Object.getOwnPropertyDescriptors(checksumManifest);
  const manifestKeys = Reflect.ownKeys(manifestDescriptors);
  const manifestIds = new Set<string>();
  for (const key of manifestKeys) {
    if (typeof key !== "string") {
      throw new Error("Migration checksum manifest contains an invalid entry.");
    }
    const descriptor = manifestDescriptors[key];
    if (
      !MIGRATION_ID_PATTERN.test(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !MIGRATION_CHECKSUM_PATTERN.test(descriptor.value)
    ) {
      throw new Error("Migration checksum manifest contains an invalid entry.");
    }
    manifestIds.add(key);
  }

  const sourceIds = new Set<string>();
  for (const [index, source] of sourceDefinitions.entries()) {
    if (!source || typeof source !== "object") {
      throw new TypeError(
        `Migration source at index ${index} must be an object.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(source, "checksum")) {
      throw new Error(
        "Migration source definitions must not provide a checksum.",
      );
    }
    if (typeof source.id !== "string" || !MIGRATION_ID_PATTERN.test(source.id)) {
      throw new Error(
        `Migration source at index ${index} has an invalid id; expected YYYYMMDD_NNN_kebab-slug.`,
      );
    }
    if (sourceIds.has(source.id)) {
      throw new Error("Migration source definitions contain a duplicate id.");
    }
    sourceIds.add(source.id);
  }

  if (
    sourceIds.size !== manifestIds.size ||
    [...sourceIds].some((id) => !manifestIds.has(id))
  ) {
    throw new Error(
      "Migration checksum manifest and source definitions must contain exactly the same ids.",
    );
  }

  const registry = sourceDefinitions.map((source) =>
    Object.freeze({
      ...source,
      checksum: checksumManifest[source.id]!,
    }),
  );
  validateMigrationRegistry(registry);
  return Object.freeze(registry);
}

// Imports and checksums are generated together from src/migrations/versions.
export const MIGRATION_REGISTRY: readonly MigrationDefinition[] =
  buildMigrationRegistry(MIGRATION_SOURCE_DEFINITIONS, MIGRATION_CHECKSUMS);

validateMigrationRegistry(MIGRATION_REGISTRY);
