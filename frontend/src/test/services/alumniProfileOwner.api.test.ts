import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alumniDirectoryService,
  type OwnAlumniProfileDTO,
} from "../../services/api/alumniDirectory.api";
import { decodeOwnAlumniProfileResponse } from "../../services/api/alumniDirectory.contracts";
import {
  alumniInvitationsService,
  decodeAlumniInvitationClaim,
} from "../../services/api/alumniInvitations.api";

const IDS = {
  profile: "64b000000000000000000001",
  affiliation: "64b000000000000000000002",
  invitation: "64b000000000000000000003",
};

const ownProfile: OwnAlumniProfileDTO = {
  id: IDS.profile,
  displayName: "Amy Chen",
  avatar: null,
  professionalHeadline: "Building useful products",
  company: "Microsoft",
  occupation: "Product Manager",
  generalLocation: "Seattle",
  affiliations: [
    {
      id: IDS.affiliation,
      programName: "EMBA",
      cohortLabel: "2022",
    },
  ],
  helpOfferings: {
    careerAdvice: true,
    warmIntroduction: true,
    formalEmployeeReferral: false,
  },
  industry: "Technology",
  skills: ["Product strategy", "Mentoring"],
  bio: "Happy to help fellow alumni.",
  publishStatus: "draft",
  consentVersion: null,
  hasCurrentPublicationConsent: false,
  publicationConsent: {
    version: "alumni-profile-publication-v1",
    text: "I consent to publish this profile to active, verified members.",
  },
  acceptedPublicationConsent: null,
  publishReadiness: { ready: true, issues: [] },
  revision: 3,
  publishedAt: null,
  withdrawnAt: null,
  updatedAt: "2026-09-12T12:00:00.000Z",
};

const claim = {
  invitationId: IDS.invitation,
  alumniProfileId: IDS.profile,
  affiliationIds: [IDS.affiliation],
  claimedAt: "2026-09-12T12:00:00.000Z",
  status: "claimed" as const,
  replayed: false,
};

const directoryDetail = {
  id: ownProfile.id,
  displayName: ownProfile.displayName,
  avatar: ownProfile.avatar,
  professionalHeadline: ownProfile.professionalHeadline,
  company: ownProfile.company,
  occupation: ownProfile.occupation,
  generalLocation: ownProfile.generalLocation,
  affiliations: ownProfile.affiliations,
  helpOfferings: ownProfile.helpOfferings,
  industry: ownProfile.industry,
  skills: ownProfile.skills,
  bio: ownProfile.bio,
};

function apiResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({ success: true, message: "ok", data }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("own alumni profile response contract", () => {
  it("accepts the exact owner DTO", () => {
    expect(decodeOwnAlumniProfileResponse({ profile: ownProfile })).toEqual(
      ownProfile,
    );
  });

  it("validates and preserves exact historical publication-consent evidence", () => {
    const acceptedPublicationConsent = {
      version: "directory-v1",
      text: "Earlier publication consent.",
      documentHash: "a".repeat(64),
      effectiveAt: "2026-09-01T00:00:00.000Z",
      acceptedAt: "2026-09-12T12:00:00.000Z",
    };
    expect(
      decodeOwnAlumniProfileResponse({
        profile: { ...ownProfile, acceptedPublicationConsent },
      }).acceptedPublicationConsent,
    ).toEqual(acceptedPublicationConsent);
    expect(() =>
      decodeOwnAlumniProfileResponse({
        profile: {
          ...ownProfile,
          acceptedPublicationConsent: {
            ...acceptedPublicationConsent,
            documentHash: "not-a-hash",
          },
        },
      }),
    ).toThrow(/SHA-256/);
  });

  it.each([
    ["email", "amy@example.com"],
    ["phone", "+12065550100"],
    ["birthYear", 1990],
  ])("rejects registration-only %s from the owner DTO", (field, value) => {
    expect(() =>
      decodeOwnAlumniProfileResponse({
        profile: { ...ownProfile, [field]: value },
      }),
    ).toThrow(/exact keys/);
  });
});

describe("owner alumni profile API client", () => {
  it("uses the canonical owner and preview endpoints and forwards cancellation", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        apiResponse({
          profile: String(url).endsWith("/preview")
            ? directoryDetail
            : ownProfile,
        }),
      );
    const controller = new AbortController();

    await expect(
      alumniDirectoryService.getOwn(controller.signal),
    ).resolves.toEqual(ownProfile);
    await expect(
      alumniDirectoryService.previewOwn(controller.signal),
    ).resolves.toMatchObject({ id: IDS.profile });

    expect(
      fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/directory/me", "/api/directory/me/preview"]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.signal).toBe(controller.signal);
      expect(options?.credentials).toBe("include");
    }
  });

  it.each([
    [
      "update",
      () =>
        alumniDirectoryService.updateOwn(
          {
            expectedRevision: 3,
            professionalHeadline: "Product leader",
            helpOfferings: {
              careerAdvice: true,
              warmIntroduction: false,
              formalEmployeeReferral: true,
            },
          },
          "update-key",
        ),
      "/api/directory/me",
      "PATCH",
      {
        expectedRevision: 3,
        professionalHeadline: "Product leader",
        helpOfferings: {
          careerAdvice: true,
          warmIntroduction: false,
          formalEmployeeReferral: true,
        },
      },
      "update-key",
    ],
    [
      "publish",
      () =>
        alumniDirectoryService.publishOwn(
          {
            expectedRevision: 3,
            consentVersion: "alumni-profile-publication-v1",
            consentAccepted: true,
          },
          "publish-key",
        ),
      "/api/directory/me/publish",
      "POST",
      {
        expectedRevision: 3,
        consentVersion: "alumni-profile-publication-v1",
        consentAccepted: true,
      },
      "publish-key",
    ],
    [
      "withdraw",
      () => alumniDirectoryService.withdrawOwn(3, "withdraw-key"),
      "/api/directory/me/withdraw",
      "POST",
      { expectedRevision: 3 },
      "withdraw-key",
    ],
  ] as const)(
    "sends the %s mutation with its revision, body, and idempotency key",
    async (_label, invoke, pathname, method, body, idempotencyKey) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(apiResponse({ profile: ownProfile }));

      await expect(invoke()).resolves.toEqual(ownProfile);

      const [url, options] = fetchMock.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe(pathname);
      expect(options).toMatchObject({
        method,
        credentials: "include",
        body: JSON.stringify(body),
      });
      expect(options?.headers).toMatchObject({
        "Idempotency-Key": idempotencyKey,
      });
    },
  );
});

describe("alumni invitation claim contract and client", () => {
  it("accepts the exact claim DTO", () => {
    expect(decodeAlumniInvitationClaim(claim)).toEqual(claim);
  });

  it.each([
    ["invitationId", { ...claim, invitationId: "not-an-object-id" }],
    ["alumniProfileId", { ...claim, alumniProfileId: "123" }],
    [
      "affiliationIds",
      { ...claim, affiliationIds: ["invalid-affiliation-id"] },
    ],
  ])("rejects a malformed %s", (_field, value) => {
    expect(() => decodeAlumniInvitationClaim(value)).toThrow(/ObjectId/);
  });

  it("rejects more than 50 affiliation ids", () => {
    expect(() =>
      decodeAlumniInvitationClaim({
        ...claim,
        affiliationIds: Array.from({ length: 51 }, () => IDS.affiliation),
      }),
    ).toThrow(/too many affiliations/);
  });

  it("rejects unexpected contact data", () => {
    expect(() =>
      decodeAlumniInvitationClaim({ ...claim, email: "amy@example.com" }),
    ).toThrow(/unexpected field/);
  });

  it("posts only the token with the caller's idempotency key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(apiResponse(claim));

    const controller = new AbortController();
    await expect(
      alumniInvitationsService.claim(
        "opaque-secret-token",
        "claim-key",
        controller.signal,
      ),
    ).resolves.toEqual(claim);

    const [url, options] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(
      "/api/alumni-invitations/claim",
    );
    expect(options).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ token: "opaque-secret-token" }),
    });
    expect(options?.headers).toMatchObject({
      "Idempotency-Key": "claim-key",
    });
    expect(options?.signal).toBe(controller.signal);
  });
});
