import mongoose, { type PipelineStage } from "mongoose";
import { normalizeSearchText } from "@atcloud/shared-time/registration-profile";
import { ALUMNI_PROFILE_PUBLICATION_CONSENT } from "../../config/alumniProfilePublicationConsent";
import {
  buildAlumniDirectoryPageDTO,
  type AlumniDirectoryPageDTO,
  type AlumniDirectoryQuery,
} from "../../contracts/alumniDirectoryFlow";
import { buildDirectoryDetailDTO } from "../../contracts/alumniProfileFlow";
import type {
  DirectoryCardDTO,
  DirectoryDetailDTO,
} from "../../contracts/userReadContracts";
import { ALUMNI_AFFILIATION_COLLECTION } from "../../models/AlumniAffiliation";
import AlumniProfile from "../../models/AlumniProfile";
import { CONSENT_RECORD_COLLECTION } from "../../models/ConsentRecord";
import User from "../../models/User";
import { escapeRegex } from "../../utils/search";
import { AlumniFlowError } from "./AlumniFlowErrors";
import {
  alumniDisplayName,
  alumniGeneralLocation,
} from "./AlumniProfileProjectionService";

interface DirectoryAggregateRow {
  readonly _id: mongoose.Types.ObjectId;
  readonly professionalHeadline?: string | null;
  readonly industry?: string | null;
  readonly skills?: readonly string[];
  readonly bio?: string | null;
  readonly helpOfferings?: {
    readonly careerAdvice?: boolean;
    readonly warmIntroduction?: boolean;
    readonly formalEmployeeReferral?: boolean;
  };
  readonly user?: {
    readonly username?: string | null;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    readonly avatar?: string | null;
    readonly company?: string | null;
    readonly occupation?: string | null;
    readonly residenceCity?: string | null;
    readonly residenceRegion?: string | null;
    readonly residenceCountryCode?: string | null;
  };
  readonly affiliations?: readonly {
    readonly _id: mongoose.Types.ObjectId;
    readonly programName?: string | null;
    readonly cohortLabel?: string | null;
  }[];
}

interface DirectoryFacetResult {
  readonly rows?: readonly DirectoryAggregateRow[];
  readonly totals?: readonly { readonly count?: number }[];
}

const PUBLIC_PROFILE_FIELDS: PipelineStage.Project["$project"] = {
  professionalHeadline: 1,
  industry: 1,
  skills: 1,
  bio: 1,
  helpOfferings: 1,
  "user.username": 1,
  "user.firstName": 1,
  "user.lastName": 1,
  "user.avatar": 1,
  "user.company": 1,
  "user.occupation": 1,
  "user.residenceCity": 1,
  "user.residenceRegion": 1,
  "user.residenceCountryCode": 1,
  "affiliations._id": 1,
  "affiliations.programName": 1,
  "affiliations.cohortLabel": 1,
};

function profileNotFound(): AlumniFlowError {
  return new AlumniFlowError(
    "ALUMNI_PROFILE_NOT_FOUND",
    404,
    "The alumni profile was not found.",
  );
}

function objectId(value: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) throw profileNotFound();
  return new mongoose.Types.ObjectId(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function detailFrom(row: DirectoryAggregateRow): DirectoryDetailDTO {
  const user = row.user ?? {};
  const affiliations = (row.affiliations ?? []).map((affiliation) => ({
    id: String(affiliation._id),
    programName: text(affiliation.programName) ?? "Alumni Program",
    cohortLabel: text(affiliation.cohortLabel),
  }));
  return buildDirectoryDetailDTO({
    id: String(row._id),
    displayName: alumniDisplayName(user),
    avatar: text(user.avatar),
    professionalHeadline: text(row.professionalHeadline),
    company: text(user.company),
    occupation: text(user.occupation),
    generalLocation: alumniGeneralLocation(user),
    affiliations,
    helpOfferings: {
      careerAdvice: row.helpOfferings?.careerAdvice === true,
      warmIntroduction: row.helpOfferings?.warmIntroduction === true,
      formalEmployeeReferral:
        row.helpOfferings?.formalEmployeeReferral === true,
    },
    industry: text(row.industry),
    skills: Array.isArray(row.skills)
      ? row.skills.filter((value): value is string => typeof value === "string")
      : [],
    bio: text(row.bio),
  });
}

function cardFrom(row: DirectoryAggregateRow): DirectoryCardDTO {
  const detail = detailFrom(row);
  return Object.freeze({
    id: detail.id,
    displayName: detail.displayName,
    avatar: detail.avatar,
    professionalHeadline: detail.professionalHeadline,
    company: detail.company,
    occupation: detail.occupation,
    generalLocation: detail.generalLocation,
    affiliations: detail.affiliations,
    helpOfferings: detail.helpOfferings,
  });
}

function baseEligibilityPipeline(): PipelineStage[] {
  return [
    {
      $match: {
        publishStatus: "published",
        accountDeletionApprovedAt: null,
        currentPublicationConsentId: { $type: "objectId" },
      },
    },
    {
      $lookup: {
        from: User.collection.name,
        localField: "userId",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    { $match: { "user.isActive": true, "user.isVerified": true } },
    {
      $lookup: {
        from: CONSENT_RECORD_COLLECTION,
        let: {
          consentId: "$currentPublicationConsentId",
          profileId: "$_id",
          subjectUserId: "$userId",
        },
        pipeline: [
          {
            $match: {
              purpose: "alumni_profile_publication",
              status: "active",
              consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
              documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$consentId"] },
                  { $eq: ["$alumniProfileId", "$$profileId"] },
                  { $eq: ["$subjectUserId", "$$subjectUserId"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "publicationConsent",
      },
    },
    { $match: { "publicationConsent.0": { $exists: true } } },
    {
      $lookup: {
        from: ALUMNI_AFFILIATION_COLLECTION,
        let: { profileId: "$_id" },
        pipeline: [
          {
            $match: {
              verificationStatus: "verified",
              accountDeletionApprovedAt: null,
              $expr: { $eq: ["$alumniProfileId", "$$profileId"] },
            },
          },
          { $sort: { programName: 1, cohortLabel: 1, _id: 1 } },
          { $project: { _id: 1, programName: 1, cohortLabel: 1 } },
        ],
        as: "affiliations",
      },
    },
    { $match: { "affiliations.0": { $exists: true } } },
  ];
}

function containsRegex(value: string): RegExp {
  return new RegExp(escapeRegex(value), "i");
}

function exactRegex(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

function trimmedField(path: string): Record<string, unknown> {
  return { $trim: { input: { $ifNull: [path, ""] } } };
}

function publicDisplayNameExpression(): Record<string, unknown> {
  return {
    $let: {
      vars: {
        fullName: {
          $trim: {
            input: {
              $concat: [
                { $ifNull: ["$user.firstName", ""] },
                " ",
                { $ifNull: ["$user.lastName", ""] },
              ],
            },
          },
        },
      },
      in: {
        $cond: [
          { $ne: ["$$fullName", ""] },
          "$$fullName",
          { $ifNull: ["$user.username", "Member"] },
        ],
      },
    },
  };
}

function publicGeneralLocationExpression(): Record<string, unknown> {
  const city = trimmedField("$user.residenceCity");
  const region = trimmedField("$user.residenceRegion");
  const country = trimmedField("$user.residenceCountryCode");
  return {
    $cond: [
      { $ne: [city, ""] },
      city,
      { $cond: [{ $ne: [region, ""] }, region, country] },
    ],
  };
}

function expressionRegexMatch(
  input: Record<string, unknown>,
  value: string,
  exact = false,
): Record<string, unknown> {
  const escaped = escapeRegex(value);
  return {
    $expr: {
      $regexMatch: {
        input,
        regex: exact ? `^${escaped}$` : escaped,
        options: "i",
      },
    },
  };
}

function normalizedProjectionMatch(
  field: string,
  value: string,
  mode: "exact" | "contains" = "exact",
): Record<string, unknown> {
  const normalized = normalizeSearchText(value);
  if (!normalized) return { _id: { $exists: false } };
  return {
    [field]: mode === "contains" ? containsRegex(normalized) : normalized,
  };
}

function hasSearchSymbols(value: string): boolean {
  return /[\p{P}\p{S}]/u.test(value);
}

function rawCohortMatch(value: string): Record<string, unknown> {
  const regex = `^${escapeRegex(value)}$`;
  return {
    $expr: {
      $gt: [
        {
          $size: {
            $filter: {
              input: "$affiliations",
              as: "affiliation",
              cond: {
                $or: [
                  {
                    $regexMatch: {
                      input: { $ifNull: ["$$affiliation.programName", ""] },
                      regex,
                      options: "i",
                    },
                  },
                  {
                    $regexMatch: {
                      input: { $ifNull: ["$$affiliation.cohortLabel", ""] },
                      regex,
                      options: "i",
                    },
                  },
                  {
                    $regexMatch: {
                      input: {
                        $trim: {
                          input: {
                            $concat: [
                              { $ifNull: ["$$affiliation.programName", ""] },
                              " ",
                              { $ifNull: ["$$affiliation.cohortLabel", ""] },
                            ],
                          },
                        },
                      },
                      regex,
                      options: "i",
                    },
                  },
                ],
              },
            },
          },
        },
        0,
      ],
    },
  };
}

function normalizedFreeTextMatches(
  value: string,
): Record<string, unknown>[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];

  // A symbol-bearing value such as C++ normalizes to a single letter. Using
  // that lossy key as a contains-search would return unrelated profiles, so
  // those inputs rely on the escaped raw-field fallback below.
  const symbolBearing = /[\p{P}\p{S}]/u.test(value);
  const compactLength = Array.from(normalized.replace(/\s+/gu, "")).length;
  if (symbolBearing && compactLength < 2) return [];

  const match = containsRegex(normalized);
  return [
    { "searchProjection.displayNameKey": match },
    { "searchProjection.companyKey": match },
    { "searchProjection.industryKey": match },
    { "searchProjection.skillKeys": match },
    { "searchProjection.generalLocationKey": match },
    { "searchProjection.cohortKeys": match },
  ];
}

function filterMatch(query: AlumniDirectoryQuery): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  if (query.q) {
    const raw = containsRegex(query.q);
    const searchableFields: Record<string, unknown>[] = [
      expressionRegexMatch(publicDisplayNameExpression(), query.q),
      expressionRegexMatch(publicGeneralLocationExpression(), query.q),
      { "user.company": raw },
      { industry: raw },
      { skills: raw },
      { "affiliations.programName": raw },
      { "affiliations.cohortLabel": raw },
      ...normalizedFreeTextMatches(query.q),
    ];
    clauses.push({
      $or: searchableFields,
    });
  }
  if (query.company) {
    clauses.push(
      hasSearchSymbols(query.company)
        ? { "user.company": exactRegex(query.company) }
        : normalizedProjectionMatch(
            "searchProjection.companyKey",
            query.company,
          ),
    );
  }
  if (query.industry) {
    clauses.push(
      hasSearchSymbols(query.industry)
        ? { industry: exactRegex(query.industry) }
        : normalizedProjectionMatch(
            "searchProjection.industryKey",
            query.industry,
          ),
    );
  }
  if (query.skill) {
    clauses.push(
      hasSearchSymbols(query.skill)
        ? { skills: exactRegex(query.skill) }
        : normalizedProjectionMatch("searchProjection.skillKeys", query.skill),
    );
  }
  if (query.location) {
    clauses.push(
      hasSearchSymbols(query.location)
        ? expressionRegexMatch(
            publicGeneralLocationExpression(),
            query.location,
            true,
          )
        : normalizedProjectionMatch(
            "searchProjection.generalLocationKey",
            query.location,
            "contains",
          ),
    );
  }
  if (query.cohort) {
    clauses.push(
      hasSearchSymbols(query.cohort)
        ? rawCohortMatch(query.cohort)
        : normalizedProjectionMatch(
            "searchProjection.cohortKeys",
            query.cohort,
            "contains",
          ),
    );
  }
  if (query.offering) {
    const field = {
      career_advice: "careerAdvice",
      warm_introduction: "warmIntroduction",
      formal_employee_referral: "formalEmployeeReferral",
    }[query.offering];
    clauses.push({ [`helpOfferings.${field}`]: true });
  }
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

export class AlumniDirectoryService {
  async list(query: AlumniDirectoryQuery): Promise<AlumniDirectoryPageDTO> {
    const skip = (query.page - 1) * query.limit;
    const pipeline: PipelineStage[] = [
      ...baseEligibilityPipeline(),
      { $match: filterMatch(query) },
      {
        $sort: {
          "searchProjection.displayNameKey": 1,
          _id: 1,
        },
      },
      {
        $facet: {
          rows: [
            { $skip: skip },
            { $limit: query.limit },
            { $project: PUBLIC_PROFILE_FIELDS },
          ],
          totals: [{ $count: "count" }],
        },
      },
    ];
    const [result] = await AlumniProfile.aggregate<DirectoryFacetResult>(
      pipeline,
    );
    const rows = result?.rows ?? [];
    const totalProfiles = result?.totals?.[0]?.count ?? 0;
    return buildAlumniDirectoryPageDTO({
      profiles: rows.map(cardFrom),
      page: query.page,
      limit: query.limit,
      totalProfiles,
    });
  }

  async get(profileId: string): Promise<DirectoryDetailDTO> {
    const [row] = await AlumniProfile.aggregate<DirectoryAggregateRow>([
      { $match: { _id: objectId(profileId) } },
      ...baseEligibilityPipeline(),
      { $project: PUBLIC_PROFILE_FIELDS },
      { $limit: 1 },
    ]);
    if (!row) throw profileNotFound();
    return detailFrom(row);
  }
}

export const alumniDirectoryService = new AlumniDirectoryService();
