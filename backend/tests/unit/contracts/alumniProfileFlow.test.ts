import { describe, expect, it } from "vitest";
import {
  AlumniProfileFlowValidationError,
  buildDirectoryDetailDTO,
  buildOwnAlumniProfileDTO,
  parseAlumniProfilePublishBody,
  parseAlumniProfileUpdateBody,
  parseAlumniProfileWithdrawBody,
} from "../../../src/contracts/alumniProfileFlow";
import {
  ALUMNI_PROFILE_PUBLICATION_CONSENT,
  ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY,
  findAlumniProfilePublicationConsent,
} from "../../../src/config/alumniProfilePublicationConsent";

const PROFILE_ID = "507f191e810c19729de860ea";
const AFFILIATION_ID = "507f191e810c19729de860eb";

function expectValidationError(operation: () => unknown): void {
  expect(operation).toThrow(AlumniProfileFlowValidationError);
}

function directorySource() {
  return {
    id: PROFILE_ID,
    displayName: "Amy Chen",
    avatar: null,
    professionalHeadline: "Product Manager",
    company: "Example Corp",
    occupation: "Product Manager",
    generalLocation: "Seattle",
    affiliations: [
      {
        id: AFFILIATION_ID,
        programName: "EMBA",
        cohortLabel: "2022",
      },
    ],
    helpOfferings: {
      careerAdvice: true,
      warmIntroduction: false,
      formalEmployeeReferral: true,
    },
    industry: "Technology",
    skills: ["Product Strategy"],
    bio: "Happy to help fellow alumni.",
  } as const;
}

describe("alumni profile mutation contracts", () => {
  it("keeps the immutable v1 consent while pointing publication to v2", () => {
    expect(
      ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY.map(
        (entry) => entry.version,
      ),
    ).toEqual(["directory-v1", "directory-v2"]);
    expect(ALUMNI_PROFILE_PUBLICATION_CONSENT.version).toBe("directory-v2");
    expect(findAlumniProfilePublicationConsent("directory-v1")).toBe(
      ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY[0],
    );
  });

  it("normalizes editable fields and keeps all offerings independent", () => {
    const parsed = parseAlumniProfileUpdateBody({
      expectedRevision: 3,
      professionalHeadline: "  Product   Leader  ",
      industry: null,
      skills: [" Product   Strategy ", "Café Operations"],
      bio: "  Happy   to help. ",
      helpOfferings: {
        careerAdvice: false,
        warmIntroduction: true,
        formalEmployeeReferral: false,
      },
    });

    expect(parsed).toEqual({
      expectedRevision: 3,
      professionalHeadline: "Product Leader",
      industry: null,
      skills: ["Product Strategy", "Café Operations"],
      bio: "Happy to help.",
      helpOfferings: {
        careerAdvice: false,
        warmIntroduction: true,
        formalEmployeeReferral: false,
      },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.skills)).toBe(true);
  });

  it("preserves About paragraph breaks while normalizing line endings", () => {
    const parsed = parseAlumniProfileUpdateBody({
      expectedRevision: 3,
      bio: " \tFirst   paragraph\r\n\r\n  Second\tparagraph  \r\n",
    });

    expect(parsed.bio).toBe("First paragraph\n\nSecond paragraph");
    expect(
      buildDirectoryDetailDTO({
        ...directorySource(),
        bio: parsed.bio,
      }).bio,
    ).toBe("First paragraph\n\nSecond paragraph");
  });

  it("rejects forbidden controls and overlong multiline About text", () => {
    for (const bio of ["First\u0000\n\nSecond", "First\u007f\n\nSecond"]) {
      expectValidationError(() =>
        parseAlumniProfileUpdateBody({ expectedRevision: 0, bio }),
      );
    }
    expect(
      parseAlumniProfileUpdateBody({
        expectedRevision: 0,
        bio: `${"a".repeat(1_997)}\n\nb`,
      }).bio,
    ).toHaveLength(2_000);
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({
        expectedRevision: 0,
        bio: `${"a".repeat(1_998)}\n\nb`,
      }),
    );
  });

  it("rejects unknown, accessor, non-plain, incomplete, and empty edits", () => {
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({ expectedRevision: 0, phone: "+12065550101" }),
    );
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({ expectedRevision: 0 }),
    );
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({
        expectedRevision: 0,
        helpOfferings: { careerAdvice: true, warmIntroduction: false },
      }),
    );
    expectValidationError(() =>
      parseAlumniProfileUpdateBody(
        Object.defineProperty({}, "expectedRevision", { get: () => 0 }),
      ),
    );
    expectValidationError(() =>
      parseAlumniProfileUpdateBody(new (class ProfileEdit {})()),
    );
  });

  it("bounds revisions, skills, and display text", () => {
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({ expectedRevision: -1, bio: "Hello" }),
    );
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({
        expectedRevision: 0,
        skills: Array.from({ length: 21 }, (_, index) => `Skill ${index}`),
      }),
    );
    expectValidationError(() =>
      parseAlumniProfileUpdateBody({
        expectedRevision: 0,
        professionalHeadline: "x".repeat(161),
      }),
    );
  });

  it("requires explicit current-version publication consent", () => {
    expect(
      parseAlumniProfilePublishBody({
        expectedRevision: 2,
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        consentAccepted: true,
      }),
    ).toEqual({
      expectedRevision: 2,
      consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      consentAccepted: true,
    });
    expectValidationError(() =>
      parseAlumniProfilePublishBody({
        expectedRevision: 2,
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        consentAccepted: false,
      }),
    );
    expectValidationError(() =>
      parseAlumniProfilePublishBody({
        expectedRevision: 2,
        consentVersion: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
        consentAccepted: true,
        documentHash: "a".repeat(64),
      }),
    );
    expect(parseAlumniProfileWithdrawBody({ expectedRevision: 4 })).toEqual({
      expectedRevision: 4,
    });
  });
});

describe("alumni profile response DTOs", () => {
  it("returns an exact Directory allowlist without private or internal fields", () => {
    const dto = buildDirectoryDetailDTO({
      ...directorySource(),
      phone: "+12065550101",
      birthYear: 1988,
      currentPublicationConsentId: AFFILIATION_ID,
      documentHash: "a".repeat(64),
      searchProjection: { searchText: "private" },
    } as Parameters<typeof buildDirectoryDetailDTO>[0]);

    expect(Object.keys(dto).sort()).toEqual(
      [
        "affiliations",
        "avatar",
        "bio",
        "company",
        "displayName",
        "generalLocation",
        "helpOfferings",
        "id",
        "industry",
        "occupation",
        "professionalHeadline",
        "skills",
      ].sort(),
    );
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("birthYear");
    expect(serialized).not.toContain("documentHash");
    expect(serialized).not.toContain("searchProjection");
  });

  it("returns the exact owner lifecycle and consent-display fields", () => {
    const dto = buildOwnAlumniProfileDTO({
      ...directorySource(),
      publishStatus: "draft",
      consentVersion: null,
      hasCurrentPublicationConsent: false,
      publishReadiness: {
        ready: false,
        issues: [
          {
            field: "phone",
            code: "required",
            message: "Phone is required.",
          },
        ],
      },
      revision: 2,
      publishedAt: null,
      withdrawnAt: null,
      updatedAt: new Date("2031-09-01T12:00:00.000Z"),
    });

    expect(dto.publicationConsent).toEqual({
      version: ALUMNI_PROFILE_PUBLICATION_CONSENT.version,
      text: ALUMNI_PROFILE_PUBLICATION_CONSENT.text,
    });
    expect(dto).toMatchObject({
      publishStatus: "draft",
      consentVersion: null,
      hasCurrentPublicationConsent: false,
      revision: 2,
      updatedAt: "2031-09-01T12:00:00.000Z",
    });
    expect(JSON.stringify(dto)).not.toContain(
      ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash,
    );
  });

  it("returns every verified affiliation when a profile has more than 50", () => {
    const affiliations = Array.from({ length: 51 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(24, "0"),
      programName: `Program ${index + 1}`,
      cohortLabel: `Cohort ${index + 1}`,
    }));

    const dto = buildDirectoryDetailDTO({
      ...directorySource(),
      affiliations,
    });

    expect(dto.affiliations).toHaveLength(51);
    expect(dto.affiliations[50]).toEqual(affiliations[50]);
  });
});
