import { mongo, type Connection } from "mongoose";
import type {
  Abortable,
  AbstractCursor,
  AggregateOptions,
  AggregationCursor,
  Collection,
  Document,
  Filter,
  FindCursor,
  FindOptions,
  IndexDescriptionInfo,
  ListIndexesCursor,
  ListIndexesOptions,
  Sort,
  SortDirection,
  WithId,
} from "mongodb";
import {
  MIGRATION_LEASE_COLLECTION_NAME,
  MIGRATION_LEDGER_COLLECTION_NAME,
} from "../../migrations/constants";
import { MigrationUsageError } from "./MigrationErrors";

const MAX_COLLECTION_NAME_LENGTH = 120;
const MAX_PIPELINE_DEPTH = 100;
const MAX_PIPELINE_VALUES = 50_000;
const MAX_PIPELINE_SCALAR_BYTES = 16 * 1024 * 1024;
const COLLECTION_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;
const PROHIBITED_AGGREGATION_STAGES = new Set(["$merge", "$out"]);
const MIGRATION_AGGREGATE_OPTION_KEYS = new Set([
  "allowDiskUse",
  "batchSize",
  "collation",
  "comment",
  "hint",
  "let",
  "maxTimeMS",
  "signal",
  "timeoutMS",
]);
const MIGRATION_COUNT_OPTION_KEYS = new Set([
  ...MIGRATION_AGGREGATE_OPTION_KEYS,
  "limit",
  "skip",
]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
export { MIGRATION_LEASE_COLLECTION_NAME, MIGRATION_LEDGER_COLLECTION_NAME };
export const RESERVED_MIGRATION_COLLECTION_NAMES: readonly string[] =
  Object.freeze([
    MIGRATION_LEDGER_COLLECTION_NAME,
    MIGRATION_LEASE_COLLECTION_NAME,
  ]);
const RESERVED_MIGRATION_COLLECTION_NAME_SET = new Set(
  RESERVED_MIGRATION_COLLECTION_NAMES,
);
const NOT_A_SAFE_SCALAR = Symbol("NOT_A_SAFE_SCALAR");
const REGEXP_SOURCE_GETTER = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "source",
)?.get;
const REGEXP_FLAGS_GETTER = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  "flags",
)?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const DATA_VIEW_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)?.get;
const DATA_VIEW_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
)?.get;
const DATA_VIEW_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)?.get;

export interface MigrationReadCursor<TSchema> {
  toArray(): Promise<TSchema[]>;
  next(): Promise<TSchema | null>;
  tryNext(): Promise<TSchema | null>;
  hasNext(): Promise<boolean>;
  forEach(iterator: (document: TSchema) => boolean | void): Promise<void>;
  close(options?: { readonly timeoutMS?: number }): Promise<void>;
}

export interface MigrationFindCursor<TSchema>
  extends MigrationReadCursor<TSchema> {
  sort(sort: Sort | string, direction?: SortDirection): this;
  limit(value: number): this;
  skip(value: number): this;
  project<TResult extends Document = Document>(
    value: Document,
  ): MigrationFindCursor<TResult>;
}

export interface MigrationAggregationCursor<TSchema>
  extends MigrationReadCursor<TSchema> {
  sort(sort: Sort): this;
  limit(value: number): this;
  skip(value: number): this;
  project<TResult extends Document = Document>(
    value: Document,
  ): MigrationAggregationCursor<TResult>;
  match(value: Document): this;
}

export interface MigrationAggregateReadOptions {
  readonly allowDiskUse?: AggregateOptions["allowDiskUse"];
  readonly batchSize?: AggregateOptions["batchSize"];
  readonly collation?: AggregateOptions["collation"];
  readonly comment?: string;
  readonly hint?: AggregateOptions["hint"];
  readonly let?: AggregateOptions["let"];
  readonly maxTimeMS?: AggregateOptions["maxTimeMS"];
  readonly signal?: AbortSignal;
  readonly timeoutMS?: AggregateOptions["timeoutMS"];
}

export interface MigrationCountDocumentsOptions
  extends MigrationAggregateReadOptions {
  readonly limit?: number;
  readonly skip?: number;
}

export interface MigrationReadCollection<
  TSchema extends Document = Document,
> {
  find(): MigrationFindCursor<WithId<TSchema>>;
  find(
    filter: Filter<TSchema>,
    options?: FindOptions & Abortable,
  ): MigrationFindCursor<WithId<TSchema>>;
  find<TResult extends Document>(
    filter: Filter<TSchema>,
    options?: FindOptions & Abortable,
  ): MigrationFindCursor<TResult>;
  readonly findOne: Collection<TSchema>["findOne"];
  countDocuments(
    filter?: Filter<TSchema>,
    options?: MigrationCountDocumentsOptions,
  ): Promise<number>;
  readonly estimatedDocumentCount: Collection<TSchema>["estimatedDocumentCount"];
  readonly distinct: Collection<TSchema>["distinct"];
  listIndexes(options?: ListIndexesOptions): MigrationReadCursor<IndexDescriptionInfo>;
  aggregate<TResult extends Document = Document>(
    pipeline?: Document[],
    options?: MigrationAggregateReadOptions,
  ): MigrationAggregationCursor<TResult>;
}

export interface MigrationReadDatabase {
  readonly collection: <TSchema extends Document = Document>(
    name: string,
  ) => MigrationReadCollection<TSchema>;
}

interface PipelineCloneState {
  readonly ancestors: WeakSet<object>;
  values: number;
}

function invalidPipeline(): never {
  throw new MigrationUsageError("Migration aggregate pipeline is invalid.");
}

function pipelinePrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return invalidPipeline();
  }
}

function pipelineDescriptors(
  value: object,
): Record<PropertyKey, PropertyDescriptor> {
  try {
    return Object.getOwnPropertyDescriptors(value) as Record<
      PropertyKey,
      PropertyDescriptor
    >;
  } catch {
    return invalidPipeline();
  }
}

function requireDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): PropertyDescriptor & { readonly value: unknown } {
  if (
    !descriptor ||
    !descriptor.enumerable ||
    !("value" in descriptor) ||
    descriptor.get ||
    descriptor.set
  ) {
    return invalidPipeline();
  }
  return descriptor as PropertyDescriptor & { readonly value: unknown };
}

interface ExpectedOwnDescriptor {
  readonly enumerable: boolean;
  readonly writable: boolean;
  readonly configurable: boolean;
}

const BSON_FIELD_DESCRIPTOR: ExpectedOwnDescriptor = Object.freeze({
  enumerable: true,
  writable: true,
  configurable: true,
});
const REGEXP_LAST_INDEX_DESCRIPTOR: ExpectedOwnDescriptor = Object.freeze({
  enumerable: false,
  writable: true,
  configurable: false,
});

function requireExactDataDescriptors(
  value: object,
  expected: Readonly<Record<string, ExpectedOwnDescriptor>>,
): Readonly<Record<string, unknown>> {
  const descriptors = pipelineDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== Object.keys(expected).length ||
    keys.some((key) => typeof key !== "string" || !(key in expected))
  ) {
    return invalidPipeline();
  }

  const fields: Record<string, unknown> = {};
  for (const [key, expectedDescriptor] of Object.entries(expected)) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.get ||
      descriptor.set ||
      descriptor.enumerable !== expectedDescriptor.enumerable ||
      descriptor.writable !== expectedDescriptor.writable ||
      descriptor.configurable !== expectedDescriptor.configurable
    ) {
      return invalidPipeline();
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function bsonFields(
  value: object,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  return requireExactDataDescriptors(
    value,
    Object.fromEntries(
      names.map((name) => [name, BSON_FIELD_DESCRIPTOR]),
    ),
  );
}

function cloneByteSequence(value: unknown): Uint8Array {
  if (value === null || typeof value !== "object") {
    return invalidPipeline();
  }
  const prototype = pipelinePrototype(value);
  if (prototype !== Buffer.prototype && prototype !== Uint8Array.prototype) {
    return invalidPipeline();
  }

  const descriptors = pipelineDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > MAX_PIPELINE_SCALAR_BYTES ||
    keys.some(
      (key) =>
        typeof key !== "string" || !ARRAY_INDEX_PATTERN.test(key),
    )
  ) {
    return invalidPipeline();
  }

  const bytes = new Uint8Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.get ||
      descriptor.set ||
      descriptor.enumerable !== true ||
      descriptor.writable !== true ||
      descriptor.configurable !== true ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return invalidPipeline();
    }
    bytes[index] = descriptor.value;
  }
  return bytes;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") return invalidPipeline();
  return value;
}

function requireInt32(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < -2_147_483_648 ||
    Number(value) > 2_147_483_647
  ) {
    return invalidPipeline();
  }
  return Number(value);
}

function constructScalar<TResult>(factory: () => TResult): TResult {
  try {
    return factory();
  } catch {
    return invalidPipeline();
  }
}

function cloneSafeScalar(
  value: object,
  prototype: object | null,
): unknown | typeof NOT_A_SAFE_SCALAR {
  if (prototype === Date.prototype) {
    requireExactDataDescriptors(value, {});
    return constructScalar(
      () => new Date(Reflect.apply(Date.prototype.getTime, value, [])),
    );
  }
  if (prototype === RegExp.prototype) {
    const fields = requireExactDataDescriptors(value, {
      lastIndex: REGEXP_LAST_INDEX_DESCRIPTOR,
    });
    if (!REGEXP_SOURCE_GETTER || !REGEXP_FLAGS_GETTER) {
      return invalidPipeline();
    }
    return constructScalar(() => {
      const cloned = new RegExp(
        Reflect.apply(REGEXP_SOURCE_GETTER, value, []),
        Reflect.apply(REGEXP_FLAGS_GETTER, value, []),
      );
      cloned.lastIndex = requireNonNegativeInteger(fields.lastIndex);
      return cloned;
    });
  }
  if (prototype === Buffer.prototype) {
    return Buffer.from(cloneByteSequence(value));
  }
  if (prototype === Uint8Array.prototype) {
    return cloneByteSequence(value);
  }
  if (prototype === ArrayBuffer.prototype) {
    requireExactDataDescriptors(value, {});
    if (!ARRAY_BUFFER_LENGTH_GETTER) return invalidPipeline();
    return constructScalar(() => {
      const length = Reflect.apply(ARRAY_BUFFER_LENGTH_GETTER, value, []);
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_PIPELINE_SCALAR_BYTES
      ) {
        return invalidPipeline();
      }
      return new Uint8Array(value as ArrayBuffer, 0, length).slice().buffer;
    });
  }
  if (prototype === DataView.prototype) {
    requireExactDataDescriptors(value, {});
    if (
      !DATA_VIEW_BUFFER_GETTER ||
      !DATA_VIEW_OFFSET_GETTER ||
      !DATA_VIEW_LENGTH_GETTER
    ) {
      return invalidPipeline();
    }
    return constructScalar(() => {
      const buffer = Reflect.apply(DATA_VIEW_BUFFER_GETTER, value, []);
      const offset = Reflect.apply(DATA_VIEW_OFFSET_GETTER, value, []);
      const length = Reflect.apply(DATA_VIEW_LENGTH_GETTER, value, []);
      if (
        !(buffer instanceof ArrayBuffer) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_PIPELINE_SCALAR_BYTES
      ) {
        return invalidPipeline();
      }
      const copied = new Uint8Array(buffer, offset, length).slice();
      return new DataView(copied.buffer);
    });
  }
  if (prototype === mongo.ObjectId.prototype) {
    const fields = bsonFields(value, ["buffer"]);
    const bytes = cloneByteSequence(fields.buffer);
    if (bytes.length !== 12) return invalidPipeline();
    return constructScalar(() => new mongo.ObjectId(bytes));
  }
  if (prototype === mongo.Binary.prototype) {
    const fields = bsonFields(value, ["sub_type", "buffer", "position"]);
    const subtype = requireNonNegativeInteger(fields.sub_type);
    const position = requireNonNegativeInteger(fields.position);
    const bytes = cloneByteSequence(fields.buffer);
    if (subtype > 255 || position > bytes.length) return invalidPipeline();
    return constructScalar(
      () => new mongo.Binary(bytes.slice(0, position), subtype),
    );
  }
  if (prototype === mongo.UUID.prototype) {
    const fields = bsonFields(value, ["sub_type", "buffer", "position"]);
    const subtype = requireNonNegativeInteger(fields.sub_type);
    const position = requireNonNegativeInteger(fields.position);
    const bytes = cloneByteSequence(fields.buffer);
    if (subtype !== 4 || position !== 16 || bytes.length < 16) {
      return invalidPipeline();
    }
    return constructScalar(() => new mongo.UUID(bytes.slice(0, 16)));
  }
  if (prototype === mongo.BSONRegExp.prototype) {
    const fields = bsonFields(value, ["pattern", "options"]);
    if (
      typeof fields.pattern !== "string" ||
      typeof fields.options !== "string"
    ) {
      return invalidPipeline();
    }
    return constructScalar(
      () =>
        new mongo.BSONRegExp(
          fields.pattern as string,
          fields.options as string,
        ),
    );
  }
  if (prototype === mongo.BSONSymbol.prototype) {
    const fields = bsonFields(value, ["value"]);
    if (typeof fields.value !== "string") return invalidPipeline();
    return new mongo.BSONSymbol(fields.value);
  }
  if (prototype === mongo.Decimal128.prototype) {
    const fields = bsonFields(value, ["bytes"]);
    const bytes = cloneByteSequence(fields.bytes);
    if (bytes.length !== 16) return invalidPipeline();
    return constructScalar(() => new mongo.Decimal128(bytes));
  }
  if (prototype === mongo.Double.prototype) {
    const fields = bsonFields(value, ["value"]);
    return constructScalar(() => new mongo.Double(requireNumber(fields.value)));
  }
  if (prototype === mongo.Int32.prototype) {
    const fields = bsonFields(value, ["value"]);
    return constructScalar(() => new mongo.Int32(requireInt32(fields.value)));
  }
  if (prototype === mongo.Long.prototype) {
    const fields = bsonFields(value, ["low", "high", "unsigned"]);
    if (typeof fields.unsigned !== "boolean") return invalidPipeline();
    return constructScalar(
      () =>
        new mongo.Long(
          requireInt32(fields.low),
          requireInt32(fields.high),
          fields.unsigned as boolean,
        ),
    );
  }
  if (prototype === mongo.Timestamp.prototype) {
    const fields = bsonFields(value, ["low", "high", "unsigned"]);
    if (fields.unsigned !== true) return invalidPipeline();
    return constructScalar(() =>
      mongo.Timestamp.fromBits(
        requireInt32(fields.low),
        requireInt32(fields.high),
      ),
    );
  }
  if (prototype === mongo.MaxKey.prototype) {
    requireExactDataDescriptors(value, {});
    return new mongo.MaxKey();
  }
  if (prototype === mongo.MinKey.prototype) {
    requireExactDataDescriptors(value, {});
    return new mongo.MinKey();
  }
  return NOT_A_SAFE_SCALAR;
}

function clonePipelineValue(
  value: unknown,
  depth: number,
  state: PipelineCloneState,
): unknown {
  state.values += 1;
  if (depth > MAX_PIPELINE_DEPTH || state.values > MAX_PIPELINE_VALUES) {
    return invalidPipeline();
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value !== "object") return invalidPipeline();

  const prototype = pipelinePrototype(value);
  const clonedScalar = cloneSafeScalar(value, prototype);
  if (clonedScalar !== NOT_A_SAFE_SCALAR) return clonedScalar;
  if (state.ancestors.has(value)) return invalidPipeline();
  state.ancestors.add(value);

  try {
    const descriptors = pipelineDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return invalidPipeline();
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" &&
              (!ARRAY_INDEX_PATTERN.test(key) ||
                Number(key) >= value.length)),
        )
      ) {
        return invalidPipeline();
      }

      const cloned: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = requireDataDescriptor(descriptors[String(index)]);
        cloned.push(
          clonePipelineValue(descriptor.value, depth + 1, state),
        );
      }
      return cloned;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return invalidPipeline();
    }

    const cloned: Document = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || key === "toBSON") {
        return invalidPipeline();
      }
      if (PROHIBITED_AGGREGATION_STAGES.has(key)) {
        throw new MigrationUsageError(
          "Migration aggregate pipeline contains a prohibited write stage.",
        );
      }
      const descriptor = requireDataDescriptor(descriptors[key]);
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        value: clonePipelineValue(descriptor.value, depth + 1, state),
        writable: true,
      });
    }
    return cloned;
  } finally {
    state.ancestors.delete(value);
  }
}

export function requireMigrationCollectionName(name: string): string {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > MAX_COLLECTION_NAME_LENGTH ||
    !COLLECTION_NAME_PATTERN.test(name) ||
    name.startsWith("system.") ||
    RESERVED_MIGRATION_COLLECTION_NAME_SET.has(name)
  ) {
    throw new MigrationUsageError("Migration collection name is invalid.");
  }
  return name;
}

function requirePipelineCollectionName(value: unknown): void {
  if (typeof value !== "string") return invalidPipeline();
  try {
    requireMigrationCollectionName(value);
  } catch {
    throw new MigrationUsageError(
      "Migration aggregate pipeline references an invalid collection.",
    );
  }
}

function assertPipelineCollectionReferences(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPipelineCollectionReferences(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;

  const document = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(document, "$lookup")) {
    const lookup = document.$lookup;
    if (
      lookup === null ||
      typeof lookup !== "object" ||
      Array.isArray(lookup)
    ) {
      return invalidPipeline();
    }
    const lookupDocument = lookup as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(lookupDocument, "from")) {
      requirePipelineCollectionName(lookupDocument.from);
    }
  }

  if (Object.prototype.hasOwnProperty.call(document, "$graphLookup")) {
    const graphLookup = document.$graphLookup;
    if (
      graphLookup === null ||
      typeof graphLookup !== "object" ||
      Array.isArray(graphLookup)
    ) {
      return invalidPipeline();
    }
    const graphLookupDocument = graphLookup as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(graphLookupDocument, "from")) {
      return invalidPipeline();
    }
    requirePipelineCollectionName(graphLookupDocument.from);
  }

  if (Object.prototype.hasOwnProperty.call(document, "$unionWith")) {
    const unionWith = document.$unionWith;
    if (typeof unionWith === "string") {
      requirePipelineCollectionName(unionWith);
    } else {
      if (
        unionWith === null ||
        typeof unionWith !== "object" ||
        Array.isArray(unionWith)
      ) {
        return invalidPipeline();
      }
      const unionWithDocument = unionWith as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(unionWithDocument, "coll")) {
        requirePipelineCollectionName(unionWithDocument.coll);
      }
    }
  }

  for (const nested of Object.values(document)) {
    assertPipelineCollectionReferences(nested);
  }
}

export function cloneMigrationReadOnlyPipeline(
  pipeline: unknown,
): Document[] | undefined {
  if (pipeline === undefined) return undefined;
  if (
    !Array.isArray(pipeline) ||
    pipelinePrototype(pipeline) !== Array.prototype
  ) {
    return invalidPipeline();
  }

  for (const stage of pipeline) {
    if (
      stage === null ||
      typeof stage !== "object" ||
      Array.isArray(stage)
    ) {
      return invalidPipeline();
    }
    const prototype = pipelinePrototype(stage);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidPipeline();
    }
  }

  const cloned = clonePipelineValue(pipeline, 0, {
    ancestors: new WeakSet<object>(),
    values: 0,
  }) as Document[];
  assertPipelineCollectionReferences(cloned);
  return cloned;
}

export function assertMigrationReadOnlyPipeline(
  pipeline: unknown,
): asserts pipeline is Document[] | undefined {
  void cloneMigrationReadOnlyPipeline(pipeline);
}

function requirePlainOptionObject(value: unknown): Document {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return invalidPipeline();
  }
  const prototype = pipelinePrototype(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidPipeline();
  }
  return clonePipelineValue(value, 0, {
    ancestors: new WeakSet<object>(),
    values: 0,
  }) as Document;
}

function requireNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidPipeline();
  }
  return Number(value);
}

function cloneMigrationReadOperationOptions(
  options: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    return invalidPipeline();
  }
  const prototype = pipelinePrototype(options);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidPipeline();
  }

  const descriptors = pipelineDescriptors(options);
  const cloned: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== "string" ||
      !allowedKeys.has(key)
    ) {
      return invalidPipeline();
    }
    const descriptor = requireDataDescriptor(descriptors[key]);
    const value = descriptor.value;

    switch (key) {
      case "allowDiskUse":
        if (typeof value !== "boolean") return invalidPipeline();
        cloned[key] = value;
        break;
      case "batchSize":
      case "limit":
      case "maxTimeMS":
      case "skip":
      case "timeoutMS":
        cloned[key] = requireNonNegativeInteger(value);
        break;
      case "collation":
      case "let":
        cloned[key] = requirePlainOptionObject(value);
        break;
      case "hint":
        if (typeof value === "string") {
          if (value.length === 0 || value.length > 240) {
            return invalidPipeline();
          }
          cloned[key] = value;
        } else {
          cloned[key] = requirePlainOptionObject(value);
        }
        break;
      case "comment":
        if (
          typeof value !== "string" ||
          value.length > 500 ||
          CONTROL_CHARACTER_PATTERN.test(value)
        ) {
          return invalidPipeline();
        }
        cloned[key] = value;
        break;
      case "signal":
        if (
          typeof AbortSignal === "undefined" ||
          value === null ||
          typeof value !== "object" ||
          pipelinePrototype(value) !== AbortSignal.prototype
        ) {
          return invalidPipeline();
        }
        cloned[key] = value;
        break;
      default:
        return invalidPipeline();
    }
  }
  return cloned;
}

export function cloneMigrationAggregateReadOptions(
  options: unknown,
): MigrationAggregateReadOptions | undefined {
  return cloneMigrationReadOperationOptions(
    options,
    MIGRATION_AGGREGATE_OPTION_KEYS,
  ) as MigrationAggregateReadOptions | undefined;
}

export function cloneMigrationCountDocumentsOptions(
  options: unknown,
): MigrationCountDocumentsOptions | undefined {
  return cloneMigrationReadOperationOptions(
    options,
    MIGRATION_COUNT_OPTION_KEYS,
  ) as MigrationCountDocumentsOptions | undefined;
}

function cursorTerminals<TSchema>(cursor: AbstractCursor<TSchema>) {
  return {
    toArray: () => cursor.toArray(),
    next: () => cursor.next(),
    tryNext: () => cursor.tryNext(),
    hasNext: () => cursor.hasNext(),
    forEach: (iterator: (document: TSchema) => boolean | void) =>
      cursor.forEach((document) => iterator(document)),
    close: (options?: { readonly timeoutMS?: number }) =>
      cursor.close(options),
  };
}

export function createMigrationSafeFindCursor<TSchema>(
  cursor: FindCursor<TSchema>,
): MigrationFindCursor<TSchema> {
  const safeCursor: MigrationFindCursor<TSchema> = Object.freeze({
    ...cursorTerminals(cursor),
    sort(sort: Sort | string, direction?: SortDirection) {
      cursor.sort(sort, direction);
      return safeCursor;
    },
    limit(value: number) {
      cursor.limit(value);
      return safeCursor;
    },
    skip(value: number) {
      cursor.skip(value);
      return safeCursor;
    },
    project<TResult extends Document = Document>(value: Document) {
      cursor.project<TResult>(value);
      return safeCursor as unknown as MigrationFindCursor<TResult>;
    },
  });
  return safeCursor;
}

export function createMigrationSafeAggregationCursor<TSchema>(
  cursor: AggregationCursor<TSchema>,
): MigrationAggregationCursor<TSchema> {
  const safeCursor: MigrationAggregationCursor<TSchema> = Object.freeze({
    ...cursorTerminals(cursor),
    sort(sort: Sort) {
      cursor.sort(sort);
      return safeCursor;
    },
    limit(value: number) {
      cursor.limit(value);
      return safeCursor;
    },
    skip(value: number) {
      cursor.skip(value);
      return safeCursor;
    },
    project<TResult extends Document = Document>(value: Document) {
      cursor.project<TResult>(value);
      return safeCursor as unknown as MigrationAggregationCursor<TResult>;
    },
    match(value: Document) {
      cursor.match(value);
      return safeCursor;
    },
  });
  return safeCursor;
}

export function createMigrationSafeIndexCursor(
  cursor: ListIndexesCursor,
): MigrationReadCursor<IndexDescriptionInfo> {
  const safeCursor: MigrationReadCursor<IndexDescriptionInfo> = Object.freeze({
    ...cursorTerminals(cursor),
  });
  return safeCursor;
}

function createMigrationReadCollection<TSchema extends Document>(
  collection: Collection<TSchema>,
): MigrationReadCollection<TSchema> {
  const find = ((...args: unknown[]) => {
    const cursor = Reflect.apply(
      collection.find,
      collection,
      args,
    ) as FindCursor<WithId<TSchema>>;
    return createMigrationSafeFindCursor(cursor);
  }) as MigrationReadCollection<TSchema>["find"];
  const listIndexes = ((...args: unknown[]) => {
    const cursor = Reflect.apply(
      collection.listIndexes,
      collection,
      args,
    ) as ListIndexesCursor;
    return createMigrationSafeIndexCursor(cursor);
  }) as MigrationReadCollection<TSchema>["listIndexes"];
  const countDocuments = ((...args: unknown[]) => {
    const forwardedArgs = [...args];
    if (forwardedArgs.length > 1) {
      forwardedArgs[1] = cloneMigrationCountDocumentsOptions(
        forwardedArgs[1],
      );
    }
    return Reflect.apply(
      collection.countDocuments,
      collection,
      forwardedArgs,
    ) as Promise<number>;
  }) as MigrationReadCollection<TSchema>["countDocuments"];
  const aggregate = ((...args: unknown[]) => {
    const forwardedArgs = [...args];
    if (forwardedArgs.length > 0) {
      forwardedArgs[0] = cloneMigrationReadOnlyPipeline(forwardedArgs[0]);
    }
    if (forwardedArgs.length > 1) {
      forwardedArgs[1] = cloneMigrationAggregateReadOptions(
        forwardedArgs[1],
      );
    }
    const cursor = Reflect.apply(
      collection.aggregate,
      collection,
      forwardedArgs,
    ) as AggregationCursor<Document>;
    return createMigrationSafeAggregationCursor(cursor);
  }) as MigrationReadCollection<TSchema>["aggregate"];

  return Object.freeze({
    find,
    findOne: collection.findOne.bind(collection),
    countDocuments,
    estimatedDocumentCount: collection.estimatedDocumentCount.bind(collection),
    distinct: collection.distinct.bind(collection),
    listIndexes,
    aggregate,
  });
}

export function createMigrationReadDatabase(
  connection: Connection,
): MigrationReadDatabase {
  const database = connection.db;
  if (!database) {
    throw new MigrationUsageError(
      "Migration read database is unavailable.",
    );
  }

  return Object.freeze({
    collection<TSchema extends Document = Document>(
      name: string,
    ): MigrationReadCollection<TSchema> {
      const collectionName = requireMigrationCollectionName(name);
      return createMigrationReadCollection(
        database.collection<TSchema>(collectionName),
      );
    },
  });
}
