import { describe, expect, it } from "vitest";
import {
  AlumniDirectoryQueryValidationError,
  DIRECTORY_DEFAULT_PAGE_SIZE,
  DIRECTORY_MAX_PAGE,
  DIRECTORY_MAX_PAGE_SIZE,
  buildAlumniDirectoryPageDTO,
  parseAlumniDirectoryQuery,
} from "../../../src/contracts/alumniDirectoryFlow";
import type { DirectoryCardDTO } from "../../../src/contracts/userReadContracts";

const CARD: DirectoryCardDTO = Object.freeze({
  id: "507f191e810c19729de860ea",
  displayName: "Amy Chen",
  avatar: null,
  professionalHeadline: "Product Leader",
  company: "Example Corp",
  occupation: "Product Manager",
  generalLocation: "Seattle",
  affiliations: Object.freeze([
    Object.freeze({
      id: "507f191e810c19729de860eb",
      programName: "EMBA",
      cohortLabel: "2022",
    }),
  ]),
  helpOfferings: Object.freeze({
    careerAdvice: true,
    warmIntroduction: true,
    formalEmployeeReferral: false,
  }),
});

function expectInvalid(operation: () => unknown): void {
  expect(operation).toThrow(AlumniDirectoryQueryValidationError);
}

describe("alumni Directory query contract", () => {
  it("uses the approved pagination defaults", () => {
    expect(parseAlumniDirectoryQuery(Object.create(null))).toEqual({
      page: 1,
      limit: DIRECTORY_DEFAULT_PAGE_SIZE,
    });
    expect(DIRECTORY_DEFAULT_PAGE_SIZE).toBe(24);
    expect(DIRECTORY_MAX_PAGE_SIZE).toBe(100);
  });

  it("normalizes all supported filters and offering values", () => {
    expect(
      parseAlumniDirectoryQuery({
        page: "2",
        limit: "100",
        q: "  Amy   Chen ",
        company: " Example   Corp ",
        industry: " Technology ",
        skill: " Product   Strategy ",
        location: " Seattle ",
        cohort: " EMBA   2022 ",
        offering: "warm_introduction",
      }),
    ).toEqual({
      page: 2,
      limit: 100,
      q: "Amy Chen",
      company: "Example Corp",
      industry: "Technology",
      skill: "Product Strategy",
      location: "Seattle",
      cohort: "EMBA 2022",
      offering: "warm_introduction",
    });
  });

  it("accepts escaped-search characters as literal bounded input", () => {
    expect(parseAlumniDirectoryQuery({ q: ".*[]()+?\\" })).toMatchObject({
      q: ".*[]()+?\\",
    });
  });

  it("rejects arrays, unknown keys, unsafe objects, accessors, and invalid ranges", () => {
    expectInvalid(() => parseAlumniDirectoryQuery([]));
    expectInvalid(() => parseAlumniDirectoryQuery({ email: "amy@example.org" }));
    expectInvalid(() =>
      parseAlumniDirectoryQuery(new (class DirectoryQuery {})()),
    );
    expectInvalid(() =>
      parseAlumniDirectoryQuery(
        Object.defineProperty({}, "q", { get: () => "Amy" }),
      ),
    );
    expectInvalid(() => parseAlumniDirectoryQuery({ page: "0" }));
    expectInvalid(() =>
      parseAlumniDirectoryQuery({ page: String(DIRECTORY_MAX_PAGE + 1) }),
    );
    expectInvalid(() => parseAlumniDirectoryQuery({ limit: "101" }));
    expectInvalid(() => parseAlumniDirectoryQuery({ offering: "referral" }));
  });
});

describe("alumni Directory page DTO", () => {
  it("builds consistent paging metadata without adding profile fields", () => {
    const page = buildAlumniDirectoryPageDTO({
      profiles: [CARD],
      page: 2,
      limit: 24,
      totalProfiles: 49,
    });

    expect(page.pagination).toEqual({
      currentPage: 2,
      totalPages: 3,
      totalProfiles: 49,
      hasNext: true,
      hasPrev: true,
    });
    expect(page.profiles).toEqual([CARD]);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.pagination)).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/email|phone|birthYear/u);
  });

  it("represents an empty first page and rejects inconsistent service output", () => {
    expect(
      buildAlumniDirectoryPageDTO({
        profiles: [],
        page: 1,
        limit: 24,
        totalProfiles: 0,
      }).pagination,
    ).toEqual({
      currentPage: 1,
      totalPages: 0,
      totalProfiles: 0,
      hasNext: false,
      hasPrev: false,
    });
    expectInvalid(() =>
      buildAlumniDirectoryPageDTO({
        profiles: [CARD, CARD],
        page: 1,
        limit: 1,
        totalProfiles: 1,
      }),
    );
  });
});
