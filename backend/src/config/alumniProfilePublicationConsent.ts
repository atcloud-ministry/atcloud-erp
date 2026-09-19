import { createHash } from "crypto";

export interface AlumniProfilePublicationConsentDocument {
  readonly version: string;
  readonly text: string;
  readonly effectiveAt: string;
  readonly documentHash: string;
}

function document(
  version: string,
  text: string,
  effectiveAt: string,
): AlumniProfilePublicationConsentDocument {
  return Object.freeze({
    version,
    text,
    effectiveAt,
    documentHash: createHash("sha256")
      .update(text.normalize("NFC"), "utf8")
      .digest("hex"),
  });
}

/**
 * Immutable publication-consent archive. Published records keep their version
 * and hash, so later copy changes never rewrite the evidence a member accepted.
 */
export const ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY = Object.freeze([
  document(
    "directory-v1",
    "I consent to make the alumni directory profile shown in the preview visible to active, verified @Cloud ERP members until I withdraw it.",
    "2026-09-12T00:00:00.000Z",
  ),
  document(
    "directory-v2",
    "I consent to @Cloud displaying the profile information I choose to publish—including my name, avatar, professional details, general location, verified program affiliations, skills, biography, and help offerings—to active, verified @Cloud ERP members in the Alumni Directory. While my profile remains published, later changes I save to these public profile fields will also be displayed. My email address, phone number, and exact birth year are not displayed. I can withdraw publication at any time; withdrawal immediately hides my profile and keeps it as a private draft, while @Cloud retains the consent record according to its Privacy & Data Use policy.",
    "2026-09-18T00:00:00.000Z",
  ),
] as const);

export const ALUMNI_PROFILE_PUBLICATION_CONSENT =
  ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY[
    ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY.length - 1
  ]!;

export const ALUMNI_PROFILE_PUBLICATION_CONSENT_VERSION =
  ALUMNI_PROFILE_PUBLICATION_CONSENT.version;
export const ALUMNI_PROFILE_PUBLICATION_CONSENT_TEXT =
  ALUMNI_PROFILE_PUBLICATION_CONSENT.text;
export const ALUMNI_PROFILE_PUBLICATION_CONSENT_DOCUMENT_HASH =
  ALUMNI_PROFILE_PUBLICATION_CONSENT.documentHash;

export function findAlumniProfilePublicationConsent(
  version: string,
): AlumniProfilePublicationConsentDocument | undefined {
  return ALUMNI_PROFILE_PUBLICATION_CONSENT_REGISTRY.find(
    (entry) => entry.version === version,
  );
}
