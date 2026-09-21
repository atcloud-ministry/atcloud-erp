import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { ClientSession, Model } from "mongoose";
import FileCleanupJob, {
  FILE_CLEANUP_STORAGE_AREAS,
  type FileCleanupStorageArea,
  type IFileCleanupJob,
} from "../../models/FileCleanupJob";
import Event from "../../models/Event";
import Program from "../../models/Program";
import User from "../../models/User";
import { Logger } from "../LoggerService";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BASE_RETRY_MS = 60_000;
const DEFAULT_MAX_RETRY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 50;

const log = Logger.getInstance().child("FileCleanupService");

export interface FileCleanupTarget {
  readonly storageArea: FileCleanupStorageArea;
  readonly filename: string;
}

export interface NormalizedFileCleanupTarget {
  readonly jobKey: string;
  readonly storageArea: FileCleanupStorageArea;
  readonly filename: string;
}

export type FileCleanupAttemptOutcome =
  | "deleted"
  | "already_absent"
  | "still_referenced"
  | "retry_scheduled"
  | "not_due";

export interface FileCleanupAttemptResult {
  readonly target: NormalizedFileCleanupTarget;
  readonly outcome: FileCleanupAttemptOutcome;
}

interface FileCleanupModelPort {
  bulkWrite: Model<IFileCleanupJob>["bulkWrite"];
  findOneAndUpdate: Model<IFileCleanupJob>["findOneAndUpdate"];
  deleteOne: Model<IFileCleanupJob>["deleteOne"];
  updateOne: Model<IFileCleanupJob>["updateOne"];
}

interface FileCleanupServiceDependencies {
  readonly model?: FileCleanupModelPort;
  readonly now?: () => Date;
  readonly createLeaseToken?: () => string;
  readonly unlink?: (filePath: string) => Promise<void>;
  readonly isReferenced?: (
    target: NormalizedFileCleanupTarget,
  ) => Promise<boolean>;
  readonly uploadRoot?: () => string;
  readonly leaseMs?: number;
  readonly baseRetryMs?: number;
  readonly maxRetryMs?: number;
}

function uploadRoot(): string {
  const configured = process.env.UPLOAD_DESTINATION?.replace(/\/$/u, "");
  if (configured) return path.resolve(configured);
  if (process.env.NODE_ENV === "production") return "/uploads";
  return path.resolve(process.cwd(), "uploads");
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function normalizeFilename(filename: string): string {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new TypeError("File cleanup requires a filename.");
  }
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    path.basename(filename) !== filename
  ) {
    throw new TypeError("File cleanup filename is invalid.");
  }
  return filename;
}

const ABSOLUTE_URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const ENCODED_PATH_CONTROL = /%(?:2e|2f|5c)/iu;
const RAW_DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u;

function configuredTrustedUploadOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const key of [
    "BACKEND_URL",
    "RENDER_EXTERNAL_URL",
    "API_BASE_URL",
  ] as const) {
    const configured = process.env[key]?.trim();
    if (!configured) continue;
    try {
      const parsed = new URL(configured);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username.length > 0 ||
        parsed.password.length > 0
      ) {
        continue;
      }
      origins.add(parsed.origin);
    } catch {
      // Invalid deployment configuration cannot authorize an absolute URL.
    }
  }
  return origins;
}

/**
 * Convert a stored public upload URL into the only on-disk target that may be
 * erased. Absolute URLs are accepted because getFileUrl persists them in
 * production; absolute references additionally require a configured trusted
 * backend origin.
 */
export function canonicalizeLocalUploadReference(
  fileReference: string | null | undefined,
  expectedStorageArea: FileCleanupStorageArea,
): FileCleanupTarget | null {
  if (
    typeof fileReference !== "string" ||
    fileReference.trim().length === 0 ||
    fileReference.length > 2_048
  ) {
    return null;
  }
  const raw = fileReference.trim();
  if (
    raw.startsWith("//") ||
    raw.includes("\\") ||
    raw.includes("\0") ||
    ENCODED_PATH_CONTROL.test(raw) ||
    RAW_DOT_SEGMENT.test(raw)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    if (ABSOLUTE_URL_SCHEME.test(raw)) {
      parsed = new URL(raw);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username.length > 0 ||
        parsed.password.length > 0
      ) {
        return null;
      }
      if (!configuredTrustedUploadOrigins().has(parsed.origin)) return null;
    } else {
      if (!raw.startsWith("/")) return null;
      parsed = new URL(raw, "http://local");
    }
  } catch {
    return null;
  }

  const match = /^\/uploads\/(avatars|images|events)\/([^/]+)$/u.exec(
    parsed.pathname,
  );
  if (!match || match[1] !== expectedStorageArea) return null;

  let filename: string;
  try {
    filename = decodeURIComponent(match[2]);
    filename = normalizeFilename(filename);
  } catch {
    return null;
  }
  return Object.freeze({ storageArea: expectedStorageArea, filename });
}

export function normalizeFileCleanupTarget(
  target: FileCleanupTarget,
): NormalizedFileCleanupTarget {
  if (!FILE_CLEANUP_STORAGE_AREAS.includes(target.storageArea)) {
    throw new TypeError("File cleanup storage area is invalid.");
  }
  const filename = normalizeFilename(target.filename);
  return Object.freeze({
    jobKey: crypto
      .createHash("sha256")
      .update(`${target.storageArea}\0${filename}`, "utf8")
      .digest("hex"),
    storageArea: target.storageArea,
    filename,
  });
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function safeErrorCode(
  error: unknown,
  fallback = "FILE_DELETE_FAILED",
): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const raw = String((error as NodeJS.ErrnoException).code ?? "");
    if (/^[A-Z0-9_]{1,80}$/u.test(raw)) return raw;
  }
  return fallback;
}

async function isAuthoritativelyReferenced(
  target: NormalizedFileCleanupTarget,
): Promise<boolean> {
  const matchesTarget = (reference: unknown): boolean => {
    if (typeof reference !== "string") return false;
    const canonical = canonicalizeLocalUploadReference(
      reference,
      target.storageArea,
    );
    return canonical?.filename === target.filename;
  };

  if (target.storageArea === "avatars") {
    const users = (await User.find(
      { avatar: { $type: "string" } },
      { _id: 0, avatar: 1 },
    )
      .lean()
      .exec()) as Array<{ readonly avatar?: unknown }>;
    return users.some((user) => matchesTarget(user.avatar));
  }

  const [events, programs] = await Promise.all([
    Event.find(
      {
        $or: [
          { flyerUrl: { $type: "string" } },
          { secondaryFlyerUrl: { $type: "string" } },
        ],
      },
      { _id: 0, flyerUrl: 1, secondaryFlyerUrl: 1 },
    )
      .lean()
      .exec() as Promise<
      Array<{
        readonly flyerUrl?: unknown;
        readonly secondaryFlyerUrl?: unknown;
      }>
    >,
    Program.find(
      { flyerUrl: { $type: "string" } },
      { _id: 0, flyerUrl: 1 },
    )
      .lean()
      .exec() as Promise<Array<{ readonly flyerUrl?: unknown }>>,
  ]);
  return (
    events.some(
      (event) =>
        matchesTarget(event.flyerUrl) ||
        matchesTarget(event.secondaryFlyerUrl),
    ) || programs.some((program) => matchesTarget(program.flyerUrl))
  );
}

/**
 * Durable local-asset erasure. Jobs are inserted in the owning database
 * transaction, leased atomically, and retained without an attempt ceiling until
 * unlink succeeds or the operating system confirms the file is absent.
 */
export class FileCleanupService {
  private readonly model: FileCleanupModelPort;
  private readonly now: () => Date;
  private readonly createLeaseToken: () => string;
  private readonly unlink: (filePath: string) => Promise<void>;
  private readonly isReferenced: (
    target: NormalizedFileCleanupTarget,
  ) => Promise<boolean>;
  private readonly resolveUploadRoot: () => string;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(dependencies: FileCleanupServiceDependencies = {}) {
    this.model = dependencies.model ?? (FileCleanupJob as FileCleanupModelPort);
    this.now = dependencies.now ?? (() => new Date());
    this.createLeaseToken = dependencies.createLeaseToken ?? crypto.randomUUID;
    this.unlink = dependencies.unlink ?? ((filePath) => fs.unlink(filePath));
    this.isReferenced =
      dependencies.isReferenced ?? isAuthoritativelyReferenced;
    this.resolveUploadRoot = dependencies.uploadRoot ?? uploadRoot;
    this.leaseMs = requirePositiveInteger(
      dependencies.leaseMs ?? DEFAULT_LEASE_MS,
      "leaseMs",
    );
    this.baseRetryMs = requirePositiveInteger(
      dependencies.baseRetryMs ?? DEFAULT_BASE_RETRY_MS,
      "baseRetryMs",
    );
    this.maxRetryMs = requirePositiveInteger(
      dependencies.maxRetryMs ?? DEFAULT_MAX_RETRY_MS,
      "maxRetryMs",
    );
    if (this.maxRetryMs < this.baseRetryMs) {
      throw new TypeError("maxRetryMs must be at least baseRetryMs.");
    }
  }

  async enqueueInTransaction(
    targets: readonly FileCleanupTarget[],
    session: ClientSession,
  ): Promise<readonly NormalizedFileCleanupTarget[]> {
    return this.enqueue(targets, session);
  }

  async enqueueStandalone(
    targets: readonly FileCleanupTarget[],
  ): Promise<readonly NormalizedFileCleanupTarget[]> {
    return this.enqueue(targets);
  }

  private async enqueue(
    targets: readonly FileCleanupTarget[],
    session?: ClientSession,
  ): Promise<readonly NormalizedFileCleanupTarget[]> {
    const normalized = targets.map(normalizeFileCleanupTarget);
    const unique = [
      ...new Map(normalized.map((item) => [item.jobKey, item])).values(),
    ];
    if (unique.length === 0) return Object.freeze([]);
    const now = this.now();
    await this.model.bulkWrite(
      unique.map((target) => ({
        updateOne: {
          filter: { jobKey: target.jobKey },
          update: {
            $setOnInsert: {
              ...target,
              attemptCount: 0,
              nextAttemptAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
              lastAttemptAt: null,
              lastErrorCode: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          upsert: true,
        },
      })),
      session ? { session, ordered: true } : { ordered: true },
    );
    return Object.freeze(unique);
  }

  async processTargets(
    targets: readonly NormalizedFileCleanupTarget[],
  ): Promise<readonly FileCleanupAttemptResult[]> {
    const results: FileCleanupAttemptResult[] = [];
    for (const target of targets) {
      results.push(await this.processOne(target.jobKey, target));
    }
    return Object.freeze(results);
  }

  async processPending(
    limit = DEFAULT_BATCH_SIZE,
  ): Promise<readonly FileCleanupAttemptResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("File cleanup batch limit must be between 1 and 500.");
    }
    const results: FileCleanupAttemptResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.processOne();
      if (!result) break;
      results.push(result);
    }
    return Object.freeze(results);
  }

  private async scheduleRetry(
    job: Pick<IFileCleanupJob, "_id" | "jobKey" | "attemptCount">,
    leaseToken: string,
    now: Date,
    errorCode: string,
  ): Promise<number> {
    const nextAttemptCount = job.attemptCount + 1;
    const delay = Math.min(
      this.maxRetryMs,
      this.baseRetryMs * 2 ** Math.min(nextAttemptCount - 1, 20),
    );
    await this.model.updateOne(
      { _id: job._id, leaseToken },
      {
        $set: {
          nextAttemptAt: new Date(now.getTime() + delay),
          lastErrorCode: errorCode,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
        $inc: { attemptCount: 1 },
      },
      { runValidators: true },
    );
    return nextAttemptCount;
  }

  private async processOne(
    jobKey?: string,
    expectedTarget?: NormalizedFileCleanupTarget,
  ): Promise<FileCleanupAttemptResult>;
  private async processOne(): Promise<FileCleanupAttemptResult | null>;
  private async processOne(
    jobKey?: string,
    expectedTarget?: NormalizedFileCleanupTarget,
  ): Promise<FileCleanupAttemptResult | null> {
    const now = this.now();
    const leaseToken = this.createLeaseToken();
    const job = await this.model.findOneAndUpdate(
      {
        ...(jobKey ? { jobKey } : {}),
        nextAttemptAt: { $lte: now },
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          lastAttemptAt: now,
          updatedAt: now,
        },
      },
      {
        new: true,
        sort: { nextAttemptAt: 1, _id: 1 },
        runValidators: true,
        select: "+filename",
      },
    );
    if (!job) {
      return expectedTarget
        ? { target: expectedTarget, outcome: "not_due" }
        : null;
    }
    const target = normalizeFileCleanupTarget({
      storageArea: job.storageArea,
      filename: job.filename,
    });
    if (target.jobKey !== job.jobKey) {
      throw new Error("File cleanup job integrity check failed.");
    }
    const root = path.resolve(this.resolveUploadRoot());
    const filePath = path.resolve(root, target.storageArea, target.filename);
    const requiredPrefix = `${path.resolve(root, target.storageArea)}${path.sep}`;
    if (!filePath.startsWith(requiredPrefix)) {
      throw new Error("File cleanup path escaped its storage area.");
    }

    try {
      if (await this.isReferenced(target)) {
        const nextAttemptCount = await this.scheduleRetry(
          job,
          leaseToken,
          now,
          "STILL_REFERENCED",
        );
        log.info(
          "File cleanup deferred while asset remains referenced",
          undefined,
          {
            jobKey: job.jobKey,
            attemptCount: nextAttemptCount,
          },
        );
        return { target, outcome: "still_referenced" };
      }
    } catch (error) {
      const errorCode = safeErrorCode(error, "REFERENCE_CHECK_FAILED");
      const nextAttemptCount = await this.scheduleRetry(
        job,
        leaseToken,
        now,
        errorCode,
      );
      log.warn("File cleanup reference check scheduled for retry", undefined, {
        jobKey: job.jobKey,
        attemptCount: nextAttemptCount,
        errorCode,
      });
      return { target, outcome: "retry_scheduled" };
    }

    let outcome: "deleted" | "already_absent";
    try {
      await this.unlink(filePath);
      outcome = "deleted";
    } catch (error) {
      if (isMissingFile(error)) {
        outcome = "already_absent";
      } else {
        const errorCode = safeErrorCode(error);
        const nextAttemptCount = await this.scheduleRetry(
          job,
          leaseToken,
          now,
          errorCode,
        );
        log.warn("File cleanup scheduled for retry", undefined, {
          jobKey: job.jobKey,
          attemptCount: nextAttemptCount,
          errorCode,
        });
        return { target, outcome: "retry_scheduled" };
      }
    }

    await this.model.deleteOne({ _id: job._id, leaseToken });
    return { target, outcome };
  }
}

export const fileCleanupService = new FileCleanupService();
