import type { MigrationSourceDefinition } from "../types";

type InventoryCounts = {
  readonly usersScanned: number;
  readonly profilesWithObservedIssues: number;
  readonly phoneMissing: number;
  readonly phoneNotCanonicalE164: number;
  readonly birthYearMissing: number;
  readonly birthYearInvalid: number;
  readonly birthYearNotBsonInt: number;
  readonly residenceCityMissing: number;
  readonly residenceCityNotCanonical: number;
  readonly residenceRegionAbsent: number;
  readonly residenceRegionNotCanonical: number;
  readonly residenceCountryMissing: number;
  readonly residenceCountryNotCanonical: number;
  readonly employmentStatusMissing: number;
  readonly employmentStatusNotCanonical: number;
  readonly companyRequiredMissing: number;
  readonly companyRequiredNotCanonical: number;
  readonly companyShouldBeNull: number;
  readonly occupationAbsent: number;
  readonly occupationNotCanonical: number;
  readonly legacyHomeAddressPresent: number;
};

type InventoryCheckpoint = {
  readonly highWatermark: string | null;
  readonly lastId: string | null;
  readonly observedUtcYear: number;
  readonly inventory: InventoryCounts;
};

type UserInventoryDocument = {
  readonly _id?: unknown;
  readonly phone?: unknown;
  readonly birthYear?: unknown;
  readonly residenceCity?: unknown;
  readonly residenceRegion?: unknown;
  readonly residenceCountryCode?: unknown;
  readonly employmentStatus?: unknown;
  readonly company?: unknown;
  readonly occupation?: unknown;
  readonly homeAddress?: unknown;
  readonly __migrationCursorId?: unknown;
  readonly __birthYearBsonType?: unknown;
};

export const migration = {
  id: "20260911_001_inventory-registration-profile",
  description:
    "Inventory existing registration profiles without inferring user data.",

  plan: async (context) => {
    const inventory: Record<keyof InventoryCounts, number> = {
      usersScanned: 0,
      profilesWithObservedIssues: 0,
      phoneMissing: 0,
      phoneNotCanonicalE164: 0,
      birthYearMissing: 0,
      birthYearInvalid: 0,
      birthYearNotBsonInt: 0,
      residenceCityMissing: 0,
      residenceCityNotCanonical: 0,
      residenceRegionAbsent: 0,
      residenceRegionNotCanonical: 0,
      residenceCountryMissing: 0,
      residenceCountryNotCanonical: 0,
      employmentStatusMissing: 0,
      employmentStatusNotCanonical: 0,
      companyRequiredMissing: 0,
      companyRequiredNotCanonical: 0,
      companyShouldBeNull: 0,
      occupationAbsent: 0,
      occupationNotCanonical: 0,
      legacyHomeAddressPresent: 0,
    };
    const observedUtcYear = new Date().getUTCFullYear();
    const validEmploymentStatuses = new Set([
      "employed",
      "self_employed",
      "student",
      "not_currently_employed",
      "retired",
    ]);
    const isMissingText = (value: unknown): boolean =>
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");
    const isDisplayTextNotCanonical = (
      value: unknown,
      required: boolean,
    ): boolean => {
      if (isMissingText(value)) return false;
      if (typeof value !== "string") return true;
      if (/\p{Cc}/u.test(value)) return true;
      const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
      const length = Array.from(normalized).length;
      return (
        (required && length === 0) ||
        length > 100 ||
        normalized !== value
      );
    };
    const classify = (document: UserInventoryDocument): boolean => {
      inventory.usersScanned += 1;
      let observedIssue = false;

      const phone =
        typeof document.phone === "string" ? document.phone.trim() : "";
      if (isMissingText(document.phone)) {
        inventory.phoneMissing += 1;
        observedIssue = true;
      } else if (
        typeof document.phone !== "string" ||
        !/^\+[1-9]\d{7,14}$/.test(phone) ||
        document.phone !== phone
      ) {
        inventory.phoneNotCanonicalE164 += 1;
        observedIssue = true;
      }

      let birthYear = Number.NaN;
      if (document.birthYear === undefined || document.birthYear === null || document.birthYear === "") {
        inventory.birthYearMissing += 1;
        observedIssue = true;
      } else if (
        typeof document.birthYear === "number" ||
        typeof document.birthYear === "string"
      ) {
        birthYear =
          typeof document.birthYear === "number"
            ? document.birthYear
            : /^\d{4}$/.test(document.birthYear.trim())
              ? Number(document.birthYear.trim())
              : Number.NaN;
        if (
          !Number.isInteger(birthYear) ||
          birthYear < 1900 ||
          birthYear > observedUtcYear
        ) {
          inventory.birthYearInvalid += 1;
          observedIssue = true;
        }
      } else {
        inventory.birthYearInvalid += 1;
        observedIssue = true;
      }
      if (
        document.birthYear !== undefined &&
        document.birthYear !== null &&
        document.birthYear !== "" &&
        document.__birthYearBsonType !== "int"
      ) {
        inventory.birthYearNotBsonInt += 1;
        observedIssue = true;
      }

      if (isMissingText(document.residenceCity)) {
        inventory.residenceCityMissing += 1;
        observedIssue = true;
      } else if (isDisplayTextNotCanonical(document.residenceCity, true)) {
        inventory.residenceCityNotCanonical += 1;
        observedIssue = true;
      }

      const country =
        typeof document.residenceCountryCode === "string"
          ? document.residenceCountryCode.trim().toUpperCase()
          : "";
      if (isMissingText(document.residenceCountryCode)) {
        inventory.residenceCountryMissing += 1;
        observedIssue = true;
      } else if (
        typeof document.residenceCountryCode !== "string" ||
        !/^[A-Z]{2}$/.test(country) ||
        document.residenceCountryCode !== country
      ) {
        inventory.residenceCountryNotCanonical += 1;
        observedIssue = true;
      }

      const regionMissing = isMissingText(document.residenceRegion);
      if (regionMissing) {
        inventory.residenceRegionAbsent += 1;
        if (country === "US") observedIssue = true;
      } else {
        const region =
          typeof document.residenceRegion === "string"
            ? document.residenceRegion.trim().toUpperCase()
            : "";
        if (
          typeof document.residenceRegion !== "string" ||
          !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region) ||
          (country !== "" && !region.startsWith(`${country}-`)) ||
          document.residenceRegion !== region
        ) {
          inventory.residenceRegionNotCanonical += 1;
          observedIssue = true;
        }
      }

      const employmentStatus =
        typeof document.employmentStatus === "string"
          ? document.employmentStatus.trim().toLowerCase()
          : "";
      if (isMissingText(document.employmentStatus)) {
        inventory.employmentStatusMissing += 1;
        observedIssue = true;
      } else if (
        !validEmploymentStatuses.has(employmentStatus) ||
        document.employmentStatus !== employmentStatus
      ) {
        inventory.employmentStatusNotCanonical += 1;
        observedIssue = true;
      }

      if (employmentStatus === "employed" || employmentStatus === "self_employed") {
        if (isMissingText(document.company)) {
          inventory.companyRequiredMissing += 1;
          observedIssue = true;
        } else if (isDisplayTextNotCanonical(document.company, true)) {
          inventory.companyRequiredNotCanonical += 1;
          observedIssue = true;
        }
      } else if (
        validEmploymentStatuses.has(employmentStatus) &&
        document.company !== null
      ) {
        inventory.companyShouldBeNull += 1;
        observedIssue = true;
      }

      if (isMissingText(document.occupation)) {
        inventory.occupationAbsent += 1;
      } else if (isDisplayTextNotCanonical(document.occupation, false)) {
        inventory.occupationNotCanonical += 1;
        observedIssue = true;
      }

      if (!isMissingText(document.homeAddress)) {
        inventory.legacyHomeAddressPresent += 1;
      }
      if (observedIssue) inventory.profilesWithObservedIssues += 1;
      return observedIssue;
    };

    const cursor = context.database
      .collection<UserInventoryDocument>("users")
      .aggregate<UserInventoryDocument>([
        {
          $project: {
            phone: 1,
            birthYear: 1,
            residenceCity: 1,
            residenceRegion: 1,
            residenceCountryCode: 1,
            employmentStatus: 1,
            company: 1,
            occupation: 1,
            homeAddress: 1,
            __birthYearBsonType: { $type: "$birthYear" },
          },
        },
      ]);
    await cursor.forEach((document) => {
      classify(document);
    });

    const warningPairs: readonly (readonly [string, number])[] = [
      ["PROFILE_WITH_OBSERVED_ISSUES", inventory.profilesWithObservedIssues],
      ["PHONE_MISSING", inventory.phoneMissing],
      ["PHONE_NOT_CANONICAL_E164", inventory.phoneNotCanonicalE164],
      ["BIRTH_YEAR_MISSING", inventory.birthYearMissing],
      ["BIRTH_YEAR_INVALID", inventory.birthYearInvalid],
      ["BIRTH_YEAR_NOT_BSON_INT", inventory.birthYearNotBsonInt],
      ["RESIDENCE_CITY_MISSING", inventory.residenceCityMissing],
      ["RESIDENCE_CITY_NOT_CANONICAL", inventory.residenceCityNotCanonical],
      ["RESIDENCE_REGION_ABSENT", inventory.residenceRegionAbsent],
      ["RESIDENCE_REGION_NOT_CANONICAL", inventory.residenceRegionNotCanonical],
      ["RESIDENCE_COUNTRY_MISSING", inventory.residenceCountryMissing],
      ["RESIDENCE_COUNTRY_NOT_CANONICAL", inventory.residenceCountryNotCanonical],
      ["EMPLOYMENT_STATUS_MISSING", inventory.employmentStatusMissing],
      ["EMPLOYMENT_STATUS_NOT_CANONICAL", inventory.employmentStatusNotCanonical],
      ["COMPANY_REQUIRED_MISSING", inventory.companyRequiredMissing],
      ["COMPANY_REQUIRED_NOT_CANONICAL", inventory.companyRequiredNotCanonical],
      ["COMPANY_SHOULD_BE_NULL", inventory.companyShouldBeNull],
      ["OPTIONAL_OCCUPATION_ABSENT", inventory.occupationAbsent],
      ["OCCUPATION_NOT_CANONICAL", inventory.occupationNotCanonical],
      ["LEGACY_HOME_ADDRESS_PRESENT", inventory.legacyHomeAddressPresent],
    ];
    return {
      summary:
        "Inventory existing registration profiles; missing user-confirmed values are not inferred.",
      counts: {
        examined: inventory.usersScanned,
        matched: inventory.usersScanned,
        modified: 0,
        skipped: 0,
        errors: 0,
      },
      estimatedBatches: Math.ceil(inventory.usersScanned / context.batchSize),
      warnings: warningPairs
        .filter((entry) => entry[1] > 0)
        .map((entry) => ({ code: entry[0], count: entry[1] })),
    };
  },

  up: async (context) => {
    const emptyInventory = (): Record<keyof InventoryCounts, number> => ({
      usersScanned: 0,
      profilesWithObservedIssues: 0,
      phoneMissing: 0,
      phoneNotCanonicalE164: 0,
      birthYearMissing: 0,
      birthYearInvalid: 0,
      birthYearNotBsonInt: 0,
      residenceCityMissing: 0,
      residenceCityNotCanonical: 0,
      residenceRegionAbsent: 0,
      residenceRegionNotCanonical: 0,
      residenceCountryMissing: 0,
      residenceCountryNotCanonical: 0,
      employmentStatusMissing: 0,
      employmentStatusNotCanonical: 0,
      companyRequiredMissing: 0,
      companyRequiredNotCanonical: 0,
      companyShouldBeNull: 0,
      occupationAbsent: 0,
      occupationNotCanonical: 0,
      legacyHomeAddressPresent: 0,
    });
    const users = context.database.collection<UserInventoryDocument>("users");
    const previousCheckpoint = context.checkpoint as InventoryCheckpoint | null;
    let highWatermark = previousCheckpoint?.highWatermark ?? null;
    const lastId = previousCheckpoint?.lastId ?? null;
    const observedUtcYear =
      previousCheckpoint?.observedUtcYear ?? new Date().getUTCFullYear();
    const inventory = {
      ...emptyInventory(),
      ...(previousCheckpoint?.inventory ?? {}),
    };

    if (context.checkpoint === null) {
      const newest = await users
        .aggregate<{ readonly cursorId?: unknown }>([
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, cursorId: { $toString: "$_id" } } },
        ])
        .toArray();
      highWatermark =
        typeof newest[0]?.cursorId === "string" ? newest[0].cursorId : null;
    }

    if (highWatermark === null) {
      return {
        done: true,
        checkpoint: {
          highWatermark: null,
          lastId: null,
          observedUtcYear,
          inventory,
        },
        counts: {
          examined: 0,
          matched: 0,
          modified: 0,
          skipped: 0,
          errors: 0,
        },
      };
    }

    const idRange: Record<string, string> = { $lte: highWatermark };
    if (lastId !== null) idRange.$gt = lastId;
    const candidates = await users
      .aggregate<UserInventoryDocument>([
        {
          $addFields: {
            __migrationCursorId: { $toString: "$_id" },
            __birthYearBsonType: { $type: "$birthYear" },
          },
        },
        { $match: { __migrationCursorId: idRange } },
        { $sort: { __migrationCursorId: 1 } },
        { $limit: context.batchSize + 1 },
        {
          $project: {
            phone: 1,
            birthYear: 1,
            residenceCity: 1,
            residenceRegion: 1,
            residenceCountryCode: 1,
            employmentStatus: 1,
            company: 1,
            occupation: 1,
            homeAddress: 1,
            __migrationCursorId: 1,
            __birthYearBsonType: 1,
          },
        },
      ])
      .toArray();
    const batch = candidates.slice(0, context.batchSize);
    const validEmploymentStatuses = new Set([
      "employed",
      "self_employed",
      "student",
      "not_currently_employed",
      "retired",
    ]);
    const isMissingText = (value: unknown): boolean =>
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");
    const isDisplayTextNotCanonical = (
      value: unknown,
      required: boolean,
    ): boolean => {
      if (isMissingText(value)) return false;
      if (typeof value !== "string") return true;
      if (/\p{Cc}/u.test(value)) return true;
      const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
      const length = Array.from(normalized).length;
      return (
        (required && length === 0) ||
        length > 100 ||
        normalized !== value
      );
    };
    for (const document of batch) {
      inventory.usersScanned += 1;
      let observedIssue = false;

      const phone =
        typeof document.phone === "string" ? document.phone.trim() : "";
      if (isMissingText(document.phone)) {
        inventory.phoneMissing += 1;
        observedIssue = true;
      } else if (
        typeof document.phone !== "string" ||
        !/^\+[1-9]\d{7,14}$/.test(phone) ||
        document.phone !== phone
      ) {
        inventory.phoneNotCanonicalE164 += 1;
        observedIssue = true;
      }

      let birthYear = Number.NaN;
      if (document.birthYear === undefined || document.birthYear === null || document.birthYear === "") {
        inventory.birthYearMissing += 1;
        observedIssue = true;
      } else if (
        typeof document.birthYear === "number" ||
        typeof document.birthYear === "string"
      ) {
        birthYear =
          typeof document.birthYear === "number"
            ? document.birthYear
            : /^\d{4}$/.test(document.birthYear.trim())
              ? Number(document.birthYear.trim())
              : Number.NaN;
        if (
          !Number.isInteger(birthYear) ||
          birthYear < 1900 ||
          birthYear > observedUtcYear
        ) {
          inventory.birthYearInvalid += 1;
          observedIssue = true;
        }
      } else {
        inventory.birthYearInvalid += 1;
        observedIssue = true;
      }
      if (
        document.birthYear !== undefined &&
        document.birthYear !== null &&
        document.birthYear !== "" &&
        document.__birthYearBsonType !== "int"
      ) {
        inventory.birthYearNotBsonInt += 1;
        observedIssue = true;
      }

      if (isMissingText(document.residenceCity)) {
        inventory.residenceCityMissing += 1;
        observedIssue = true;
      } else if (isDisplayTextNotCanonical(document.residenceCity, true)) {
        inventory.residenceCityNotCanonical += 1;
        observedIssue = true;
      }

      const country =
        typeof document.residenceCountryCode === "string"
          ? document.residenceCountryCode.trim().toUpperCase()
          : "";
      if (isMissingText(document.residenceCountryCode)) {
        inventory.residenceCountryMissing += 1;
        observedIssue = true;
      } else if (
        typeof document.residenceCountryCode !== "string" ||
        !/^[A-Z]{2}$/.test(country) ||
        document.residenceCountryCode !== country
      ) {
        inventory.residenceCountryNotCanonical += 1;
        observedIssue = true;
      }

      const regionMissing = isMissingText(document.residenceRegion);
      if (regionMissing) {
        inventory.residenceRegionAbsent += 1;
        if (country === "US") observedIssue = true;
      } else {
        const region =
          typeof document.residenceRegion === "string"
            ? document.residenceRegion.trim().toUpperCase()
            : "";
        if (
          typeof document.residenceRegion !== "string" ||
          !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region) ||
          (country !== "" && !region.startsWith(`${country}-`)) ||
          document.residenceRegion !== region
        ) {
          inventory.residenceRegionNotCanonical += 1;
          observedIssue = true;
        }
      }

      const employmentStatus =
        typeof document.employmentStatus === "string"
          ? document.employmentStatus.trim().toLowerCase()
          : "";
      if (isMissingText(document.employmentStatus)) {
        inventory.employmentStatusMissing += 1;
        observedIssue = true;
      } else if (
        !validEmploymentStatuses.has(employmentStatus) ||
        document.employmentStatus !== employmentStatus
      ) {
        inventory.employmentStatusNotCanonical += 1;
        observedIssue = true;
      }

      if (employmentStatus === "employed" || employmentStatus === "self_employed") {
        if (isMissingText(document.company)) {
          inventory.companyRequiredMissing += 1;
          observedIssue = true;
        } else if (isDisplayTextNotCanonical(document.company, true)) {
          inventory.companyRequiredNotCanonical += 1;
          observedIssue = true;
        }
      } else if (
        validEmploymentStatuses.has(employmentStatus) &&
        document.company !== null
      ) {
        inventory.companyShouldBeNull += 1;
        observedIssue = true;
      }

      if (isMissingText(document.occupation)) {
        inventory.occupationAbsent += 1;
      } else if (isDisplayTextNotCanonical(document.occupation, false)) {
        inventory.occupationNotCanonical += 1;
        observedIssue = true;
      }

      if (!isMissingText(document.homeAddress)) {
        inventory.legacyHomeAddressPresent += 1;
      }
      if (observedIssue) {
        inventory.profilesWithObservedIssues += 1;
      }
    }

    const nextLastId =
      batch.length === 0
        ? lastId
        : typeof batch[batch.length - 1]?.__migrationCursorId === "string"
          ? batch[batch.length - 1]?.__migrationCursorId as string
          : lastId;
    const checkpoint: InventoryCheckpoint = {
      highWatermark,
      lastId: nextLastId,
      observedUtcYear,
      inventory,
    };
    const resultCounts = {
      examined: batch.length,
      matched: batch.length,
      modified: 0,
      skipped: 0,
      errors: 0,
    };
    return candidates.length <= context.batchSize
      ? { done: true, checkpoint, counts: resultCounts }
      : { done: false, checkpoint, counts: resultCounts };
  },

  down: async () => ({
    done: true,
    checkpoint: { baselineLedgerRolledBack: true },
    counts: {
      examined: 0,
      matched: 0,
      modified: 0,
      skipped: 0,
      errors: 0,
    },
  }),

  verify: async (context) => {
    const zeroCounts = {
      examined: 0,
      matched: 0,
      modified: 0,
      skipped: 0,
      errors: 0,
    };
    if (context.direction === "down") {
      return {
        ok:
          context.checkpoint !== null &&
          "baselineLedgerRolledBack" in context.checkpoint &&
          context.checkpoint.baselineLedgerRolledBack === true,
        summary: "Registration-profile baseline ledger rollback verified.",
        counts: zeroCounts,
      };
    }

    if (
      context.checkpoint === null ||
      !("inventory" in context.checkpoint) ||
      !("highWatermark" in context.checkpoint) ||
      !("lastId" in context.checkpoint)
    ) {
      return {
        ok: false,
        summary: "Registration-profile baseline checkpoint is missing.",
        counts: { ...zeroCounts, examined: 1, matched: 1, errors: 1 },
      };
    }

    const checkpoint = context.checkpoint as InventoryCheckpoint;
    const inventoryValues = Object.values(checkpoint.inventory);
    const invariantOk =
      Number.isInteger(checkpoint.observedUtcYear) &&
      checkpoint.observedUtcYear >= 1900 &&
      inventoryValues.every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= checkpoint.inventory.usersScanned,
      ) &&
      checkpoint.inventory.profilesWithObservedIssues <=
        checkpoint.inventory.usersScanned;
    let unscanned = 0;
    if (checkpoint.highWatermark !== null) {
      const idRange: Record<string, string> = {
        $lte: checkpoint.highWatermark,
      };
      if (checkpoint.lastId !== null) idRange.$gt = checkpoint.lastId;
      const remaining = await context.database
        .collection<UserInventoryDocument>("users")
        .aggregate<{ readonly count?: unknown }>([
          {
            $addFields: {
              __migrationCursorId: { $toString: "$_id" },
            },
          },
          { $match: { __migrationCursorId: idRange } },
          { $limit: 1 },
          { $count: "count" },
        ])
        .toArray();
      unscanned = typeof remaining[0]?.count === "number" ? remaining[0].count : 0;
    }
    const ok = invariantOk && unscanned === 0;
    return {
      ok,
      summary:
        "Registration-profile baseline coverage and aggregate checkpoint verified.",
      counts: {
        examined: unscanned + (invariantOk ? 0 : 1),
        matched: unscanned + (invariantOk ? 0 : 1),
        modified: 0,
        skipped: 0,
        errors: ok ? 0 : 1,
      },
    };
  },
} satisfies MigrationSourceDefinition;
