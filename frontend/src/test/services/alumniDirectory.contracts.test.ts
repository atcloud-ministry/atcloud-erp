import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeDirectoryDetailResponse,
  decodeDirectoryPage,
} from "../../services/api/alumniDirectory.contracts";
import { alumniDirectoryService } from "../../services/api/alumniDirectory.api";

const profile = {
  id: "64b000000000000000000001",
  displayName: "Amy Chen",
  avatar: null,
  professionalHeadline: "Building useful products",
  company: "Microsoft",
  occupation: "Product Manager",
  generalLocation: "Seattle",
  affiliations: [
    {
      id: "64b000000000000000000002",
      programName: "EMBA",
      cohortLabel: "2022",
    },
  ],
  helpOfferings: {
    careerAdvice: true,
    warmIntroduction: true,
    formalEmployeeReferral: false,
  },
};

const page = {
  profiles: [profile],
  pagination: {
    currentPage: 1,
    totalPages: 2,
    totalProfiles: 25,
    hasNext: true,
    hasPrev: false,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Alumni Directory response contracts", () => {
  it("accepts the exact card, detail, affiliation, offering, and pagination DTOs", () => {
    expect(decodeDirectoryPage(page)).toEqual(page);

    const detail = {
      ...profile,
      industry: "Technology",
      skills: ["Product strategy", "Mentoring"],
      bio: "Happy to help fellow alumni.",
    };
    expect(decodeDirectoryDetailResponse({ profile: detail })).toEqual(detail);
  });

  it.each([
    ["contact PII", { ...profile, email: "private@example.com" }],
    ["phone PII", { ...profile, phone: "+12065550100" }],
    ["registration PII", { ...profile, birthYear: 1990 }],
    [
      "affiliation internals",
      {
        ...profile,
        affiliations: [
          {
            ...profile.affiliations[0],
            verificationStatus: "verified",
          },
        ],
      },
    ],
  ])("rejects %s added to a card DTO", (_label, unsafeProfile) => {
    expect(() =>
      decodeDirectoryPage({
        ...page,
        profiles: [unsafeProfile],
      }),
    ).toThrow(/exact keys/);
  });

  it("rejects inconsistent pagination metadata", () => {
    expect(() =>
      decodeDirectoryPage({
        ...page,
        pagination: { ...page.pagination, hasNext: false },
      }),
    ).toThrow(/consistent with pagination/);
  });

  it("rejects a page larger than the approved API maximum", () => {
    expect(() =>
      decodeDirectoryPage({
        profiles: Array.from({ length: 101 }, () => profile),
        pagination: {
          currentPage: 1,
          totalPages: 1,
          totalProfiles: 101,
          hasNext: false,
          hasPrev: false,
        },
      }),
    ).toThrow(/at most 100 profiles/);
  });
});

describe("Alumni Directory API client", () => {
  it("sends only the supported, trimmed query parameters and forwards cancellation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, message: "ok", data: page }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const controller = new AbortController();

    await alumniDirectoryService.list(
      {
        q: "  Amy Chen  ",
        company: " Microsoft ",
        industry: "Technology",
        skill: "Product strategy",
        location: "Seattle",
        cohort: "EMBA 2022",
        offering: "warm_introduction",
        page: 2,
        limit: 24,
      },
      controller.signal,
    );

    const [url, options] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      page: "2",
      limit: "24",
      q: "Amy Chen",
      company: "Microsoft",
      industry: "Technology",
      skill: "Product strategy",
      location: "Seattle",
      cohort: "EMBA 2022",
      offering: "warm_introduction",
    });
    expect(options?.signal).toBe(controller.signal);
  });

  it.each([
    [{ page: 0 }, /positive integer/],
    [{ limit: 101 }, /1 to 100/],
    [{ offering: "phone_number" }, /help offering/],
  ])("rejects an invalid query before making a request", async (params, error) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      alumniDirectoryService.list(params as never),
    ).rejects.toThrow(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
