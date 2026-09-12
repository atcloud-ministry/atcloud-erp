import { createHash } from "crypto";

/**
 * Publication consent is server-owned so clients cannot choose the evidence
 * that is persisted. A copy change must also change the version.
 */
export const ALUMNI_PROFILE_PUBLICATION_CONSENT_VERSION =
  "directory-v1" as const;

export const ALUMNI_PROFILE_PUBLICATION_CONSENT_TEXT =
  "I consent to make the alumni directory profile shown in the preview visible to active, verified @Cloud ERP members until I withdraw it." as const;

export const ALUMNI_PROFILE_PUBLICATION_CONSENT_DOCUMENT_HASH = createHash(
  "sha256",
)
  .update(ALUMNI_PROFILE_PUBLICATION_CONSENT_TEXT.normalize("NFC"), "utf8")
  .digest("hex");

export const ALUMNI_PROFILE_PUBLICATION_CONSENT = Object.freeze({
  version: ALUMNI_PROFILE_PUBLICATION_CONSENT_VERSION,
  text: ALUMNI_PROFILE_PUBLICATION_CONSENT_TEXT,
  documentHash: ALUMNI_PROFILE_PUBLICATION_CONSENT_DOCUMENT_HASH,
});
