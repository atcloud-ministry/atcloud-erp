import type { MigrationSourceDefinition } from "../types";

type Checkpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
};

type UserDocument = { readonly _id?: unknown; readonly [key: string]: unknown };

/** Existing profiles are never changed. Rollback retains member-owned drafts. */
export const migration = {
  id: "20260921_002_backfill-private-alumni-drafts",
  description: "Create private Alumni Profile drafts for structurally complete active legacy accounts without profiles.",

  plan: async (context) => {
    context.signal?.throwIfAborted();
    const examined = await context.database.collection("users").countDocuments({ isActive: true });
    return {
      summary: "Backfill missing private drafts for structurally complete active accounts.",
      counts: { examined, matched: 0, modified: 0, skipped: examined, errors: 0 },
      estimatedBatches: Math.max(1, Math.ceil(examined / context.batchSize)),
      warnings: [],
    };
  },

  up: async (context) => {
    context.signal?.throwIfAborted();
    const users = context.database.collection<UserDocument>("users");
    const profiles = context.database.collection("alumni_profiles");
    const prior = context.checkpoint as Checkpoint | null;
    let highWatermark = prior?.highWatermark ?? null;
    const lastId = prior?.lastId ?? null;
    if (context.checkpoint === null) {
      const newest = await users.find({ isActive: true }).sort({ _id: -1 }).limit(1).next();
      highWatermark = newest?._id == null ? null : String(newest._id);
    }
    for (const id of [highWatermark, lastId]) {
      if (id !== null && !/^[a-f\d]{24}$/i.test(id)) {
        throw new Error("Private Alumni draft backfill checkpoint is invalid.");
      }
    }
    if (highWatermark === null) {
      return {
        done: true, checkpoint: { highWatermark: null, lastId: null },
        counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
      };
    }
    // A conservative storage filter provisions private drafts only. Publish
    // separately enforces the live registration-profile validator.
    const complete = {
      isActive: true,
      phone: /^\+[1-9]\d{7,14}$/,
      birthYear: { $gte: 1900, $lte: new Date().getUTCFullYear() },
      residenceCity: { $type: "string", $ne: "" },
      residenceCountryCode: /^[A-Z]{2}$/,
      employmentStatus: { $in: ["employed", "self_employed", "student", "not_currently_employed", "retired"] },
      $and: [{ $or: [
        { residenceCountryCode: { $ne: "US" } },
        { residenceRegion: /^US-[A-Z0-9]+$/ },
      ] }],
      $or: [
        { employmentStatus: { $nin: ["employed", "self_employed"] } },
        { company: { $type: "string", $ne: "" } },
      ],
    };
    const page = await users.find({
      ...complete,
      $expr: { $and: [
        { $lte: ["$_id", { $toObjectId: highWatermark }] },
        ...(lastId ? [{ $gt: ["$_id", { $toObjectId: lastId }] }] : []),
      ] },
    }).sort({ _id: 1 }).limit(context.batchSize + 1).toArray();
    const batch = page.slice(0, context.batchSize);
    let modified = 0;
    for (const user of batch) {
      context.signal?.throwIfAborted();
      const value = (source: unknown): string => typeof source === "string" ? source : "";
      const normalize = (source: string): string => source.normalize("NFC")
        .replace(/\s+/gu, " ").trim().normalize("NFKD").replace(/\p{M}+/gu, "")
        .toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/gu, " ").trim();
      const key = (source: string): string => Array.from(normalize(source)).slice(0, 200).join("");
      const name = [value(user.firstName), value(user.lastName)].filter(Boolean).join(" ").trim() || value(user.username) || "Member";
      const location = value(user.residenceCity).trim() || value(user.residenceRegion).trim() || value(user.residenceCountryCode).trim();
      const now = new Date();
      try {
        const result = await profiles.updateOne(
          { userId: user._id },
          { $setOnInsert: {
          userId: user._id,
          professionalHeadline: null, industry: null, skills: [], bio: null,
          helpOfferings: { careerAdvice: false, warmIntroduction: false, formalEmployeeReferral: false },
          publishStatus: "draft",
          searchProjection: {
            searchText: Array.from(normalize([name, value(user.company), location].join(" "))).slice(0, 4_000).join(""),
            displayNameKey: key(name), companyKey: key(value(user.company)),
            occupationKey: key(value(user.occupation)), industryKey: "", skillKeys: [],
            generalLocationKey: key(location), cohortKeys: [],
          },
          publishedAt: null, withdrawnAt: null, accountDeletionApprovedAt: null, purgeAt: null,
          revision: 0, createdAt: now, updatedAt: now,
          } },
          { upsert: true },
        );
        modified += result.upsertedCount;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 11000 ||
          !(await profiles.findOne({ userId: user._id }, { projection: { _id: 1 } }))) {
          throw error;
        }
      }
    }
    return {
      done: page.length <= context.batchSize,
      checkpoint: {
        highWatermark,
        lastId: batch[batch.length - 1]?._id == null ? lastId : String(batch[batch.length - 1]!._id),
      },
      counts: { examined: batch.length, matched: modified, modified, skipped: batch.length - modified, errors: 0 },
    };
  },

  down: async (context) => {
    context.signal?.throwIfAborted();
    return {
      done: true, checkpoint: null,
      counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
    };
  },

  verify: async (context) => {
    context.signal?.throwIfAborted();
    if (context.direction === "down") {
      return {
        ok: true, summary: "Private drafts are retained because members may have edited or published them.",
        counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
      };
    }
    const highWatermark = (context.appliedCheckpoint as Checkpoint | null)?.highWatermark ?? null;
    if (highWatermark === null) {
      return {
        ok: true, summary: "No active legacy accounts required backfill.",
        counts: { examined: 0, matched: 0, modified: 0, skipped: 0, errors: 0 },
      };
    }
    if (!/^[a-f\d]{24}$/i.test(highWatermark)) {
      throw new Error("Private Alumni draft backfill applied checkpoint is invalid.");
    }
    const users = context.database.collection<UserDocument>("users");
    const profiles = context.database.collection("alumni_profiles");
    const complete = {
      isActive: true,
      phone: /^\+[1-9]\d{7,14}$/,
      birthYear: { $gte: 1900, $lte: new Date().getUTCFullYear() },
      residenceCity: { $type: "string", $ne: "" },
      residenceCountryCode: /^[A-Z]{2}$/,
      employmentStatus: { $in: ["employed", "self_employed", "student", "not_currently_employed", "retired"] },
      $and: [{ $or: [
        { residenceCountryCode: { $ne: "US" } },
        { residenceRegion: /^US-[A-Z0-9]+$/ },
      ] }],
      $or: [
        { employmentStatus: { $nin: ["employed", "self_employed"] } },
        { company: { $type: "string", $ne: "" } },
      ],
    };
    let examined = 0;
    let missing = 0;
    let lastId: string | null = null;
    while (true) {
      const page = await users.find({
        ...complete,
        $expr: { $and: [
          { $lte: ["$_id", { $toObjectId: highWatermark }] },
          ...(lastId ? [{ $gt: ["$_id", { $toObjectId: lastId }] }] : []),
        ] },
      }).sort({ _id: 1 }).limit(500).toArray();
      for (const user of page) {
        context.signal?.throwIfAborted();
        examined += 1;
        if (!(await profiles.findOne({ userId: user._id }, { projection: { _id: 1 } }))) missing += 1;
      }
      if (page.length < 500) break;
      lastId = String(page[page.length - 1]!._id);
    }
    return {
      ok: missing === 0,
      summary: "Verified structurally complete active legacy accounts have an Alumni Profile.",
      counts: { examined, matched: examined - missing, modified: 0, skipped: 0, errors: missing },
    };
  },
} satisfies MigrationSourceDefinition;
