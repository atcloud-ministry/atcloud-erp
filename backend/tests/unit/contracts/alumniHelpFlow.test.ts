import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  ALUMNI_HELP_CONSENT_REGISTRY,
  ALUMNI_HELP_DISCLAIMER_REGISTRY,
  ALUMNI_HELP_TERMS,
  findAlumniHelpConsent,
  findAlumniHelpDisclaimer,
} from "../../../src/config/alumniHelpTerms";
import {
  ALUMNI_HELP_TRANSITIONS,
  AlumniHelpFlowValidationError,
  acceptedHelpRequestPurgeAt,
  buildAlumniHelpTermsDTO,
  helpOutcomeDueAt,
  isAlumniHelpOutcomeCodeForType,
  neverAcceptedHelpRequestPurgeAt,
  parseCreateHelpRequestBody,
  parseHelpRequestListQuery,
  parseHelpTransitionBody,
  parseOutcomeDecisionBody,
  parseReadHelpRequestBody,
  parseSubmitHelpOutcomeBody,
} from "../../../src/contracts/alumniHelpFlow";

const PROFILE_ID = "507f191e810c19729de860ea";

function expectValidationError(operation: () => unknown): void {
  expect(operation).toThrow(AlumniHelpFlowValidationError);
}

describe("alumni help legal terms", () => {
  it("owns versioned document evidence on the server", () => {
    expect(ALUMNI_HELP_CONSENT_REGISTRY.map((entry) => entry.version)).toEqual([
      "alumni-help-consent-v1",
      "alumni-help-consent-v2",
    ]);
    expect(
      ALUMNI_HELP_DISCLAIMER_REGISTRY.map((entry) => entry.version),
    ).toEqual([
      "alumni-help-disclaimer-v1",
      "alumni-help-disclaimer-v2",
    ]);
    expect(findAlumniHelpConsent("alumni-help-consent-v1")).toBe(
      ALUMNI_HELP_CONSENT_REGISTRY[0],
    );
    expect(findAlumniHelpDisclaimer("alumni-help-disclaimer-v1")).toBe(
      ALUMNI_HELP_DISCLAIMER_REGISTRY[0],
    );
    expect(ALUMNI_HELP_TERMS.consent.documentHash).toBe(
      createHash("sha256")
        .update(ALUMNI_HELP_TERMS.consent.text.normalize("NFC"), "utf8")
        .digest("hex"),
    );
    expect(ALUMNI_HELP_TERMS.disclaimer.documentHash).toBe(
      createHash("sha256")
        .update(ALUMNI_HELP_TERMS.disclaimer.text.normalize("NFC"), "utf8")
        .digest("hex"),
    );
    expect(buildAlumniHelpTermsDTO()).toEqual({
      consent: {
        version: ALUMNI_HELP_TERMS.consent.version,
        text: ALUMNI_HELP_TERMS.consent.text,
        effectiveAt: ALUMNI_HELP_TERMS.consent.effectiveAt,
      },
      disclaimer: {
        version: ALUMNI_HELP_TERMS.disclaimer.version,
        text: ALUMNI_HELP_TERMS.disclaimer.text,
        effectiveAt: ALUMNI_HELP_TERMS.disclaimer.effectiveAt,
      },
    });
    expect(JSON.stringify(buildAlumniHelpTermsDTO())).not.toContain(
      "documentHash",
    );
  });
});

describe("alumni help request input contracts", () => {
  it("normalizes the optional note and preserves independent terms versions", () => {
    expect(
      parseCreateHelpRequestBody({
        alumniProfileId: PROFILE_ID.toUpperCase(),
        requestedHelpType: "warm_introduction",
        openingNote: "  Could   we connect?  ",
        consentVersion: ALUMNI_HELP_TERMS.consent.version,
        consentAccepted: true,
        disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
        disclaimerAccepted: true,
      }),
    ).toEqual({
      alumniProfileId: PROFILE_ID,
      requestedHelpType: "warm_introduction",
      openingNote: "Could we connect?",
      consentVersion: ALUMNI_HELP_TERMS.consent.version,
      consentAccepted: true,
      disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
      disclaimerAccepted: true,
    });
  });

  it("rejects malformed ids, unknown fields, accessors, and unsafe notes", () => {
    expectValidationError(() =>
      parseCreateHelpRequestBody({
        alumniProfileId: "not-an-id",
        requestedHelpType: "career_advice",
        consentVersion: "v1",
        disclaimerVersion: "v1",
      }),
    );
    expectValidationError(() =>
      parseCreateHelpRequestBody({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        consentVersion: "v1",
        disclaimerVersion: "v1",
        requesterId: PROFILE_ID,
      }),
    );
    expectValidationError(() =>
      parseCreateHelpRequestBody(
        Object.defineProperty({}, "alumniProfileId", { get: () => PROFILE_ID }),
      ),
    );
    expectValidationError(() =>
      parseCreateHelpRequestBody({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        openingNote: "hello\u0000world",
        consentVersion: "v1",
        disclaimerVersion: "v1",
      }),
    );
    expectValidationError(() =>
      parseCreateHelpRequestBody({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        openingNote: "🙂".repeat(4_001),
        consentVersion: "v1",
        disclaimerVersion: "v1",
      }),
    );
  });

  it("requires literal consent and disclaimer acknowledgements", () => {
    expectValidationError(() =>
      parseCreateHelpRequestBody({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        consentVersion: ALUMNI_HELP_TERMS.consent.version,
        consentAccepted: false,
        disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
        disclaimerAccepted: true,
      }),
    );
    expectValidationError(() =>
      parseCreateHelpRequestBody({
        alumniProfileId: PROFILE_ID,
        requestedHelpType: "career_advice",
        consentVersion: ALUMNI_HELP_TERMS.consent.version,
        consentAccepted: true,
        disclaimerVersion: ALUMNI_HELP_TERMS.disclaimer.version,
      }),
    );
  });

  it("parses each transition's exact body shape", () => {
    expect(
      parseHelpTransitionBody("request_information", {
        expectedRevision: 1,
        note: " Please share more context. ",
      }),
    ).toEqual({ expectedRevision: 1, note: "Please share more context." });
    expect(
      parseHelpTransitionBody("propose_alternative", {
        expectedRevision: 2,
        proposedHelpType: "career_advice",
      }),
    ).toEqual({ expectedRevision: 2, proposedHelpType: "career_advice" });
    expect(parseHelpTransitionBody("accept", { expectedRevision: 3 })).toEqual({
      expectedRevision: 3,
    });
    expectValidationError(() =>
      parseHelpTransitionBody("accept", {
        expectedRevision: 3,
        note: "not allowed",
      }),
    );
    expectValidationError(() =>
      parseHelpTransitionBody("provide_information", { expectedRevision: 3 }),
    );
  });

  it("parses outcome submission and decision bodies strictly", () => {
    expect(
      parseSubmitHelpOutcomeBody({
        expectedRevision: 7,
        outcomeCode: "hired_after_interview",
      }),
    ).toEqual({ expectedRevision: 7, outcomeCode: "hired_after_interview" });
    expect(parseOutcomeDecisionBody({ expectedRevision: 0 })).toEqual({
      expectedRevision: 0,
    });
    expectValidationError(() =>
      parseSubmitHelpOutcomeBody({ expectedRevision: 7, outcomeCode: "hired" }),
    );
    expectValidationError(() =>
      parseOutcomeDecisionBody({ expectedRevision: -1 }),
    );
  });

  it("parses bounded list views and pagination", () => {
    expect(parseHelpRequestListQuery({})).toEqual({
      view: "updates",
      page: 1,
      limit: 20,
    });
    expect(
      parseHelpRequestListQuery({ view: "received", page: "2", limit: "100" }),
    ).toEqual({ view: "received", page: 2, limit: 100 });
    expectValidationError(() => parseHelpRequestListQuery({ limit: "101" }));
    expectValidationError(() =>
      parseHelpRequestListQuery({
        page: String(Number.MAX_SAFE_INTEGER),
        limit: "100",
      }),
    );
    expectValidationError(() =>
      parseHelpRequestListQuery({ view: "action_needed" }),
    );
  });
});

describe("Alumni Help read receipts", () => {
  it("accepts only a bounded observed revision and rejects write fields", () => {
    expect(parseReadHelpRequestBody({ observedRevision: 0 })).toEqual({ observedRevision: 0 });
    for (const value of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER]) {
      expectValidationError(() => parseReadHelpRequestBody({ observedRevision: value }));
    }
    expectValidationError(() => parseReadHelpRequestBody({}));
    expectValidationError(() => parseReadHelpRequestBody({ observedRevision: 1, requesterReadSequence: 99 }));
  });
});

describe("alumni help lifecycle and retention contracts", () => {
  it("publishes the approved transition matrix", () => {
    expect(ALUMNI_HELP_TRANSITIONS.request_information).toEqual({
      actor: "provider",
      from: ["requested"],
      to: "needs_information",
    });
    expect(ALUMNI_HELP_TRANSITIONS.withdraw.from).toEqual([
      "requested",
      "needs_information",
      "alternative_proposed",
    ]);
    expect(ALUMNI_HELP_TRANSITIONS.close.actor).toBe("either");
  });

  it("enforces the seven approved help-type/outcome combinations", () => {
    expect(isAlumniHelpOutcomeCodeForType("career_advice", "completed")).toBe(
      true,
    );
    expect(
      isAlumniHelpOutcomeCodeForType("career_advice", "interview_not_hired"),
    ).toBe(false);
    expect(
      isAlumniHelpOutcomeCodeForType(
        "formal_employee_referral",
        "hired_after_interview",
      ),
    ).toBe(true);
  });

  it("uses fixed 480 hours and approved month/day retention clocks", () => {
    const submittedAt = new Date("2026-03-01T12:00:00.000Z");
    expect(helpOutcomeDueAt(submittedAt).toISOString()).toBe(
      "2026-03-21T12:00:00.000Z",
    );
    expect(
      neverAcceptedHelpRequestPurgeAt(
        new Date("2026-01-31T12:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-03-31T12:00:00.000Z");

    const closedAt = new Date("2026-01-01T00:00:00.000Z");
    const lateDueAt = new Date("2027-01-15T00:00:00.000Z");
    expect(acceptedHelpRequestPurgeAt(closedAt).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(acceptedHelpRequestPurgeAt(closedAt, lateDueAt).toISOString()).toBe(
      "2027-02-14T00:00:00.000Z",
    );
  });
});
